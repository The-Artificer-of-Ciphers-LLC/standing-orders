'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const { evaluateBlock, evaluateCoverage } = require('../lib/gate.cjs');
const { extractPathTokens } = require('../lib/phase.cjs');
const { SEED } = require('./helpers/fixtures.cjs');

const IDS = ['A-1', 'B-2', 'C-3', 'D-4'];
const idArb = fc.constantFrom(...IDS);

const conflictArb = fc
  .tuple(idArb, idArb)
  .filter(([a, b]) => a !== b)
  .map(([a, b]) => ({ kind: 'variant-outcome', orders: [a, b].sort(), message: `conflict between ${a} and ${b}` }));

const blockOnArb = fc.constantFrom('conflict', 'conflict_or_missing', 'never');

const sortedReasons = (reasons) => reasons.map((r) => `${r.code}:${r.message}`).sort();

describe('gate properties', () => {
  it('blockDecisionIsSymmetricInConflictOrder', () => {
    fc.assert(
      fc.property(fc.array(conflictArb, { maxLength: 6 }), fc.subarray(IDS), blockOnArb, fc.nat(6), (conflicts, applicableIds, blockOn, rotation) => {
        const k = conflicts.length === 0 ? 0 : rotation % conflicts.length;
        const rotated = [...conflicts.slice(k), ...conflicts.slice(0, k)];
        const reversed = [...conflicts].reverse();
        const base = evaluateBlock({ orders: { state: 'ok', errors: [], conflicts, missingChecks: [] }, applicableIds, blockOn });
        for (const variantOrder of [rotated, reversed]) {
          const other = evaluateBlock({ orders: { state: 'ok', errors: [], conflicts: variantOrder, missingChecks: [] }, applicableIds, blockOn });
          assert.equal(other.status, base.status);
          assert.deepEqual(sortedReasons(other.reasons), sortedReasons(base.reasons));
          assert.equal(other.blockingConflicts.length, base.blockingConflicts.length);
          assert.equal(other.unrelatedConflicts.length, base.unrelatedConflicts.length);
        }
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  it('coverageNeverRegressesWhenAPlanIsAdded', () => {
    const citedArb = fc.subarray(IDS);
    const planOf = (cited, n) => ({ file: `0${n}-PLAN.md`, ok: true, files_modified: [], requirements: [], must_haves: { truths: cited.map((id) => `${id} holds`) } });
    fc.assert(
      fc.property(fc.subarray(IDS, { minLength: 1 }), fc.array(citedArb, { maxLength: 4 }), citedArb, (applicableIds, planCitations, extraCitations) => {
        const base = planCitations.map((c, i) => planOf(c, i));
        const before = evaluateCoverage({ applicableIds, ordersTotal: 4, plans: base });
        const after = evaluateCoverage({ applicableIds, ordersTotal: 4, plans: [...base, planOf(extraCitations, base.length)] });
        if (before.status === 'complete') assert.equal(after.status, 'complete');
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  it('coverageProbeIsNotVacuous', () => {
    const plans = [{ file: '01-PLAN.md', ok: true, files_modified: [], requirements: [], must_haves: { truths: ['A-1 holds', 'B-2 holds'] } }];
    assert.equal(evaluateCoverage({ applicableIds: ['A-1', 'B-2'], ordersTotal: 2, plans }).status, 'complete');
    const more = [...plans, { file: '02-PLAN.md', ok: true, files_modified: [], requirements: [], must_haves: { truths: ['C-3 holds'] } }];
    assert.equal(evaluateCoverage({ applicableIds: ['A-1', 'B-2'], ordersTotal: 2, plans: more }).status, 'complete');
    assert.equal(evaluateCoverage({ applicableIds: ['A-1', 'C-3'], ordersTotal: 2, plans }).status, 'incomplete');
  });

  it('extractedTokensNeverHaveWhitespaceOrAScheme', () => {
    const spanArb = fc.oneof(fc.string({ maxLength: 40 }), fc.stringMatching(/^[a-z/.:\\ -]{0,20}$/), fc.constantFrom('http://x/y', 'a b/c.js', 'a/b.js', 'src/a.js:12'));
    fc.assert(
      fc.property(fc.array(spanArb, { maxLength: 8 }), (spans) => {
        const md = spans.map((s) => '`' + s + '`').join(' ') + '\n';
        for (const token of extractPathTokens(md)) {
          assert.ok(!/\s/.test(token), JSON.stringify(token));
          assert.ok(!token.includes('://'), JSON.stringify(token));
        }
      }),
      { seed: SEED, numRuns: 200 },
    );
  });
});
