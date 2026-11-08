'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const { parseOrders, effectiveLeaves } = require('../lib/orders.cjs');
const { detectConflicts } = require('../lib/conflicts.cjs');
const { doc, variant } = require('./helpers/fixtures.cjs');

const SEED = 20261107;

const CTX = { a: {}, b: {}, c: {}, ab: { includes: ['a', 'b'] }, all: { includes: ['ab', 'c'] } };
const ctxChoice = fc.subarray(['a', 'b', 'c', 'ab', 'all'], { maxLength: 2 });

const variantArb = fc.record({
  operation: fc.constantFrom('op1', 'op2'),
  contexts: ctxChoice,
  outcome: fc.constantFrom('x', 'y'),
});

function documentOf(specs) {
  const orders = specs.map((s, i) => variant(`V${i}`, s.operation, s.contexts, s.outcome));
  const r = parseOrders(doc({ contexts: CTX, orders }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return r.document;
}

/** Brute-force oracle written independently of conflicts.cjs. */
function oracle(d) {
  const out = [];
  for (let i = 0; i < d.orders.length; i++) {
    for (let j = i + 1; j < d.orders.length; j++) {
      const p = d.orders[i];
      const q = d.orders[j];
      if (p.operation !== q.operation || p.outcome === q.outcome) continue;
      const lp = new Set(effectiveLeaves(p, d));
      const shared = effectiveLeaves(q, d).filter((l) => lp.has(l));
      if (shared.length > 0) out.push([p.id, q.id].sort().join('|'));
    }
  }
  return out.sort();
}

describe('conflicts — properties', () => {
  it('prop_conflictDetectionIsSymmetric', () => {
    fc.assert(
      fc.property(fc.array(variantArb, { maxLength: 6 }), fc.array(fc.nat(), { maxLength: 6 }), (specs, keys) => {
        const d = documentOf(specs);
        const shuffled = d.orders.map((o, i) => [keys[i] ?? 0, i, o]).sort((x, y) => x[0] - y[0] || x[1] - y[1]).map((t) => t[2]);
        assert.deepEqual(detectConflicts({ ...d, orders: shuffled }), detectConflicts(d));
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  it('prop_variantConflictMatchesOracle', () => {
    fc.assert(
      fc.property(fc.array(variantArb, { maxLength: 6 }), (specs) => {
        const d = documentOf(specs);
        const got = detectConflicts(d).conflicts.filter((c) => c.kind === 'variant-outcome').map((c) => c.orders.join('|')).sort();
        assert.deepEqual(got, oracle(d));
      }),
      { seed: SEED, numRuns: 300 },
    );
  });
});
