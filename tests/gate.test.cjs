'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { STATUS, evaluateBlock, evaluateCoverage, renderVerdict } = require('../lib/gate.cjs');

const REPL = String.fromCharCode(0xfffd);

/** Shaped like one `detectConflicts` conflict. */
const CONFLICT = {
  kind: 'variant-outcome',
  orders: ['REFUND-AMOUNT-A', 'REFUND-AMOUNT-B'],
  operation: 'refund.amount',
  contexts: ['contract-a'],
  message: 'variants REFUND-AMOUNT-A and REFUND-AMOUNT-B on refund.amount both apply in contract-a but require different outcomes ("full" vs "prorated")',
};

const okOrders = (extra = {}) => ({ state: 'ok', errors: [], conflicts: [], missingChecks: [], ...extra });

const plan = (file, truths) => ({ file, ok: true, files_modified: [], requirements: [], must_haves: { truths } });

describe('gate evaluateBlock', () => {
  it('statusValuesAreTheFixedSet', () => {
    assert.deepEqual(
      { ...STATUS },
      { CLEAR: 'clear', BLOCKED: 'blocked', COMPLETE: 'complete', INCOMPLETE: 'incomplete', PENDING: 'pending', ERROR: 'error' },
    );
  });

  // AC2: a variant conflict among applicable orders blocks planning.
  it('blocksOnApplicableConflict', () => {
    const r = evaluateBlock({ orders: okOrders({ conflicts: [CONFLICT] }), applicableIds: ['REFUND-AMOUNT-A'], blockOn: 'conflict' });
    assert.equal(r.status, 'blocked');
    assert.deepEqual(r.reasons, [{ code: 'conflict', message: CONFLICT.message }]);
    assert.deepEqual(r.blockingConflicts, [CONFLICT]);
    assert.deepEqual(r.unrelatedConflicts, []);
    assert.deepEqual(r.blockingMissingChecks, []);
  });

  it('unrelatedConflictDoesNotBlock', () => {
    const r = evaluateBlock({ orders: okOrders({ conflicts: [CONFLICT] }), applicableIds: ['OTHER-1'], blockOn: 'conflict' });
    assert.equal(r.status, 'clear');
    assert.deepEqual(r.reasons, []);
    assert.deepEqual(r.blockingConflicts, []);
    assert.deepEqual(r.unrelatedConflicts, [CONFLICT]);
  });

  it('invalidOrdersBlock', () => {
    const errors = [
      { code: 'bad_kind', message: 'one' },
      { code: 'bad_field', message: 'two' },
    ];
    const r = evaluateBlock({ orders: { state: 'invalid', errors, conflicts: [], missingChecks: [] }, applicableIds: [], blockOn: 'conflict' });
    assert.equal(r.status, 'blocked');
    assert.deepEqual(r.reasons, [{ code: 'orders_invalid', message: '2 error(s) in ORDERS.yaml; run standing-orders validate' }]);
  });

  it('unreadableOrdersBlock', () => {
    const errors = [{ code: 'file_unreadable', message: 'ORDERS.yaml could not be read: boom' }];
    const r = evaluateBlock({ orders: { state: 'unreadable', errors, conflicts: [], missingChecks: [] }, applicableIds: [], blockOn: 'conflict_or_missing' });
    assert.equal(r.status, 'blocked');
    assert.deepEqual(r.reasons, [{ code: 'orders_unreadable', message: 'ORDERS.yaml could not be read: boom' }]);
  });

  it('missingOrdersFileIsEmpty', () => {
    const r = evaluateBlock({ orders: { state: 'missing', errors: [], conflicts: [], missingChecks: [] }, applicableIds: [], blockOn: 'conflict_or_missing' });
    assert.equal(r.status, 'clear');
    assert.deepEqual(r.reasons, []);
    assert.deepEqual(r.blockingConflicts, []);
    assert.deepEqual(r.unrelatedConflicts, []);
    assert.deepEqual(r.blockingMissingChecks, []);
  });

  it('missingCheckRespectsBlockOn', () => {
    const missing = { id: 'TEST-1', check_target: 'tests/x.test.cjs' };
    const orders = okOrders({ missingChecks: [missing] });
    const lenient = evaluateBlock({ orders, applicableIds: ['TEST-1'], blockOn: 'conflict' });
    assert.equal(lenient.status, 'clear');
    assert.deepEqual(lenient.reasons, []);
    assert.deepEqual(lenient.blockingMissingChecks, []);
    const strict = evaluateBlock({ orders, applicableIds: ['TEST-1'], blockOn: 'conflict_or_missing' });
    assert.equal(strict.status, 'blocked');
    assert.deepEqual(strict.reasons, [{ code: 'missing_check', message: 'check target tests/x.test.cjs for TEST-1 was not found' }]);
    assert.deepEqual(strict.blockingMissingChecks, [missing]);
  });

  it('missingCheckOnInapplicableOrder', () => {
    const orders = okOrders({ missingChecks: [{ id: 'TEST-1', check_target: 'tests/x.test.cjs' }] });
    const r = evaluateBlock({ orders, applicableIds: ['OTHER-1'], blockOn: 'conflict_or_missing' });
    assert.equal(r.status, 'clear');
    assert.deepEqual(r.reasons, []);
    assert.deepEqual(r.blockingMissingChecks, []);
  });

  it('reasonsComeInTheSpecifiedOrder', () => {
    const orders = okOrders({ conflicts: [CONFLICT], missingChecks: [{ id: 'REFUND-AMOUNT-A', check_target: 'tests/a.test.cjs' }] });
    const r = evaluateBlock({ orders, applicableIds: ['REFUND-AMOUNT-A'], blockOn: 'conflict_or_missing' });
    assert.deepEqual(
      r.reasons.map((x) => x.code),
      ['conflict', 'missing_check'],
    );
  });

  it('neverNeverBlocks', () => {
    const invalid = evaluateBlock({
      orders: { state: 'invalid', errors: [{ code: 'bad', message: 'm' }], conflicts: [], missingChecks: [] },
      applicableIds: [],
      blockOn: 'never',
    });
    assert.equal(invalid.status, 'clear');
    assert.deepEqual(invalid.reasons, []);
    const conflicted = evaluateBlock({
      orders: okOrders({ conflicts: [CONFLICT], missingChecks: [{ id: 'REFUND-AMOUNT-A', check_target: 't.cjs' }] }),
      applicableIds: ['REFUND-AMOUNT-A'],
      blockOn: 'never',
    });
    assert.equal(conflicted.status, 'clear');
    assert.deepEqual(conflicted.reasons, []);
    assert.deepEqual(conflicted.blockingConflicts, [CONFLICT]);
    assert.deepEqual(conflicted.blockingMissingChecks, []);
  });
});

describe('gate evaluateCoverage', () => {
  it('completeWhenAllCited', () => {
    const r = evaluateCoverage({ applicableIds: ['A-1', 'B-2'], ordersTotal: 2, plans: [plan('03-01-PLAN.md', ['A-1 holds']), plan('03-02-PLAN.md', ['B-2 holds'])] });
    assert.equal(r.status, 'complete');
    assert.deepEqual(r.reasons, []);
    assert.deepEqual(r.uncited, []);
    assert.deepEqual(r.unreadablePlans, []);
  });

  it('incompleteNamesUncited', () => {
    const r = evaluateCoverage({ applicableIds: ['A-1', 'B-2'], ordersTotal: 2, plans: [plan('03-01-PLAN.md', ['A-1 holds'])] });
    assert.equal(r.status, 'incomplete');
    assert.deepEqual(r.uncited, ['B-2']);
    assert.deepEqual(r.reasons, [{ code: 'uncited', message: 'B-2 is applicable but no plan cites it in must_haves' }]);
  });

  it('zeroApplicableIsComplete', () => {
    assert.equal(evaluateCoverage({ applicableIds: [], ordersTotal: 0, plans: [] }).status, 'complete');
    assert.equal(evaluateCoverage({ applicableIds: [], ordersTotal: 3, plans: [] }).status, 'complete');
    const none = evaluateCoverage({ applicableIds: ['A-1'], ordersTotal: 0, plans: [] });
    assert.equal(none.status, 'complete');
    assert.deepEqual(none.reasons, []);
  });

  it('noPlansIsIncomplete', () => {
    const r = evaluateCoverage({ applicableIds: ['A-1'], ordersTotal: 1, plans: [] });
    assert.equal(r.status, 'incomplete');
    assert.deepEqual(r.reasons, [{ code: 'no_plans', message: '1 applicable order(s) but the phase has no plans' }]);
    assert.deepEqual(r.uncited, []);
  });

  it('unreadablePlanBlocks', () => {
    const bad = { file: '03-02-PLAN.md', ok: false, files_modified: [], requirements: [], must_haves: undefined, error: 'no frontmatter' };
    const r = evaluateCoverage({ applicableIds: ['A-1'], ordersTotal: 1, plans: [plan('03-01-PLAN.md', ['A-1 holds']), bad] });
    assert.equal(r.status, 'incomplete');
    assert.deepEqual(r.reasons, [{ code: 'plan_unreadable', message: '03-02-PLAN.md: no frontmatter' }]);
    assert.deepEqual(r.unreadablePlans, ['03-02-PLAN.md']);
    assert.deepEqual(r.uncited, []);
  });

  it('citationInUnreadablePlanDoesNotCount', () => {
    const bad = { file: '03-02-PLAN.md', ok: false, files_modified: [], requirements: [], must_haves: { truths: ['A-1 holds'] }, error: 'x' };
    const r = evaluateCoverage({ applicableIds: ['A-1'], ordersTotal: 1, plans: [bad] });
    assert.equal(r.status, 'incomplete');
    assert.deepEqual(r.uncited, ['A-1']);
  });
});

describe('gate renderVerdict', () => {
  it('rendersVerdictFrontmatter', () => {
    const text = renderVerdict({
      phase: '03-billing',
      conflicts: 'blocked',
      coverage: 'pending',
      generatedBy: 'select',
      applicableIds: ['A-1', 'B-2'],
      reasons: [{ code: 'conflict', message: 'x and y differ' }],
    });
    const expected = [
      '---',
      'schema: "1"',
      'phase: "03-billing"',
      'conflicts: blocked',
      'coverage: pending',
      'generated_by: select',
      'applicable: "A-1, B-2"',
      '---',
      '',
      '# Standing Orders verdict — 03-billing',
      '',
      'Machine-written by `standing-orders select`. Gates read the `conflicts` and `coverage` fields.',
      '',
      '- conflict: x and y differ',
      '',
    ].join('\n');
    assert.equal(text, expected);
  });

  it('rendersNoFindingsLine', () => {
    const text = renderVerdict({ phase: '03-billing', conflicts: 'clear', coverage: 'complete', generatedBy: 'coverage', applicableIds: [], reasons: [] });
    assert.ok(text.endsWith('\n\n- no blocking findings\n'), JSON.stringify(text));
    assert.ok(text.includes('\napplicable: ""\n'));
  });

  it('verdictReasonsAreOneLine', () => {
    const text = renderVerdict({
      phase: 'a\nb',
      conflicts: 'blocked',
      coverage: 'pending',
      generatedBy: 'select',
      applicableIds: ['A-1'],
      reasons: [{ code: 'conflict', message: 'line1\nline2' + String.fromCharCode(7) + 'end' }],
    });
    const lines = text.split('\n');
    assert.ok(lines.includes('phase: "a b"'), JSON.stringify(lines));
    assert.ok(lines.includes('- conflict: line1 line2' + REPL + 'end'), JSON.stringify(lines));
    assert.ok(!lines.includes('line2' + REPL + 'end'));
    assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'));
  });
});

describe('gate robustness', () => {
  it('gateIgnoresMalformedEntries', () => {
    const block = evaluateBlock({
      orders: { state: 'ok', errors: [], conflicts: [null, 'x', 7, CONFLICT], missingChecks: [null, 'y', { id: 'A-1', check_target: 'src/a.js' }] },
      applicableIds: ['REFUND-AMOUNT-A', 'A-1'],
      blockOn: 'conflict_or_missing',
    });
    assert.equal(block.status, 'blocked');
    assert.deepEqual(block.blockingConflicts, [CONFLICT]);
    assert.deepEqual(block.blockingMissingChecks, [{ id: 'A-1', check_target: 'src/a.js' }]);
    assert.deepEqual(block.reasons.map((r) => r.code), ['conflict', 'missing_check']);

    const noIds = evaluateBlock({ orders: okOrders({ conflicts: [CONFLICT] }), applicableIds: 'REFUND-AMOUNT-A', blockOn: 'conflict' });
    assert.equal(noIds.status, 'clear');
    assert.deepEqual(noIds.unrelatedConflicts, [CONFLICT]);

    const cov = evaluateCoverage({ applicableIds: ['A-1'], ordersTotal: 1, plans: [null, 'p', 3, plan('01-PLAN.md', ['A-1'])] });
    assert.equal(cov.status, 'complete');
    assert.deepEqual(cov.uncited, []);
    assert.deepEqual(cov.unreadablePlans, []);

    const onlyJunk = evaluateCoverage({ applicableIds: ['A-1'], ordersTotal: 1, plans: [null, 'p'] });
    assert.equal(onlyJunk.status, 'incomplete');
    assert.deepEqual(onlyJunk.reasons.map((r) => r.code), ['no_plans']);

    const badIds = evaluateCoverage({ applicableIds: 'A-1', ordersTotal: 1, plans: [plan('01-PLAN.md', [])] });
    assert.equal(badIds.status, 'complete');
  });
});
