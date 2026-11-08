'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const { parseOrders } = require('../lib/orders.cjs');
const { doc, SEED } = require('./helpers/fixtures.cjs');

const ctxName = fc.stringMatching(/^[a-z][a-z0-9-]{0,6}$/);

/**
 * Arbitrary acyclic context graph: names are generated in order and every
 * `includes` edge points to an EARLIER name, so no cycle can form.
 */
const acyclicContexts = fc
  .uniqueArray(ctxName, { minLength: 1, maxLength: 8 })
  .chain((names) =>
    fc.tuple(
      fc.constant(names),
      fc.array(fc.array(fc.nat({ max: 7 }), { maxLength: 3 }), { minLength: names.length, maxLength: names.length }),
    ),
  )
  .map(([names, edgeLists]) => {
    const contexts = {};
    names.forEach((name, i) => {
      const includes = [...new Set(edgeLists[i].filter((j) => j < i).map((j) => names[j]))];
      contexts[name] = includes.length > 0 ? { includes } : {};
    });
    return contexts;
  });

describe('parseOrders — properties', () => {
  it('prop_contextResolutionIsIdempotentAndClosed', () => {
    fc.assert(
      fc.property(acyclicContexts, (contexts) => {
        const text = doc({ contexts });
        const once = parseOrders(text);
        const twice = parseOrders(text);
        assert.equal(once.ok, true, JSON.stringify(once.errors));
        assert.deepEqual(twice, once);
        const { leafSets, allLeaves } = once.document;
        const leafSet = new Set(allLeaves);
        for (const name of Object.keys(contexts)) {
          const leaves = leafSets[name];
          assert.ok(leaves.length >= 1, `${name} resolves to a non-empty set`);
          assert.deepEqual(leaves, [...leaves].sort(), 'sorted');
          for (const l of leaves) assert.ok(leafSet.has(l), `${l} is a leaf`);
          // Idempotence of resolution: resolving the resolved set again changes nothing,
          // because every member is a leaf whose own leaf set is itself.
          const again = [...new Set(leaves.flatMap((l) => leafSets[l]))].sort();
          assert.deepEqual(again, leaves, `${name}: resolve(resolve(x)) == resolve(x)`);
          for (const l of leaves) assert.deepEqual(leafSets[l], [l], `leaf ${l} resolves to itself`);
          const hasChildren = (contexts[name].includes || []).length > 0 ||
            Object.values(contexts).some((c) => c.extends === name);
          if (!hasChildren) assert.deepEqual(leaves, [name]);
        }
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  it('prop_parseOrdersNeverThrows', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.string({ unit: 'grapheme' }), fc.string({ unit: 'binary' })), (text) => {
        const r = parseOrders(text);
        assert.equal(typeof r.ok, 'boolean');
        assert.ok(Array.isArray(r.errors));
        assert.ok(Array.isArray(r.warnings));
        if (!r.ok) assert.ok(r.errors.length > 0);
      }),
      { seed: SEED, numRuns: 300 },
    );
  });
});
