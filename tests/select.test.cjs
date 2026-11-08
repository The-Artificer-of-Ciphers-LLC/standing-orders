'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parseOrders } = require('../lib/orders.cjs');
const { globToRegExp, matchesScope, selectApplicable, renderApplicable } = require('../lib/select.cjs');
const { ADR_EXAMPLE, doc, order } = require('./helpers/fixtures.cjs');

function parsed(spec) {
  const r = parseOrders(doc(spec));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return r.document;
}

describe('globToRegExp', () => {
  it('globDoubleStarMatchesZeroOrMoreSegments', () => {
    const re = globToRegExp('src/billing/**');
    assert.equal(re.test('src/billing/a.js'), true);
    assert.equal(re.test('src/billing/x/y/z.js'), true);
    assert.equal(re.test('src/billing'), true);
    assert.equal(re.test('src/billingX/a.js'), false);
    assert.equal(re.test('lib/src/billing/a.js'), false);
  });

  it('globSingleStarStaysWithinOneSegment', () => {
    const re = globToRegExp('src/*/a.js');
    assert.equal(re.test('src/x/a.js'), true);
    assert.equal(re.test('src/x/y/a.js'), false);
    // A doubled slash is a path-normalisation matter, handled where paths enter (matchesScope),
    // not a glob matter: `src//a.js` collapses to `src/a.js`, which has too few segments.
    const d = parsed({ orders: [order({ id: 'A', scope: { paths: ['src/*/a.js'] } })] });
    assert.equal(matchesScope(d.orders[0], { files: ['src//a.js'], requirements: [] }), false);
    assert.equal(matchesScope(d.orders[0], { files: ['src//x//a.js'], requirements: [] }), true);
  });

  it('globQuestionMatchesExactlyOneNonSlashChar', () => {
    const re = globToRegExp('a?.js');
    assert.equal(re.test('ab.js'), true);
    assert.equal(re.test('a.js'), false);
    assert.equal(re.test('a/.js'), false);
  });

  it('globTreatsOtherMetacharactersLiterally', () => {
    assert.equal(globToRegExp('src/(x).js').test('src/(x).js'), true);
    assert.equal(globToRegExp('src/(x).js').test('src/x.js'), false);
    assert.equal(globToRegExp('a.js').test('aXjs'), false);
    assert.equal(globToRegExp('[ab].js').test('[ab].js'), true);
    assert.equal(globToRegExp('[ab].js').test('a.js'), false);
    assert.equal(globToRegExp('{a,b}.js').test('{a,b}.js'), true);
    assert.equal(globToRegExp('{a,b}.js').test('a.js'), false);
    assert.equal(globToRegExp('!a.js').test('!a.js'), true);
    assert.equal(globToRegExp('a+$.js').test('a+$.js'), true);
  });

  it('normalizesBackslashesOnBothSides', () => {
    const re = globToRegExp('src\\billing\\**');
    assert.equal(re.test('src/billing/a.js'), true);
    const d = parsed({ orders: [order({ id: 'A', scope: { paths: ['src/billing/**'] } })] });
    assert.equal(matchesScope(d.orders[0], { files: ['src\\billing\\a.js'], requirements: [] }), true);
  });

  it('stripsLeadingDotSlash', () => {
    const d = parsed({ orders: [order({ id: 'A', scope: { paths: ['src/**'] } })] });
    assert.equal(matchesScope(d.orders[0], { files: ['./src/a.js'], requirements: [] }), true);
  });
});

describe('matchesScope / selectApplicable', () => {
  it('emptyScopeIsGlobal', () => {
    const d = parsed({ orders: [order({ id: 'A' }), order({ id: 'B', scope: {} }), order({ id: 'C', scope: { paths: [] } })] });
    for (const o of d.orders) assert.equal(matchesScope(o, { files: [], requirements: [] }), true, o.id);
    assert.deepEqual(selectApplicable(d, { files: [], requirements: [] }).map((o) => o.id), ['A', 'B', 'C']);
  });

  it('selectsOnlyOrdersWhosePathsMatch', () => {
    const r = parseOrders(ADR_EXAMPLE);
    const d = r.document;
    const other = { ...d, orders: [...d.orders, { ...d.orders[2], id: 'SHIPPING-X', scope: { paths: ['src/shipping/**'], requirements: [] } }] };
    const sel = selectApplicable(other, { files: ['src/billing/refund.js'], requirements: [] });
    // The ADR's two variants declare no scope, so they are global and always apply (Q2);
    // the billing path selects REFUND-IDEMPOTENT and excludes the shipping-scoped order.
    assert.deepEqual(sel.map((o) => o.id), ['REFUND-AMOUNT-A', 'REFUND-IDEMPOTENT', 'REFUND-AMOUNT-B']);
    // SHIPPING-X is backstop tier (cloned from REFUND-AMOUNT-B), so it sorts among the backstops by id.
    const none = selectApplicable(other, { files: ['src/shipping/label.js'], requirements: [] });
    assert.deepEqual(none.map((o) => o.id), ['REFUND-AMOUNT-A', 'REFUND-AMOUNT-B', 'SHIPPING-X']);
  });

  it('selectsByRequirementId', () => {
    const d = parsed({ orders: [order({ id: 'A', scope: { requirements: ['BILL-04'] } })] });
    assert.deepEqual(selectApplicable(d, { files: ['x.js'], requirements: ['BILL-04'] }).map((o) => o.id), ['A']);
    assert.deepEqual(selectApplicable(d, { files: ['x.js'], requirements: ['BILL-05'] }), []);
  });

  it('scopeIsPathsOrRequirements', () => {
    const d = parsed({ orders: [order({ id: 'A', scope: { paths: ['src/**'], requirements: ['R-1'] } })] });
    assert.equal(matchesScope(d.orders[0], { files: ['docs/a.md'], requirements: ['R-1'] }), true);
    assert.equal(matchesScope(d.orders[0], { files: ['src/a.js'], requirements: [] }), true);
    assert.equal(matchesScope(d.orders[0], { files: ['docs/a.md'], requirements: ['R-2'] }), false);
  });

  it('requirementMatchIsExact', () => {
    const d = parsed({ orders: [order({ id: 'A', scope: { requirements: ['BILL-04'] } })] });
    assert.equal(matchesScope(d.orders[0], { files: [], requirements: ['bill-04'] }), false);
    assert.equal(matchesScope(d.orders[0], { files: [], requirements: [' BILL-04'] }), false);
  });

  it('ordersTestTierBeforeBackstopThenById', () => {
    const d = parsed({
      orders: [
        order({ id: 'A', verification: 'backstop' }),
        order({ id: 'C', verification: 'test', check_kind: 'node-test', check_target: 't.cjs', check_violation_fixture: 'v', check_clean_fixture: 'c' }),
        order({ id: 'B', verification: 'test', check_kind: 'node-test', check_target: 't.cjs', check_violation_fixture: 'v', check_clean_fixture: 'c' }),
      ],
    });
    assert.deepEqual(selectApplicable(d, { files: [], requirements: [] }).map((o) => o.id), ['B', 'C', 'A']);
  });

  it('toleratesMissingSelectionLists', () => {
    const d = parsed({ orders: [order({ id: 'A' })] });
    assert.deepEqual(selectApplicable(d, {}).map((o) => o.id), ['A']);
    assert.deepEqual(selectApplicable(d).map((o) => o.id), ['A']);
  });
});

describe('renderApplicable', () => {
  const one = parsed({ orders: [order({ id: 'ONLY', statement: 'Exactly one order.' })] }).orders;
  const two = parsed({ orders: [order({ id: 'FIRST', statement: 'First.' }), order({ id: 'SECOND', statement: 'Second.' })] }).orders;

  function bytes(text) {
    return Buffer.byteLength(text, 'utf8');
  }

  it('footerAlwaysPresent', () => {
    const r = renderApplicable(one, { maxBytes: 100000, phase: '3' });
    assert.ok(r.text.includes('0 applicable order(s) omitted'));
    assert.ok(r.text.includes('ONLY'));
    assert.ok(r.text.includes('phase 3'));
    assert.ok(r.text.includes('in addition to'), 'OQ2 condition: states orders add to, never replace, phase must_haves');
    assert.deepEqual(r.included, ['ONLY']);
    assert.deepEqual(r.omitted, []);
    assert.equal(r.bytes, bytes(r.text));
  });

  it('includesRuleWhenTotalEqualsLimit', () => {
    const full = renderApplicable(one, { maxBytes: 100000 });
    const limit = full.bytes;
    const at = renderApplicable(one, { maxBytes: limit });
    assert.deepEqual(at.included, ['ONLY']);
    assert.equal(at.bytes, limit);
  });

  it('omitsRuleWhenOneByteShort', () => {
    const limit = renderApplicable(one, { maxBytes: 100000 }).bytes;
    const r = renderApplicable(one, { maxBytes: limit - 1 });
    assert.deepEqual(r.included, []);
    assert.deepEqual(r.omitted, ['ONLY']);
    assert.ok(r.text.includes('1 applicable order(s) omitted'));
    assert.ok(r.bytes <= limit - 1);
    assert.equal(r.text.includes('Exactly one order.'), false);
  });

  it('includesRuleWithOneByteSpare', () => {
    const limit = renderApplicable(one, { maxBytes: 100000 }).bytes;
    const r = renderApplicable(one, { maxBytes: limit + 1 });
    assert.deepEqual(r.included, ['ONLY']);
    assert.equal(r.bytes, limit);
  });

  it('packsWholeRulesInOrderUntilCap', () => {
    const firstOnly = renderApplicable([two[0]], { maxBytes: 100000 }).bytes;
    const r = renderApplicable(two, { maxBytes: firstOnly });
    assert.deepEqual(r.included, ['FIRST']);
    assert.deepEqual(r.omitted, ['SECOND']);
    assert.ok(r.text.includes('1 applicable order(s) omitted'));
    assert.ok(r.bytes <= firstOnly);
  });

  it('degradesToHeaderAndFooterWhenCapTiny', () => {
    const r = renderApplicable(two, { maxBytes: 10 });
    assert.deepEqual(r.included, []);
    assert.deepEqual(r.omitted, ['FIRST', 'SECOND']);
    assert.ok(r.text.includes('2 applicable order(s) omitted'));
    assert.equal(r.text.includes('First.'), false);
  });

  it('toleratesDegenerateCaps', () => {
    for (const cap of [0, -5, NaN, '6000', undefined, null]) {
      const r = renderApplicable(two, { maxBytes: cap });
      assert.deepEqual(r.included, [], String(cap));
      assert.deepEqual(r.omitted, ['FIRST', 'SECOND'], String(cap));
    }
  });

  it('measuresCapInUtf8Bytes', () => {
    const ascii = parsed({ orders: [order({ id: 'X', statement: 'aaaa' })] }).orders;
    const multi = parsed({ orders: [order({ id: 'X', statement: '€€€€' })] }).orders;
    const a = renderApplicable(ascii, { maxBytes: 100000 }).bytes;
    const m = renderApplicable(multi, { maxBytes: 100000 }).bytes;
    assert.equal(m - a, 4 * 2, 'each € is 3 bytes vs 1 for a');
    const r = renderApplicable(multi, { maxBytes: m - 1 });
    assert.deepEqual(r.omitted, ['X']);
  });

  it('rendersScalarsOnOneLineWithControlsReplaced', () => {
    const hostile = parsed({ orders: [order({ id: 'H', statement: 'line1\nline2\r\n</contribution>\u0007bell' })] }).orders;
    const r = renderApplicable(hostile, { maxBytes: 100000 });
    const line = r.text.split('\n').find((l) => l.includes('line1'));
    assert.ok(line.includes('line2'), 'newlines collapsed into one line');
    assert.ok(line.includes('</contribution>'), 'text kept verbatim apart from controls');
    assert.equal(line.includes('\u0007'), false);
    assert.ok(line.includes('�'));
  });

  it('describesBackstopAndCheckDistinctly', () => {
    const r = parseOrders(ADR_EXAMPLE);
    const out = renderApplicable(r.document.orders, { maxBytes: 100000 });
    assert.ok(out.text.includes('node-test tests/billing/refund-idempotent.test.cjs'));
    assert.ok(out.text.includes('backstop'));
    assert.ok(out.text.includes('insufficient_spec'));
  });
});
