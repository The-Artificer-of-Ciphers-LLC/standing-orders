'use strict';

/**
 * lib/gate.cjs — decide whether a phase is blocked by Standing Orders findings
 * and whether its plans cover the applicable orders, and render the
 * machine-written verdict file gates read.
 *
 * Pure: no I/O, never throws for bad input.
 */

const { isCited } = require('./phase.cjs');
const { oneLine } = require('./select.cjs');

const STATUS = Object.freeze({
  CLEAR: 'clear',
  BLOCKED: 'blocked',
  COMPLETE: 'complete',
  INCOMPLETE: 'incomplete',
  PENDING: 'pending',
  ERROR: 'error',
});

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Classify an orders load into block reasons.
 * @returns {{ status: string, reasons: object[], blockingConflicts: object[], unrelatedConflicts: object[], blockingMissingChecks: object[] }}
 */
function evaluateBlock({ orders, applicableIds, blockOn }) {
  const o = orders || {};
  const applicable = new Set(Array.isArray(applicableIds) ? applicableIds : []);
  const errors = Array.isArray(o.errors) ? o.errors : [];
  const conflicts = Array.isArray(o.conflicts) ? o.conflicts : [];
  const missingChecks = Array.isArray(o.missingChecks) ? o.missingChecks : [];

  const reasons = [];
  if (o.state === 'unreadable') {
    reasons.push({ code: 'orders_unreadable', message: errors[0] && errors[0].message ? errors[0].message : 'ORDERS.yaml could not be read' });
  } else if (o.state === 'invalid') {
    reasons.push({ code: 'orders_invalid', message: `${errors.length} error(s) in ORDERS.yaml; run standing-orders validate` });
  }

  const blockingConflicts = [];
  const unrelatedConflicts = [];
  for (const c of conflicts) {
    const involved = Array.isArray(c.orders) && c.orders.some((id) => applicable.has(id));
    if (involved) {
      blockingConflicts.push(c);
      reasons.push({ code: 'conflict', message: c.message });
    } else {
      unrelatedConflicts.push(c);
    }
  }

  const blockingMissingChecks = [];
  if (blockOn === 'conflict_or_missing') {
    for (const m of missingChecks) {
      if (!applicable.has(m.id)) continue;
      blockingMissingChecks.push(m);
      reasons.push({ code: 'missing_check', message: `check target ${m.check_target} for ${m.id} was not found` });
    }
  }

  if (blockOn === 'never') {
    return { status: STATUS.CLEAR, reasons: [], blockingConflicts, unrelatedConflicts, blockingMissingChecks };
  }
  return { status: reasons.length > 0 ? STATUS.BLOCKED : STATUS.CLEAR, reasons, blockingConflicts, unrelatedConflicts, blockingMissingChecks };
}

/**
 * Check that every applicable order is cited in some readable plan's must_haves.
 * @returns {{ status: string, uncited: string[], unreadablePlans: string[], reasons: object[] }}
 */
function evaluateCoverage({ applicableIds, ordersTotal, plans }) {
  if (ordersTotal === 0) return { status: STATUS.COMPLETE, uncited: [], unreadablePlans: [], reasons: [] };
  const ids = Array.isArray(applicableIds) ? applicableIds : [];
  const all = Array.isArray(plans) ? plans : [];
  const okPlans = all.filter((p) => p.ok);
  const badPlans = all.filter((p) => !p.ok);

  const reasons = [];
  for (const p of badPlans) reasons.push({ code: 'plan_unreadable', message: `${p.file}: ${p.error}` });
  if (ids.length > 0 && all.length === 0) {
    reasons.push({ code: 'no_plans', message: `${ids.length} applicable order(s) but the phase has no plans` });
  }

  const uncited = [];
  if (all.length > 0) {
    for (const id of ids) {
      if (okPlans.some((p) => isCited(id, p.must_haves))) continue;
      uncited.push(id);
      reasons.push({ code: 'uncited', message: `${id} is applicable but no plan cites it in must_haves` });
    }
  }

  return {
    status: reasons.length === 0 ? STATUS.COMPLETE : STATUS.INCOMPLETE,
    uncited: uncited.sort(compareStrings),
    unreadablePlans: badPlans.map((p) => p.file).sort(compareStrings),
    reasons,
  };
}

function renderVerdict({ phase, conflicts, coverage, generatedBy, applicableIds, reasons }) {
  const ids = Array.isArray(applicableIds) ? applicableIds : [];
  const list = Array.isArray(reasons) ? reasons : [];
  const lines = list.length === 0 ? ['- no blocking findings'] : list.map((r) => `- ${oneLine(r.code)}: ${oneLine(r.message)}`);
  return [
    '---',
    'schema: "1"',
    `phase: ${JSON.stringify(oneLine(phase))}`,
    `conflicts: ${oneLine(conflicts)}`,
    `coverage: ${oneLine(coverage)}`,
    `generated_by: ${oneLine(generatedBy)}`,
    `applicable: ${JSON.stringify(oneLine(ids.join(', ')))}`,
    '---',
    '',
    `# Standing Orders verdict — ${oneLine(phase)}`,
    '',
    `Machine-written by \`standing-orders ${oneLine(generatedBy)}\`. Gates read the \`conflicts\` and \`coverage\` fields.`,
    '',
    ...lines,
  ].join('\n') + '\n';
}

module.exports = { STATUS, evaluateBlock, evaluateCoverage, renderVerdict };
