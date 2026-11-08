'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parseOrders } = require('../lib/orders.cjs');
const { globToRegExp, matchesScope, selectApplicable, renderApplicable } = require('../lib/select.cjs');
const { ADR_EXAMPLE, order, parsed } = require('./helpers/fixtures.cjs');

describe('globToRegExp', () => {
  it('handlesPathologicalGlobsWithoutBacktracking', () => {
    // Each of these made the earlier RegExp compiler take seconds to minutes (adversarial review).
    const deep = globToRegExp('**/'.repeat(10) + 'a');
    assert.equal(deep.test('x/'.repeat(30) + 'b'), false);
    assert.equal(deep.test('x/'.repeat(30) + 'a'), true);
    const stars = globToRegExp('*a'.repeat(11) + '*b');
    assert.equal(stars.test('a'.repeat(40)), false);
    assert.equal(stars.test('a'.repeat(40) + 'b'), true);
    const mixed = globToRegExp('**a'.repeat(10) + '**b');
    assert.equal(mixed.test('a'.repeat(30)), false);
  });

  it('stripsRepeatedDotSlash', () => {
    assert.equal(globToRegExp('a.js').test('./././a.js'), true);
  });

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
    const d = parsed({ orders: [order({ id: 'A' }), order({ id: 'B', scope: {} }), order({ id: 'C', scope: { paths: [] } }), order({ id: 'S', scope: { paths: ['src/**'] } })] });
    for (const o of d.orders.slice(0, 3)) assert.equal(matchesScope(o, { files: [], requirements: [] }), true, o.id);
    // With nothing to match against, only the global orders apply; the scoped one is excluded (design row 46).
    assert.deepEqual(selectApplicable(d, { files: [], requirements: [] }).map((o) => o.id), ['A', 'B', 'C']);
  });

  it('toleratesDegenerateInputs', () => {
    const d = parsed({ orders: [order({ id: 'A', scope: { paths: ['null'] } })] });
    assert.equal(matchesScope(d.orders[0], null), false);
    assert.equal(matchesScope(d.orders[0], { files: [null, 'null'] }), true, 'a real path named null matches; the null entry is ignored');
    assert.equal(matchesScope(d.orders[0], { files: [null] }), false);
    assert.deepEqual(selectApplicable({}, {}), []);
    assert.deepEqual(selectApplicable(undefined), []);
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
    assert.deepEqual(renderApplicable(two, { maxBytes: Infinity }).included, ['FIRST', 'SECOND'], 'Infinity means no cap');
  });

  it('collapsesUnicodeLineSeparatorsToo', () => {
    const [LS, PS, NEL] = [0x2028, 0x2029, 0x85].map((c) => String.fromCharCode(c));
    const d = parsed({ orders: [order({ id: 'U', statement: `a${LS}## FAKE${NEL}b${PS}c` })] });
    const r = renderApplicable(d.orders, { maxBytes: 100000 });
    const statementLine = r.text.split('\n').find((l) => l.startsWith('- Statement:'));
    assert.ok(statementLine.includes('## FAKE'), 'text kept');
    for (const ch of [LS, PS, NEL]) assert.equal(r.text.includes(ch), false, 'no Unicode line separators survive');
    assert.equal(r.text.split('\n').filter((l) => l.startsWith('## ')).length, 1, 'exactly one real section heading');
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

describe('renderApplicable projection line', () => {
  const { projectionOf } = require('../lib/phase.cjs');
  const { testOrder } = require('./helpers/fixtures.cjs');
  const PREFIX = '- Project as: ';

  const blocks = parsed({
    orders: [
      testOrder({ id: 'T-1', statement: 'Never double refund.', check_target: 'tests/x.test.cjs' }),
      testOrder({ id: 'L-1', statement: 'No eval.', check_kind: 'lint-rule', check_target: 'src/a.js', check_rule: 'local/no-eval' }),
      order({ id: 'B-1', statement: 'Be fair.' }),
    ],
  }).orders;

  it('applicableHasProjectionLine', () => {
    const out = renderApplicable(blocks, { maxBytes: 100000 });
    const lines = out.text.split('\n');
    assert.deepEqual(out.included.slice().sort(), ['B-1', 'L-1', 'T-1']);
    for (const o of blocks) {
      const { section, item } = projectionOf(o);
      const at = lines.findIndex((l) => l.startsWith(PREFIX) && l.includes(`${o.id}: `));
      assert.ok(at > 0, `a Project as line for ${o.id}`);
      const line = lines[at];
      assert.ok(line.startsWith(`${PREFIX}must_haves.${section} item {`), line);
      assert.deepEqual(JSON.parse(line.slice(`${PREFIX}must_haves.${section} item `.length)), item, `the line carries exactly the projected item for ${o.id}`);
      assert.ok(lines[at - 1].startsWith('- Check:'), `Project as follows Check for ${o.id}: ${lines[at - 1]}`);
    }
    assert.ok(lines.includes('- Project as: must_haves.truths item {"statement":"B-1: Be fair.","verification":"backstop"}'));
    assert.equal(lines.filter((l) => l.startsWith(PREFIX)).length, 3, 'exactly one line per order');
  });

  it('projectionLineStaysOnOneLine', () => {
    const [LS, PS, NEL] = [0x2028, 0x2029, 0x85].map((c) => String.fromCharCode(c));
    const hostile = parsed({ orders: [order({ id: 'H-1', statement: `a${LS}## FAKE${NEL}b${PS}c\nd` })] }).orders;
    const out = renderApplicable(hostile, { maxBytes: 100000 });
    const lines = out.text.split('\n');
    const line = lines.find((l) => l.startsWith(PREFIX));
    assert.ok(line, 'projection line present');
    assert.ok(line.includes('## FAKE'), 'text kept');
    for (const ch of [LS, PS, NEL]) assert.equal(out.text.includes(ch), false);
    assert.equal(lines.filter((l) => l.startsWith('## ')).length, 1, 'no injected heading');
  });

  it('longerBlocksStillPackWhole', () => {
    const full = renderApplicable(blocks, { maxBytes: 100000 });
    const oneBlock = renderApplicable([blocks[0]], { maxBytes: 100000 });
    assert.ok(oneBlock.text.includes(PREFIX), 'the projection is part of the packed block');
    const r = renderApplicable(blocks, { maxBytes: oneBlock.bytes });
    assert.ok(r.included.length < full.included.length);
    assert.ok(r.bytes <= oneBlock.bytes);
    for (const id of r.included) assert.ok(r.text.includes(`${id}: `) || r.text.includes(id));
    const projectionLines = r.text.split('\n').filter((l) => l.startsWith(PREFIX)).length;
    assert.equal(projectionLines, r.included.length, 'a block is never cut between its Check and Project as lines');
  });
});
