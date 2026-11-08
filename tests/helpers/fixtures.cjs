'use strict';

/**
 * Test fixtures and builders for the phase-1 suites.
 *
 * YAML text is produced with js-yaml's `dump` (a different code path from the
 * `load` the parser under test uses), with `noRefs` so repeated objects never
 * become anchors by accident. Expected values in the tests are hand-written
 * literals taken from ADR-0001 §3, never recomputed through the parser.
 */

const { dump } = require('../../lib/vendor/js-yaml.cjs');

/** ADR-0001 §3 example, verbatim shape. */
const ADR_EXAMPLE = `version: 1
contexts:
  contract-a: { description: "Standard subscription contract" }
  contract-b: { description: "Annual prepaid contract" }
  any-contract: { includes: [contract-a, contract-b] }

orders:
  - id: REFUND-IDEMPOTENT
    kind: prohibition              # prohibition | invariant | variant
    statement: "A refund for one payment is never executed more than once."
    operation: refund.execute
    contexts: [any-contract]
    scope:
      paths: ["src/billing/**"]
      requirements: [BILL-04]
    verification: test             # test | backstop
    check_kind: node-test          # node-test | lint-rule
    check_target: tests/billing/refund-idempotent.test.cjs
    check_violation_fixture: tests/fixtures/billing/double-refund.js
    check_clean_fixture: tests/fixtures/billing/single-refund.js
    source: "Contract terms §4.2; phase 3 CONTEXT.md D-12"

  - id: REFUND-AMOUNT-A
    kind: variant
    operation: refund.amount
    contexts: [contract-a]
    outcome: full
    statement: "Refund equals the full paid amount."
    verification: test
    check_kind: node-test
    check_target: tests/billing/refund-amount.test.cjs

  - id: REFUND-AMOUNT-B
    kind: variant
    operation: refund.amount
    contexts: [contract-b]
    outcome: prorated
    statement: "Refund is prorated by unused days."
    verification: backstop
`;

/** Serialize a plain object to YAML with no anchors/aliases. */
function yamlOf(obj) {
  return dump(obj, { noRefs: true, lineWidth: -1 });
}

/**
 * Build a minimal valid order object; `overrides` win. Pass `null` for a key
 * to delete it (so tests can express "field absent").
 */
function order(overrides = {}) {
  const base = {
    id: 'ORDER-1',
    kind: 'invariant',
    statement: 'Something always holds.',
    verification: 'backstop',
  };
  const out = { ...base, ...overrides };
  for (const k of Object.keys(out)) if (out[k] === null) delete out[k];
  return out;
}

/** Build a minimal valid test-tier order with both fixtures. */
function testOrder(overrides = {}) {
  return order({
    id: 'TEST-1',
    kind: 'prohibition',
    verification: 'test',
    check_kind: 'node-test',
    check_target: 'tests/x.test.cjs',
    check_violation_fixture: 'tests/fixtures/bad.js',
    check_clean_fixture: 'tests/fixtures/good.js',
    ...overrides,
  });
}

/** Build a variant order. */
function variant(id, operation, contexts, outcome, overrides = {}) {
  return order({ id, kind: 'variant', operation, contexts, outcome, verification: 'backstop', ...overrides });
}

/** Build a whole document (as YAML text). `contexts` and `orders` may be omitted. */
function doc({ version = 1, contexts, orders, extra } = {}) {
  const d = { version };
  if (contexts !== undefined) d.contexts = contexts;
  if (orders !== undefined) d.orders = orders;
  if (extra) Object.assign(d, extra);
  return yamlOf(d);
}

/** Collect error/warning codes from a parse result. */
function codes(list) {
  return list.map((e) => e.code);
}

module.exports = { ADR_EXAMPLE, yamlOf, order, testOrder, variant, doc, codes };
