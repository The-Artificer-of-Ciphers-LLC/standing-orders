'use strict';

/**
 * lib/conflicts.cjs — deterministic conflict and missing-check detection
 * (PRD-0001 R6, R7; ADR-0001 §5 "deterministic first").
 *
 * Pure given the optional `exists` dependency. The result is independent of
 * the order in which orders appear: ids inside a conflict are sorted, and the
 * conflict list itself is sorted, so two agents reading the same ORDERS.yaml
 * always see the same report.
 *
 * Conflict kinds:
 *   variant-outcome         two variants on one operation whose effective leaf
 *                           contexts intersect and whose outcomes differ
 *   prohibition-vs-variant  a prohibition and a variant on one operation whose
 *                           effective leaf contexts intersect
 *   duplicate-id            one id used by more than one order (parseOrders
 *                           already refuses this; guarded again for hand-built
 *                           documents)
 */

const { effectiveLeaves } = require('./orders.cjs');

/** One spelling per operation: NFC, trimmed, lower case (`R.Amt ` and `r.amt` name the same operation). */
function operationKey(operation) {
  return String(operation).normalize('NFC').trim().toLowerCase();
}

function intersect(a, b) {
  const set = new Set(a);
  return b.filter((x) => set.has(x));
}

/** Code-point string order (locale-independent, so two machines sort alike). */
function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareConflicts(x, y) {
  return compareStrings(x.kind, y.kind) || compareStrings(x.orders.join('\u0000'), y.orders.join('\u0000'));
}

/**
 * @param {object} document  a parsed document (see orders.cjs)
 * @param {{ exists?: (path: string) => boolean }} [deps]
 * @returns {{ conflicts: object[], missingChecks: { id: string, check_target: string }[] }}
 */
function detectConflicts(document, deps) {
  const io = deps && typeof deps === 'object' ? deps : {};
  const orders = (document && Array.isArray(document.orders)) ? document.orders : [];
  const conflicts = [];

  // duplicate ids
  const counts = new Map();
  for (const o of orders) counts.set(o.id, (counts.get(o.id) || 0) + 1);
  for (const [id, n] of counts) {
    if (n > 1) conflicts.push({ kind: 'duplicate-id', orders: [id], message: `order id ${JSON.stringify(id)} is defined ${n} times` });
  }

  // pairwise, same operation
  const leaves = new Map(orders.map((o) => [o, effectiveLeaves(o, document)]));
  for (let i = 0; i < orders.length; i++) {
    for (let j = i + 1; j < orders.length; j++) {
      // Name the pair in id order so every field of the conflict, the message
      // included, is independent of the order the file lists them in.
      const [p, q] = orders[i].id <= orders[j].id ? [orders[i], orders[j]] : [orders[j], orders[i]];
      if (p.operation === null || q.operation === null || operationKey(p.operation) !== operationKey(q.operation)) continue;
      const shared = intersect(leaves.get(p), leaves.get(q));
      if (shared.length === 0) continue;
      const ids = [p.id, q.id];
      if (p.kind === 'variant' && q.kind === 'variant') {
        if (p.outcome !== q.outcome) {
          conflicts.push({
            kind: 'variant-outcome',
            orders: ids,
            operation: p.operation,
            contexts: shared,
            message: `variants ${ids.join(' and ')} on ${p.operation} both apply in ${shared.join(', ')} but require different outcomes (${JSON.stringify(p.outcome)} vs ${JSON.stringify(q.outcome)})`,
          });
        }
      } else if ((p.kind === 'prohibition' && q.kind === 'variant') || (p.kind === 'variant' && q.kind === 'prohibition')) {
        conflicts.push({
          kind: 'prohibition-vs-variant',
          orders: ids,
          operation: p.operation,
          contexts: shared,
          message: `${ids.join(' and ')} both apply to ${p.operation} in ${shared.join(', ')}: one forbids the operation and the other specifies its outcome`,
        });
      }
    }
  }
  conflicts.sort(compareConflicts);

  // unlocatable test-tier checks
  const missingChecks = [];
  if (typeof io.exists === 'function') {
    for (const o of orders) {
      if (o.verification === 'test' && typeof o.check_target === 'string' && !io.exists(o.check_target)) {
        missingChecks.push({ id: o.id, check_target: o.check_target });
      }
    }
    missingChecks.sort((a, b) => compareStrings(a.id, b.id));
  }

  return { conflicts, missingChecks };
}

module.exports = { detectConflicts };
