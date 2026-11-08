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
      { CLEAR: 'clear', BLOCKED: 'blocked', COMPLETE: 'complete', INCOMPLETE: 'incomplete', PENDING: 'pending', ERROR: 'error', FLAGGED: 'flagged' },
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
      'enforcement: pending',
      'generated_by: select',
      'applicable: "A-1, B-2"',
      '---',
      '',
      '# Standing Orders verdict — 03-billing',
      '',
      'Machine-written by `standing-orders select`. Gates read the `conflicts`, `coverage` and `enforcement` fields.',
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

const { evaluateEnforcement } = require('../lib/gate.cjs');
const { projectionOf } = require('../lib/phase.cjs');
const { testOrder, order } = require('./helpers/fixtures.cjs');

const ELL = String.fromCharCode(0x2026);
const T1 = testOrder({ id: 'T-1', statement: 'Never double refund.', check_target: 'tests/x.test.cjs', check_violation_fixture: 'tests/fixtures/bad.js', check_clean_fixture: 'tests/fixtures/good.js' });
const B1 = order({ id: 'B-1', statement: 'Be fair.' });
// literal projections (what the planner is told to write), so this file loads before the API exists
const T1_ITEM = {
  statement: 'T-1: Never double refund.',
  status: 'resolved',
  verification: 'test',
  check_kind: 'node-test',
  check_target: 'tests/x.test.cjs',
  check_violation_fixture: 'tests/fixtures/bad.js',
  check_clean_fixture: 'tests/fixtures/good.js',
};
const B1_ITEM = { statement: 'B-1: Be fair.', verification: 'backstop' };

/** An ok plan with a must_haves object and files_modified. */
const mplan = (file, mustHaves, files = []) => ({ file, ok: true, files_modified: files, requirements: [], must_haves: mustHaves });
const codesOf = (r) => r.reasons.map((x) => x.code);

describe('gate evaluateCoverage check-file edit rule', () => {
  const cover = (plans, applicable = [T1], ids = applicable.map((o) => o.id)) => evaluateCoverage({ applicableIds: ids, applicable, ordersTotal: 1, plans });
  const NOT_EDITING = { prohibitions: [T1_ITEM] };

  // AC8: a plan that lists a node-test order's check_target in files_modified is rejected.
  it('coverageRejectsCheckTargetEdit', () => {
    const r = cover([mplan('03-01-PLAN.md', NOT_EDITING, ['src/a.js', 'tests/x.test.cjs'])]);
    assert.equal(r.status, 'incomplete');
    assert.deepEqual(r.checkFileEdits, [{ plan: '03-01-PLAN.md', file: 'tests/x.test.cjs', id: 'T-1' }]);
    assert.deepEqual(r.reasons, [
      { code: 'check_file_modified', message: '03-01-PLAN.md lists tests/x.test.cjs, a check file of T-1, in files_modified; checks are fixed before the implementing phase' },
    ]);
    assert.deepEqual(r.notProjected, []);
    assert.deepEqual(r.uncited, []);
  });

  it('coverageRejectsFixtureEdit', () => {
    const violation = cover([mplan('03-01-PLAN.md', NOT_EDITING, ['tests/fixtures/bad.js'])]);
    assert.equal(violation.status, 'incomplete');
    assert.deepEqual(violation.checkFileEdits, [{ plan: '03-01-PLAN.md', file: 'tests/fixtures/bad.js', id: 'T-1' }]);
    const clean = cover([mplan('03-01-PLAN.md', NOT_EDITING, ['tests/fixtures/good.js'])]);
    assert.equal(clean.status, 'incomplete');
    assert.deepEqual(clean.checkFileEdits, [{ plan: '03-01-PLAN.md', file: 'tests/fixtures/good.js', id: 'T-1' }]);
    // protected-file order within one plan follows protectedFiles(order); plans follow the given order
    const both = cover([
      mplan('03-01-PLAN.md', NOT_EDITING, ['tests/fixtures/good.js', 'tests/fixtures/bad.js']),
      mplan('03-02-PLAN.md', NOT_EDITING, ['tests/x.test.cjs']),
    ]);
    assert.deepEqual(both.checkFileEdits, [
      { plan: '03-01-PLAN.md', file: 'tests/fixtures/bad.js', id: 'T-1' },
      { plan: '03-01-PLAN.md', file: 'tests/fixtures/good.js', id: 'T-1' },
      { plan: '03-02-PLAN.md', file: 'tests/x.test.cjs', id: 'T-1' },
    ]);
    assert.deepEqual(codesOf(both), ['check_file_modified', 'check_file_modified', 'check_file_modified']);
  });

  it('coverageNormalizesTheOrdersPaths', () => {
    const spelled = testOrder({ id: 'T-1', check_target: './tests/x.test.cjs', check_violation_fixture: 'tests\\fixtures\\bad.js', check_clean_fixture: 'tests/fixtures/good.js' });
    const r = cover([mplan('03-01-PLAN.md', { prohibitions: [projectionOf(spelled).item] }, ['tests/x.test.cjs', 'tests/fixtures/bad.js'])], [spelled]);
    assert.deepEqual(r.checkFileEdits.map((e) => e.file), ['tests/x.test.cjs', 'tests/fixtures/bad.js']);
  });

  it('coverageAllowsLintTargetEdit', () => {
    const lint = testOrder({ id: 'L-1', statement: 'No eval.', check_kind: 'lint-rule', check_target: 'src/billing/refund.js', check_rule: 'local/no-eval' });
    const r = cover([mplan('03-01-PLAN.md', { prohibitions: [projectionOf(lint).item] }, ['src/billing/refund.js'])], [lint]);
    assert.equal(r.status, 'complete');
    assert.deepEqual(r.checkFileEdits, []);
    assert.deepEqual(r.reasons, []);
    const fixtureStillProtected = cover([mplan('03-01-PLAN.md', { prohibitions: [projectionOf(lint).item] }, ['tests/fixtures/bad.js'])], [lint]);
    assert.equal(fixtureStillProtected.status, 'incomplete');
  });

  it('coverageIgnoresInapplicableCheckFiles', () => {
    // T-1's files are listed, but only B-1 is applicable here
    const notApplicable = cover([mplan('03-01-PLAN.md', { truths: [B1_ITEM] }, ['tests/x.test.cjs', 'tests/fixtures/bad.js'])], [B1]);
    assert.equal(notApplicable.status, 'complete');
    assert.deepEqual(notApplicable.checkFileEdits, []);
    // a backstop order that happens to carry check_* fields protects nothing
    const backstop = order({ id: 'B-2', statement: 'S.', check_kind: 'node-test', check_target: 'tests/y.test.cjs', check_violation_fixture: 'tests/fixtures/y-bad.js', check_clean_fixture: 'tests/fixtures/y-good.js' });
    const r = cover([mplan('03-01-PLAN.md', { truths: [projectionOf(backstop).item] }, ['tests/y.test.cjs', 'tests/fixtures/y-bad.js'])], [backstop]);
    assert.equal(r.status, 'complete');
    assert.deepEqual(r.checkFileEdits, []);
    // the applicable order's id is in applicableIds but its object is not in `applicable`: nothing to protect
    const idOnly = evaluateCoverage({ applicableIds: ['T-1'], applicable: [], ordersTotal: 1, plans: [mplan('03-01-PLAN.md', { truths: ['T-1 holds'] }, ['tests/x.test.cjs'])] });
    assert.deepEqual(idOnly.checkFileEdits, []);
  });

  it('coverageExactFileMatchOnly', () => {
    for (const files of [['tests/x.test.cjs.bak'], ['tests/x.test.cjs/inner.js'], ['xtests/x.test.cjs'], ['tests/x.test.cj']]) {
      const r = cover([mplan('03-01-PLAN.md', NOT_EDITING, files)]);
      assert.equal(r.status, 'complete', files.join());
      assert.deepEqual(r.checkFileEdits, [], files.join());
    }
  });

  it('coverageReadingACheckFileIsNotEditing', () => {
    const plan = { ...mplan('03-01-PLAN.md', { ...NOT_EDITING, key_links: [{ from: 'tests/x.test.cjs', to: 'src/a.js' }], artifacts: [{ path: 'tests/x.test.cjs' }] }, ['src/a.js']), read_first: ['tests/x.test.cjs'] };
    const r = cover([plan]);
    assert.equal(r.status, 'complete');
    assert.deepEqual(r.checkFileEdits, []);
  });

  it('coverageIgnoresCheckFileEditsInUnreadablePlans', () => {
    const bad = { file: '03-02-PLAN.md', ok: false, files_modified: ['tests/x.test.cjs'], requirements: [], must_haves: undefined, error: 'no frontmatter' };
    const r = cover([mplan('03-01-PLAN.md', NOT_EDITING, ['src/a.js']), bad]);
    assert.deepEqual(r.checkFileEdits, []);
    assert.deepEqual(codesOf(r), ['plan_unreadable']);
  });
});

describe('gate evaluateCoverage projection rule', () => {
  const cover = (plans, applicable = [T1, B1]) => evaluateCoverage({ applicableIds: applicable.map((o) => o.id), applicable, ordersTotal: applicable.length, plans });

  it('coverageCompleteWhenProjected', () => {
    const r = cover([mplan('03-01-PLAN.md', { prohibitions: [T1_ITEM], truths: [B1_ITEM] })]);
    assert.equal(r.status, 'complete');
    assert.deepEqual(r.notProjected, []);
    assert.deepEqual(r.uncited, []);
    assert.deepEqual(r.checkFileEdits, []);
    assert.deepEqual(r.reasons, []);
  });

  it('coverageProjectionAcrossPlans', () => {
    const r = cover([mplan('03-01-PLAN.md', { prohibitions: [T1_ITEM] }), mplan('03-02-PLAN.md', { truths: [B1_ITEM] })]);
    assert.equal(r.status, 'complete');
    assert.deepEqual(r.notProjected, []);
  });

  it('coverageCitedNotProjected', () => {
    const r = cover([mplan('03-01-PLAN.md', { truths: ['T-1 holds', 'B-1 holds'] })]);
    assert.equal(r.status, 'incomplete');
    assert.deepEqual(r.uncited, []);
    assert.deepEqual(r.notProjected, ['B-1', 'T-1']);
    assert.deepEqual(
      r.reasons.slice().sort((a, b) => a.message.localeCompare(b.message)),
      [
        { code: 'not_projected', message: `B-1 is cited but not projected; add a must_haves.truths item {statement: "B-1: ${ELL}", verification: backstop} to a plan` },
        {
          code: 'not_projected',
          message: `T-1 is cited but not projected; add a must_haves.prohibitions item {statement: "T-1: ${ELL}", verification: test, check_kind: node-test, check_target: tests/x.test.cjs} to a plan`,
        },
      ],
    );
    // right section, wrong content, is still not a projection
    const judgment = cover([mplan('03-01-PLAN.md', { prohibitions: [{ ...T1_ITEM, verification: 'judgment' }], truths: [{ statement: 'B-1: Be fair.', verification: 'judgment' }] })]);
    assert.deepEqual(judgment.notProjected, ['B-1', 'T-1']);
  });

  it('coverageUncitedNotDoubleReported', () => {
    const r = cover([mplan('03-01-PLAN.md', { truths: ['something unrelated'] })]);
    assert.equal(r.status, 'incomplete');
    assert.deepEqual(r.uncited, ['B-1', 'T-1']);
    assert.deepEqual(r.notProjected, []);
    assert.deepEqual(new Set(codesOf(r)), new Set(['uncited']));
  });

  it('coverageProjectionInUnreadablePlan', () => {
    const bad = { file: '03-02-PLAN.md', ok: false, files_modified: [], requirements: [], must_haves: { prohibitions: [T1_ITEM] }, error: 'x' };
    const r = cover([mplan('03-01-PLAN.md', { truths: ['T-1 holds'] }), bad], [T1]);
    assert.equal(r.status, 'incomplete');
    assert.deepEqual(r.notProjected, ['T-1']);
    assert.deepEqual(r.unreadablePlans, ['03-02-PLAN.md']);
    assert.deepEqual(codesOf(r).sort(), ['not_projected', 'plan_unreadable']);
  });

  it('coverageDefaults', () => {
    const none = evaluateCoverage({ applicableIds: ['T-1'], applicable: [T1], ordersTotal: 0, plans: [] });
    assert.equal(none.status, 'complete');
    for (const key of ['uncited', 'notProjected', 'checkFileEdits', 'unreadablePlans', 'reasons']) assert.deepEqual(none[key], [], key);
    const noOrders = evaluateCoverage({ applicableIds: ['T-1'], applicable: [T1], ordersTotal: 0, plans: [mplan('03-01-PLAN.md', { truths: [] }, ['tests/x.test.cjs'])] });
    assert.equal(noOrders.status, 'complete', 'ordersTotal 0 short-circuits every rule');
    assert.deepEqual(noOrders.checkFileEdits, []);

    // `applicable` absent or malformed: ids are still checked, objects are not
    for (const applicable of [undefined, null, 'T-1', 7, {}]) {
      const cited = evaluateCoverage({ applicableIds: ['T-1'], applicable, ordersTotal: 1, plans: [mplan('03-01-PLAN.md', { truths: ['T-1 holds'] })] });
      assert.equal(cited.status, 'complete', String(applicable));
      assert.deepEqual(cited.notProjected, []);
      const uncited = evaluateCoverage({ applicableIds: ['T-1'], applicable, ordersTotal: 1, plans: [mplan('03-01-PLAN.md', { truths: ['other'] })] });
      assert.deepEqual(uncited.uncited, ['T-1'], String(applicable));
    }
    // no plans: only no_plans is reported, never a projection reason
    const noPlans = evaluateCoverage({ applicableIds: ['T-1'], applicable: [T1], ordersTotal: 1, plans: [] });
    assert.deepEqual(codesOf(noPlans), ['no_plans']);
    assert.deepEqual(noPlans.notProjected, []);
    assert.deepEqual(noPlans.checkFileEdits, []);
    // junk entries in `applicable` are ignored
    const junk = evaluateCoverage({ applicableIds: ['T-1'], applicable: [null, 'x', 3, T1], ordersTotal: 1, plans: [mplan('03-01-PLAN.md', { prohibitions: [T1_ITEM] })] });
    assert.equal(junk.status, 'complete');
  });
});

describe('gate evaluateCoverage canonical check-file spellings', () => {
  const T = testOrder({ id: 'T-9', statement: 'S.', check_target: 'tests/a.test.cjs', check_violation_fixture: null, check_clean_fixture: null });
  const item = { statement: 'T-9: S.', status: 'resolved', verification: 'test', check_kind: 'node-test', check_target: 'tests/a.test.cjs' };
  const cover = (files) => evaluateCoverage({ applicableIds: ['T-9'], applicable: [T], ordersTotal: 1, plans: [mplan('03-01-PLAN.md', { prohibitions: [item] }, files)] });

  it('coverageCatchesCheckFileSpellings', () => {
    for (const s of ['tests/./a.test.cjs', 'tests/x/../a.test.cjs', 'Tests/a.test.cjs', 'tests/a.test.cjs/', ' tests/a.test.cjs']) {
      const r = cover([s]);
      assert.deepEqual(codesOf(r), ['check_file_modified'], s);
      assert.equal(r.checkFileEdits[0].file, 'tests/a.test.cjs', s);
    }
    assert.deepEqual(codesOf(cover(['tests/a.test.cjs.bak'])), []);
  });
});

describe('gate evaluateEnforcement', () => {
  const green = (id) => ({ id, status: 'green', flagged: false, reason: 'ok' });

  it('enforcementClear', () => {
    const r = evaluateEnforcement({ results: [green('A-1'), green('B-2')] });
    assert.deepEqual(r, { status: 'clear', flagged: [], reasons: [] });
  });

  it('enforcementFailClosed', () => {
    const r = evaluateEnforcement({
      results: [
        green('A-1'),
        { id: 'Z-9', status: 'green', flagged: true, reason: 'contradictory' },
        { id: 'C-3', status: 'unverified', flagged: false, reason: 'not green' },
        { id: 'D-4' },
        { id: 'E-5', status: 'unverified', flagged: true, reason: '' },
        { id: 'F-6', status: 'green', flagged: 'false', reason: 'string flag' },
        { id: 'G-7', status: 'GREEN', flagged: false, reason: 'wrong case' },
        null,
        'x',
        7,
        [],
        undefined,
      ],
    });
    assert.equal(r.status, 'flagged');
    assert.deepEqual(r.flagged, ['C-3', 'D-4', 'E-5', 'F-6', 'G-7', 'Z-9']);
    assert.deepEqual(r.reasons.map((x) => x.code), new Array(6).fill('enforcement_flagged'));
    assert.deepEqual(
      r.reasons.map((x) => x.message).sort(),
      ['C-3: not green', 'D-4: no reason given', 'E-5: no reason given', 'F-6: string flag', 'G-7: wrong case', 'Z-9: contradictory'],
    );
  });

  it('enforcementEmptyClear', () => {
    assert.deepEqual(evaluateEnforcement({ results: [] }), { status: 'clear', flagged: [], reasons: [] });
    for (const results of [undefined, null, 'x', 7, {}]) {
      const r = evaluateEnforcement({ results });
      assert.equal(r.status, 'clear', String(results));
      assert.deepEqual(r.flagged, []);
    }
    assert.equal(evaluateEnforcement({ results: [null, 'x', 4] }).status, 'clear', 'non-object entries are ignored');
  });
});

describe('gate renderVerdict enforcement', () => {
  const base = { phase: '03-billing', conflicts: 'clear', coverage: 'complete', generatedBy: 'enforce', applicableIds: [], reasons: [] };

  it('verdictHasEnforcement', () => {
    for (const enforcement of ['clear', 'flagged', 'pending', 'error']) {
      const lines = renderVerdict({ ...base, enforcement }).split('\n');
      const at = lines.indexOf('coverage: complete');
      assert.ok(at > 0, lines.join('|'));
      assert.equal(lines[at + 1], `enforcement: ${enforcement}`);
      assert.equal(lines[at + 2], 'generated_by: enforce');
    }
    const lines = renderVerdict(base).split('\n');
    assert.equal(lines[lines.indexOf('coverage: complete') + 1], 'enforcement: pending', 'undefined enforcement renders as pending');
    assert.ok(lines.includes('Machine-written by `standing-orders enforce`. Gates read the `conflicts`, `coverage` and `enforcement` fields.'));
  });

  it('statusIncludesFlagged', () => {
    assert.equal(STATUS.FLAGGED, 'flagged');
  });
});
