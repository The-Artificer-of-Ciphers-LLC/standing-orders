'use strict';

// Phase 7 (#15), matrix rows 3, 7, 9 (pure level) and 10: which files_modified entries cover a protected check file.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const { evaluateCoverage } = require('../lib/gate.cjs');
const { projectionOf } = require('../lib/phase.cjs');
const { testOrder, SEED } = require('./helpers/fixtures.cjs');

const T = testOrder({ id: 'T-1', statement: 'Never double refund.', check_target: 'tests/x.test.cjs', check_violation_fixture: 'tests/fixtures/bad.js', check_clean_fixture: 'tests/fixtures/good.js' });

const cover = (files, extra = {}) =>
  evaluateCoverage({
    applicableIds: ['T-1'],
    applicable: [T],
    ordersTotal: 1,
    plans: [{ file: '03-01-PLAN.md', ok: true, files_modified: files, requirements: [], must_haves: { prohibitions: [projectionOf(T).item] } }],
    ...extra,
  });

describe('gate evaluateCoverage glob entries', () => {
  // matrix row 3
  it('coverageCatchesGlobEntries', () => {
    for (const glob of ['tests/**', 'tests/*.cjs', '**/*.test.cjs', 'tests/{x,y}.test.cjs', 'tests/?.test.cjs', 'tests/fixtures/*.js', '**', 'Tests/**', 'tests\\**']) {
      const r = cover([glob]);
      assert.equal(r.status, 'incomplete', glob);
      assert.ok(r.checkFileEdits.length > 0 && r.checkFileEdits.every((e) => e.id === 'T-1'), glob);
      assert.ok(r.reasons.some((x) => x.code === 'check_file_modified'), glob);
    }
    const names = cover(['tests/fixtures/*.js']).checkFileEdits.map((e) => e.file).sort();
    assert.deepEqual(names, ['tests/fixtures/bad.js', 'tests/fixtures/good.js'], 'every protected file the glob covers is named');
  });

  // matrix row 7: negative space
  it('unrelatedGlobsStayComplete', () => {
    for (const entry of ['src/**', 'docs/', '**/*.md', 'src/*.js', 'tests/x.test.cjs.bak', 'tests/{a,b}.test.cjs', 'tests/??.test.cjs', 'lib/**/*.cjs']) {
      const r = cover([entry]);
      assert.equal(r.status, 'complete', entry);
      assert.deepEqual(r.checkFileEdits, [], entry);
    }
  });

  // matrix row 9 at the pure level: given the whole order set, the check files of a non-applicable test order protect too
  it('nonApplicableOrdersAreProtectedWhenTheWholeSetIsGiven', () => {
    const other = testOrder({ id: 'T-2', statement: 'Never B.', check_target: 'tests/other.test.cjs', check_violation_fixture: 'tests/fixtures/o-bad.js', check_clean_fixture: 'tests/fixtures/o-good.js' });
    const plans = [{ file: '03-01-PLAN.md', ok: true, files_modified: ['tests/other.test.cjs'], requirements: [], must_haves: { prohibitions: [projectionOf(T).item] } }];
    const withSet = evaluateCoverage({ applicableIds: ['T-1'], applicable: [T], allOrders: [T, other], ordersTotal: 2, plans });
    assert.equal(withSet.status, 'incomplete');
    assert.deepEqual(withSet.checkFileEdits.map((e) => [e.file, e.id]), [['tests/other.test.cjs', 'T-2']]);
    const without = evaluateCoverage({ applicableIds: ['T-1'], applicable: [T], ordersTotal: 2, plans });
    assert.equal(without.status, 'complete');
  });
});

// matrix row 10
describe('check file entry oracle', () => {
  const seg = fc.constantFrom('tests', 'src', 'lib', 'fixtures', 'a', 'b');
  const fileArb = fc.tuple(fc.array(seg, { minLength: 1, maxLength: 3 }), fc.constantFrom('x.js', 'y.cjs', 'z.test.cjs')).map(([dirs, name]) => [...dirs, name].join('/'));
  const entryArb = fc.oneof(
    { weight: 2, arbitrary: fileArb.map((f) => ({ entry: f, kind: 'exact' })) },
    { weight: 2, arbitrary: fc.array(seg, { minLength: 1, maxLength: 3 }).map((d) => ({ entry: d.join('/') + '/', kind: 'dir' })) },
    { weight: 2, arbitrary: fc.array(seg, { minLength: 1, maxLength: 2 }).map((d) => ({ entry: d.join('/') + '/**', kind: 'glob' })) },
    { weight: 1, arbitrary: fc.constantFrom('x.js', 'y.cjs', 'z.test.cjs').map((n) => ({ entry: '**/' + n, kind: 'glob' })) },
  );

  it('checkFileEditOracle', () => {
    fc.assert(
      fc.property(fileArb, fileArb, entryArb, (target, fixture, { entry, kind }) => {
        fc.pre(target !== fixture);
        const t = testOrder({ id: 'T-1', statement: 'S.', check_target: target, check_violation_fixture: fixture, check_clean_fixture: null });
        const plans = [{ file: '01-PLAN.md', ok: true, files_modified: [entry], requirements: [], must_haves: { prohibitions: [projectionOf(t).item] } }];
        const r = evaluateCoverage({ applicableIds: ['T-1'], applicable: [t], ordersTotal: 1, plans });
        const covers = (file) => {
          if (kind === 'exact') return file === entry;
          if (kind === 'dir') return file.startsWith(entry);
          if (entry.startsWith('**/')) return file === entry.slice(3) || file.endsWith('/' + entry.slice(3));
          return file.startsWith(entry.slice(0, -2));
        };
        const expected = [target, fixture].filter(covers).sort();
        assert.deepEqual(r.checkFileEdits.map((e) => e.file).sort(), expected, `${kind} ${entry}`);
        assert.equal(r.status === 'incomplete', expected.length > 0, `${kind} ${entry}`);
      }),
      { seed: SEED, numRuns: 300 },
    );
  });
});
