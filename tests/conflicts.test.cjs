'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parseOrders } = require('../lib/orders.cjs');
const { detectConflicts } = require('../lib/conflicts.cjs');
const { ADR_EXAMPLE, doc, order, variant, testOrder } = require('./helpers/fixtures.cjs');

const CTX = { a: {}, b: {}, all: { includes: ['a', 'b'] } };

function parsed(spec) {
  const r = parseOrders(doc(spec));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return r.document;
}

describe('detectConflicts', () => {
  it('adrExampleHasNoConflicts', () => {
    const r = parseOrders(ADR_EXAMPLE);
    const c = detectConflicts(r.document);
    assert.deepEqual(c.conflicts, []);
  });

  it('detectsVariantOutcomeConflict', () => {
    const d = parsed({ contexts: CTX, orders: [variant('X', 'refund.amount', ['all'], 'full'), variant('Y', 'refund.amount', ['a'], 'prorated')] });
    const c = detectConflicts(d);
    assert.equal(c.conflicts.length, 1);
    const k = c.conflicts[0];
    assert.equal(k.kind, 'variant-outcome');
    assert.deepEqual(k.orders, ['X', 'Y']);
    assert.equal(k.operation, 'refund.amount');
    assert.deepEqual(k.contexts, ['a']);
    assert.ok(k.message.includes('X') && k.message.includes('Y'));
  });

  it('agreeingVariantsDoNotConflict', () => {
    const d = parsed({ contexts: CTX, orders: [variant('X', 'op', ['all'], 'full'), variant('Y', 'op', ['a'], 'full')] });
    assert.deepEqual(detectConflicts(d).conflicts, []);
  });

  it('disjointVariantsDoNotConflict', () => {
    const d = parsed({ contexts: CTX, orders: [variant('X', 'op', ['a'], 'full'), variant('Y', 'op', ['b'], 'prorated')] });
    assert.deepEqual(detectConflicts(d).conflicts, []);
  });

  it('differentOperationsDoNotConflict', () => {
    const d = parsed({ contexts: CTX, orders: [variant('X', 'op1', ['a'], 'full'), variant('Y', 'op2', ['a'], 'prorated')] });
    assert.deepEqual(detectConflicts(d).conflicts, []);
  });

  it('allContextsOverlapsEveryLeaf', () => {
    const d = parsed({ contexts: CTX, orders: [variant('X', 'op', [], 'full'), variant('Y', 'op', ['b'], 'prorated')] });
    const c = detectConflicts(d).conflicts;
    assert.equal(c.length, 1);
    assert.deepEqual(c[0].contexts, ['b']);
  });

  it('detectsProhibitionVersusVariant', () => {
    const d = parsed({
      contexts: CTX,
      orders: [order({ id: 'P', kind: 'prohibition', operation: 'op', contexts: ['all'] }), variant('V', 'op', ['a'], 'full')],
    });
    const c = detectConflicts(d).conflicts;
    assert.equal(c.length, 1);
    assert.equal(c[0].kind, 'prohibition-vs-variant');
    assert.deepEqual(c[0].orders, ['P', 'V']);
    assert.deepEqual(c[0].contexts, ['a']);
  });

  it('prohibitionAndInvariantCoexist', () => {
    const d = parsed({
      contexts: CTX,
      orders: [order({ id: 'P', kind: 'prohibition', operation: 'op', contexts: ['all'] }), order({ id: 'I', kind: 'invariant', operation: 'op', contexts: ['a'] })],
    });
    assert.deepEqual(detectConflicts(d).conflicts, []);
  });

  it('ordersWithoutOperationNeverConflict', () => {
    const d = parsed({ contexts: CTX, orders: [order({ id: 'P', kind: 'prohibition' }), variant('V', 'op', ['a'], 'full')] });
    assert.deepEqual(detectConflicts(d).conflicts, []);
  });

  it('reportsDuplicateIdsAsConflicts', () => {
    // parseOrders refuses duplicates; detectConflicts still guards a hand-built document.
    const d = parsed({ orders: [order({ id: 'A' })] });
    const dup = { ...d, orders: [d.orders[0], { ...d.orders[0] }] };
    const c = detectConflicts(dup).conflicts;
    assert.equal(c.length, 1);
    assert.equal(c[0].kind, 'duplicate-id');
    assert.deepEqual(c[0].orders, ['A']);
  });

  it('reportsUnlocatableCheckTargets', () => {
    const d = parsed({ orders: [testOrder({ id: 'T', check_target: 'tests/missing.test.cjs' }), order({ id: 'B' })] });
    const asked = [];
    const c = detectConflicts(d, { exists: (p) => { asked.push(p); return false; } });
    assert.deepEqual(c.conflicts, []);
    assert.deepEqual(c.missingChecks, [{ id: 'T', check_target: 'tests/missing.test.cjs' }]);
    assert.deepEqual(asked, ['tests/missing.test.cjs'], 'backstop orders are not probed');
  });

  it('locatedCheckTargetsAreNotMissing', () => {
    const d = parsed({ orders: [testOrder({ id: 'T' })] });
    assert.deepEqual(detectConflicts(d, { exists: () => true }).missingChecks, []);
  });

  it('skipsCheckLocationWithoutExistsDep', () => {
    const d = parsed({ orders: [testOrder({ id: 'T' })] });
    assert.deepEqual(detectConflicts(d).missingChecks, []);
    assert.deepEqual(detectConflicts(d, {}).missingChecks, []);
  });

  it('conflictsAreOrderIndependent', () => {
    const d = parsed({
      contexts: CTX,
      orders: [variant('X', 'op', ['all'], 'full'), variant('Y', 'op', ['a'], 'prorated'), order({ id: 'P', kind: 'prohibition', operation: 'op', contexts: ['b'] })],
    });
    const fwd = detectConflicts(d);
    const rev = detectConflicts({ ...d, orders: [...d.orders].reverse() });
    assert.deepEqual(rev, fwd);
    // X{a,b} vs Y{a}: variant-outcome; X{a,b} vs P{b}: prohibition-vs-variant; Y{a} vs P{b}: disjoint.
    assert.equal(fwd.conflicts.length, 2);
    assert.deepEqual(fwd.conflicts.map((c) => c.kind).sort(), ['prohibition-vs-variant', 'variant-outcome']);
  });

  it('toleratesDocumentWithNoOrders', () => {
    assert.deepEqual(detectConflicts(parsed({})), { conflicts: [], missingChecks: [] });
  });
});
