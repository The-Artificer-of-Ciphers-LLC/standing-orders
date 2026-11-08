'use strict';

// Phase 5 (#6): lib/semantic.cjs, the pure half of the semantic-conflict ledger.
// Test names follow .gsd/phase/feat-6-promotion-llm-conflicts/50-test-matrix.md (rows 37-40, 42-50).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Resolved on first use, so while lib/semantic.cjs does not exist every test fails on its own.
const S = new Proxy({}, { get: (_, key) => require('../lib/semantic.cjs')[key] });

const TS = '2026-11-08T00:00:00.000Z';
const LATER = '2026-11-09T12:30:00.000Z';
const KNOWN = new Set(['A', 'B', 'C']);

const finding = (overrides = {}) => ({
  id: 'S-1',
  orders: ['A'],
  statement: 'A contradicts the spec.',
  status: 'unresolved',
  reason: null,
  proposed_by: 'agent',
  resolved_by: null,
  ts: TS,
  ...overrides,
});

const docOf = (...findings) => ({ schema: 1, phase: '.planning/phases/03-billing', findings });
const clone = (v) => JSON.parse(JSON.stringify(v));
const proposals = (n, prefix = 'finding') => Array.from({ length: n }, (_, i) => ({ orders: ['A'], statement: `${prefix} ${i}` }));
const propose = (document, list, extra = {}) => S.proposeFindings({ document, proposals: list, knownIds: KNOWN, auto: false, ts: TS, ...extra });

describe('semantic: finding validation', () => {
  it('dismissalNeedsReason', () => {
    const dismissed = (reason) => finding({ status: 'dismissed', reason, resolved_by: 'human' });
    assert.notDeepEqual(S.validateFinding(dismissed(''), 0), []);
    assert.notDeepEqual(S.validateFinding(dismissed('   '), 0), []);
    assert.notDeepEqual(S.validateFinding(dismissed(null), 0), []);
    assert.deepEqual(S.validateFinding(dismissed('x'), 0), []);
    // the reason is only mandatory for a dismissal
    assert.deepEqual(S.validateFinding(finding({ status: 'resolved', reason: null, resolved_by: 'human' }), 0), []);
    assert.deepEqual(S.validateFinding(finding(), 0), []);
  });

  it('validateFindingContract', () => {
    const bad = {
      'not an object': 'x',
      array: [],
      null: null,
      'unknown key': finding({ extra: 1 }),
      'id without S- prefix': finding({ id: 'X-1' }),
      'id zero': finding({ id: 'S-0' }),
      'id leading zero': finding({ id: 'S-01' }),
      'id too long': finding({ id: 'S-1234567' }),
      'orders empty': finding({ orders: [] }),
      'orders not a list': finding({ orders: 'A' }),
      'orders has blank': finding({ orders: ['A', ''] }),
      'statement empty': finding({ statement: '' }),
      'statement too long': finding({ statement: 'x'.repeat(1001) }),
      'statement not a string': finding({ statement: 5 }),
      'bad status': finding({ status: 'open' }),
      'reason too long': finding({ reason: 'x'.repeat(1001) }),
      'reason not a string': finding({ reason: 5 }),
      'proposed_by unknown': finding({ proposed_by: 'human' }),
      'resolved_by agent': finding({ resolved_by: 'agent' }),
      'ts not a string': finding({ ts: 5 }),
    };
    for (const [label, f] of Object.entries(bad)) {
      const problems = S.validateFinding(f, 3);
      assert.ok(Array.isArray(problems) && problems.length > 0, label);
      for (const p of problems) assert.equal(typeof p, 'string', label);
    }
    assert.deepEqual(S.validateFinding(finding({ id: 'S-999999', statement: 'x'.repeat(1000), proposed_by: 'auto' }), 0), []);
    assert.deepEqual(S.validateFinding(finding({ status: 'resolved', resolved_by: 'human', reason: 'a note' }), 0), []);
  });

  it('exportsTheContract', () => {
    assert.equal(S.SEMANTIC_FILE, 'STANDING-ORDERS-SEMANTIC.json');
    assert.equal(S.SEMANTIC_SCHEMA, 1);
    assert.deepEqual([...S.FINDING_STATUSES], ['unresolved', 'resolved', 'dismissed']);
    assert.equal(S.MAX_FINDINGS_PER_CALL, 50);
    assert.equal(S.MAX_TEXT_CHARS, 1000);
    assert.equal(S.MAX_SEMANTIC_BYTES, 4 * 1024 * 1024);
    assert.ok(S.FINDING_ID_RE.test('S-1') && S.FINDING_ID_RE.test('S-999999'));
    assert.ok(!S.FINDING_ID_RE.test('S-0') && !S.FINDING_ID_RE.test('S-1000000') && !S.FINDING_ID_RE.test('s-1'));
    assert.deepEqual({ ...S.SEMANTIC_CODES }, {
      REASON_REQUIRED: 'reason_required',
      AUTO_NEVER_DISMISSES: 'auto_never_dismisses',
      AUTO_CANNOT_CONFIRM: 'auto_cannot_confirm',
      FINDING_NOT_FOUND: 'finding_not_found',
      UNKNOWN_ORDER: 'unknown_order',
      TOO_MANY_FINDINGS: 'too_many_findings',
      INVALID_FINDING: 'invalid_finding',
      SEMANTIC_UNUSABLE: 'semantic_unusable',
    });
    assert.deepEqual(S.emptyDocument('.planning/phases/03-billing'), { schema: 1, phase: '.planning/phases/03-billing', findings: [] });
  });

  it('countFindingsAndSerialize', () => {
    const document = docOf(
      finding({ id: 'S-1' }),
      finding({ id: 'S-2', status: 'resolved', resolved_by: 'human' }),
      finding({ id: 'S-3', status: 'dismissed', reason: 'r', resolved_by: 'human' }),
      finding({ id: 'S-4', status: 'dismissed', reason: 'r', resolved_by: 'human' }),
    );
    assert.deepEqual(S.countFindings(document), { unresolved: 1, resolved: 1, dismissed: 2 });
    assert.deepEqual(S.countFindings(S.emptyDocument('p')), { unresolved: 0, resolved: 0, dismissed: 0 });
    const text = S.serializeSemantic(document);
    assert.equal(text, JSON.stringify(document, null, 2) + '\n');
    assert.deepEqual(JSON.parse(text), document);
    const back = S.parseSemantic(text);
    assert.equal(back.ok, true);
    assert.deepEqual(back.document, document);
  });
});

describe('semantic: parseSemantic', () => {
  it('parseSemanticRejectsShapes', () => {
    const base = docOf(finding());
    const hostile = {
      'not json': 'not json {',
      empty: '',
      zero: '0',
      string: '"s"',
      array: '[]',
      null: 'null',
      true: 'true',
      'schema 2': JSON.stringify({ ...base, schema: 2 }),
      'schema as text': JSON.stringify({ ...base, schema: '1' }),
      'missing phase': JSON.stringify({ schema: 1, findings: [] }),
      'phase not a string': JSON.stringify({ ...base, phase: 7 }),
      'findings missing': JSON.stringify({ schema: 1, phase: 'p' }),
      'findings not a list': JSON.stringify({ ...base, findings: {} }),
      'finding not an object': JSON.stringify({ ...base, findings: ['x'] }),
      'duplicate ids': JSON.stringify(docOf(finding(), finding({ statement: 'other' }))),
      'dismissed blank reason': JSON.stringify(docOf(finding({ status: 'dismissed', reason: '  ', resolved_by: 'human' }))),
      'dismissed no reason': JSON.stringify(docOf(finding({ status: 'dismissed', reason: null, resolved_by: 'human' }))),
      'bad status': JSON.stringify(docOf(finding({ status: 'maybe' }))),
      'unknown finding key': JSON.stringify(docOf(finding({ extra: true }))),
    };
    for (const [label, text] of Object.entries(hostile)) {
      const r = S.parseSemantic(text);
      assert.equal(r.ok, false, label);
      assert.equal(r.code, 'semantic_unusable', label);
      assert.equal(typeof r.message, 'string', label);
      assert.equal(r.document, undefined, label);
    }
    const ok = S.parseSemantic(JSON.stringify(base));
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.document, base);
    assert.equal(S.parseSemantic(JSON.stringify(docOf())).ok, true, 'no findings is valid');
  });
});

describe('semantic: proposing', () => {
  it('autoMayPropose', () => {
    const start = S.emptyDocument('p');
    const snapshot = clone(start);
    const r = propose(start, [{ orders: ['A', 'B'], statement: 'A and B disagree.' }], { auto: true, ts: LATER });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.added, ['S-1']);
    assert.deepEqual(r.duplicates, []);
    assert.deepEqual(start, snapshot, 'the input document is not mutated');
    assert.deepEqual(r.document.findings, [
      { id: 'S-1', orders: ['A', 'B'], statement: 'A and B disagree.', status: 'unresolved', reason: null, proposed_by: 'auto', resolved_by: null, ts: LATER },
    ]);
    const byAgent = propose(start, [{ orders: ['A'], statement: 'x' }]);
    assert.equal(byAgent.document.findings[0].proposed_by, 'agent');
    assert.equal(S.parseSemantic(S.serializeSemantic(r.document)).ok, true);
  });

  it('proposeRefusesUnknownOrder', () => {
    const start = docOf(finding());
    const snapshot = clone(start);
    const r = propose(start, [{ orders: ['A'], statement: 'fine' }, { orders: ['A', 'NOPE'], statement: 'names an unknown order' }]);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'unknown_order');
    assert.equal(r.document, undefined, 'the whole call is refused: nothing is added');
    assert.deepEqual(start, snapshot);
    assert.match(r.message, /NOPE/);
  });

  it('proposeCountBoundary', () => {
    for (const n of [1, 49, 50]) {
      const r = propose(S.emptyDocument('p'), proposals(n));
      assert.equal(r.ok, true, `n=${n}`);
      assert.equal(r.added.length, n, `n=${n}`);
    }
    const tooMany = propose(S.emptyDocument('p'), proposals(51));
    assert.equal(tooMany.ok, false);
    assert.equal(tooMany.code, 'too_many_findings');
    const none = propose(S.emptyDocument('p'), []);
    assert.equal(none.ok, false);
    assert.equal(none.code, 'invalid_finding');
    assert.equal(propose(S.emptyDocument('p'), 'x').ok, false);
    assert.equal(propose(S.emptyDocument('p'), null).ok, false);
  });

  it('proposeIsIdempotent', () => {
    const first = propose(S.emptyDocument('p'), [{ orders: ['A', 'B'], statement: 'x  y' }]);
    assert.equal(first.ok, true);
    const again = propose(first.document, [{ orders: ['B', 'A'], statement: ' x y ' }]);
    assert.equal(again.ok, true);
    assert.deepEqual(again.duplicates, [0]);
    assert.deepEqual(again.added, []);
    assert.deepEqual(again.document.findings, first.document.findings, 'ids and everything else unchanged');

    const withinCall = propose(S.emptyDocument('p'), [{ orders: ['A'], statement: 'same' }, { orders: ['B'], statement: 'same' }, { orders: ['A', 'A'], statement: 'same' }]);
    assert.deepEqual(withinCall.added, ['S-1', 'S-2']);
    assert.deepEqual(withinCall.duplicates, [2], 'repeated orders collapse, so the third equals the first');
    assert.deepEqual(withinCall.document.findings[0].orders, ['A']);

    const otherStatement = propose(first.document, [{ orders: ['A', 'B'], statement: 'different' }]);
    assert.deepEqual(otherStatement.added, ['S-2']);
    const otherOrders = propose(first.document, [{ orders: ['A'], statement: 'x y' }]);
    assert.deepEqual(otherOrders.added, ['S-2']);
  });

  it('proposeStatementLengthBoundary', () => {
    assert.equal(propose(S.emptyDocument('p'), [{ orders: ['A'], statement: 'x'.repeat(1000) }]).ok, true);
    const over = propose(S.emptyDocument('p'), [{ orders: ['A'], statement: 'x'.repeat(1001) }]);
    assert.equal(over.ok, false);
    assert.equal(over.code, 'invalid_finding');
    for (const bad of [{ orders: ['A'], statement: '' }, { orders: ['A'], statement: '   ' }, { orders: ['A'] }, { orders: [], statement: 'x' }, { orders: 'A', statement: 'x' }, { statement: 'x' }, { orders: ['A'], statement: 'x', status: 'resolved' }, 'x', null]) {
      const r = propose(S.emptyDocument('p'), [bad]);
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.equal(r.code, 'invalid_finding', JSON.stringify(bad));
    }
  });

  it('proposeIdsMonotonic', () => {
    const hole = docOf(finding({ id: 'S-1' }), finding({ id: 'S-3', statement: 'third' }));
    const r = propose(hole, [{ orders: ['A'], statement: 'new one' }, { orders: ['B'], statement: 'new two' }]);
    assert.deepEqual(r.added, ['S-4', 'S-5'], 'one past the highest id ever on file');
    const tailGone = docOf(finding({ id: 'S-1' }), finding({ id: 'S-2', statement: 'second' }));
    assert.deepEqual(propose(tailGone, [{ orders: ['A'], statement: 'new' }]).added, ['S-3']);
  });
});

describe('semantic: resolving', () => {
  const open = () => docOf(finding({ id: 'S-1' }), finding({ id: 'S-2', statement: 'second' }));
  const resolve = (args) => S.resolveFinding({ document: open(), id: 'S-1', auto: false, ts: LATER, ...args });

  it('dismissalNeedsReason (resolve)', () => {
    for (const reason of [undefined, null, '', '   ', '\t\n']) {
      const start = open();
      const snapshot = clone(start);
      const r = S.resolveFinding({ document: start, id: 'S-1', status: 'dismissed', reason, auto: false, ts: LATER });
      assert.equal(r.ok, false, JSON.stringify(reason));
      assert.equal(r.code, 'reason_required', JSON.stringify(reason));
      assert.equal(r.document, undefined);
      assert.deepEqual(start, snapshot, 'the document is unchanged');
    }
    const tooLong = resolve({ status: 'dismissed', reason: 'x'.repeat(1001) });
    assert.equal(tooLong.ok, false);
    assert.equal(tooLong.code, 'invalid_finding');
  });

  it('autoNeverDismisses', () => {
    const r = resolve({ status: 'dismissed', reason: 'looks fine to me', auto: true });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'auto_never_dismisses');
    assert.equal(r.document, undefined);
    // the auto refusal comes before the lookup and the reason check
    assert.equal(resolve({ id: 'S-99', status: 'dismissed', reason: 'r', auto: true }).code, 'auto_never_dismisses');
    assert.equal(resolve({ status: 'dismissed', auto: true }).code, 'auto_never_dismisses');
  });

  it('autoCannotConfirm', () => {
    for (const status of ['resolved', 'unresolved']) {
      const r = resolve({ status, auto: true });
      assert.equal(r.ok, false, status);
      assert.equal(r.code, 'auto_cannot_confirm', status);
      assert.equal(r.document, undefined, status);
    }
    const bad = resolve({ status: 'bogus', auto: true });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'usage', 'an invalid status is a usage error before the auto rules');
  });

  it('resolveLifecycle', () => {
    const start = open();
    const snapshot = clone(start);
    const confirmed = S.resolveFinding({ document: start, id: 'S-1', status: 'resolved', auto: false, ts: LATER });
    assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
    assert.deepEqual(start, snapshot, 'the input document is not mutated');
    assert.deepEqual(confirmed.finding, finding({ id: 'S-1', status: 'resolved', reason: null, resolved_by: 'human', ts: LATER }));
    assert.deepEqual(confirmed.document.findings[0], confirmed.finding);
    assert.deepEqual(confirmed.document.findings[1], start.findings[1], 'other findings are untouched');

    const noted = S.resolveFinding({ document: start, id: 'S-1', status: 'resolved', reason: '  fix ORDERS.yaml  ', auto: false, ts: LATER });
    assert.equal(noted.finding.reason, 'fix ORDERS.yaml', 'a note is trimmed');
    const blankNote = S.resolveFinding({ document: start, id: 'S-1', status: 'resolved', reason: '   ', auto: false, ts: LATER });
    assert.equal(blankNote.finding.reason, null, 'a blank note is no note');

    const dismissed = S.resolveFinding({ document: confirmed.document, id: 'S-1', status: 'dismissed', reason: ' not a conflict ', auto: false, ts: LATER });
    assert.equal(dismissed.ok, true);
    assert.equal(dismissed.finding.status, 'dismissed');
    assert.equal(dismissed.finding.reason, 'not a conflict');
    assert.equal(dismissed.finding.resolved_by, 'human');

    const deferred = S.resolveFinding({ document: dismissed.document, id: 'S-1', status: 'unresolved', reason: 'ignored', auto: false, ts: '2026-11-10T00:00:00.000Z' });
    assert.equal(deferred.ok, true);
    assert.equal(deferred.finding.status, 'unresolved');
    assert.equal(deferred.finding.reason, null);
    assert.equal(deferred.finding.resolved_by, null);
    assert.equal(deferred.finding.ts, '2026-11-10T00:00:00.000Z');
    assert.equal(S.parseSemantic(S.serializeSemantic(deferred.document)).ok, true);
    assert.deepEqual(S.countFindings(deferred.document), { unresolved: 2, resolved: 0, dismissed: 0 });
  });

  it('resolveUnknownId', () => {
    const start = open();
    for (const id of ['S-99', 'X', '', undefined]) {
      const r = S.resolveFinding({ document: start, id, status: 'resolved', auto: false, ts: LATER });
      assert.equal(r.ok, false, String(id));
      assert.equal(r.code, 'finding_not_found', String(id));
    }
    // the lookup comes before the reason check
    assert.equal(S.resolveFinding({ document: start, id: 'S-99', status: 'dismissed', auto: false, ts: LATER }).code, 'finding_not_found');
    const badStatus = S.resolveFinding({ document: start, id: 'S-1', status: 'bogus', auto: false, ts: LATER });
    assert.equal(badStatus.code, 'usage');
  });
});
