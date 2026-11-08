'use strict';

/**
 * lib/gate.cjs — decide whether a phase is blocked by Standing Orders findings
 * and whether its plans cover the applicable orders, and render the
 * machine-written verdict file gates read.
 *
 * Pure: no I/O, never throws for bad input.
 */

const { isCited, isProjected, projectionOf, protectedFiles, canonicalPath } = require('./phase.cjs');
const { oneLine } = require('./select.cjs');
const { isPlainObject, compareStrings, ELLIPSIS } = require('./util.cjs');

const STATUS = Object.freeze({
  CLEAR: 'clear',
  BLOCKED: 'blocked',
  COMPLETE: 'complete',
  INCOMPLETE: 'incomplete',
  PENDING: 'pending',
  ERROR: 'error',
  FLAGGED: 'flagged',
});

/**
 * Classify an orders load into block reasons.
 * @returns {{ status: string, reasons: object[], blockingConflicts: object[], unrelatedConflicts: object[], blockingMissingChecks: object[] }}
 */
function evaluateBlock({ orders, applicableIds, blockOn }) {
  const o = isPlainObject(orders) ? orders : {};
  const applicable = new Set(Array.isArray(applicableIds) ? applicableIds : []);
  const errors = Array.isArray(o.errors) ? o.errors : [];
  const conflicts = Array.isArray(o.conflicts) ? o.conflicts.filter(isPlainObject) : [];
  const missingChecks = Array.isArray(o.missingChecks) ? o.missingChecks.filter(isPlainObject) : [];

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

function notProjectedReason(order) {
  const { section, item } = projectionOf(order);
  const checkPart = order.verification === 'test' ? `, check_kind: ${item.check_kind}, check_target: ${item.check_target}` : '';
  return {
    code: 'not_projected',
    message: `${order.id} is cited but not projected; add a must_haves.${section} item {statement: "${order.id}: ${ELLIPSIS}", verification: ${item.verification}${checkPart}} to a plan`,
  };
}

/** Applicable orders that are cited but not projected into any readable plan. */
function findNotProjected(applicable, uncited, okPlans) {
  const skip = new Set(uncited);
  const missing = [];
  const reasons = [];
  for (const order of applicable) {
    if (skip.has(order.id) || okPlans.some((p) => isProjected(order, p.must_haves))) continue;
    missing.push(order.id);
    reasons.push(notProjectedReason(order));
  }
  return { missing, reasons };
}

/** Plans that list a check file of an applicable `test` order in files_modified. */
function findCheckFileEdits(applicable, okPlans) {
  const edits = [];
  const reasons = [];
  for (const plan of okPlans) {
    const modified = new Set((Array.isArray(plan.files_modified) ? plan.files_modified : []).filter((f) => typeof f === 'string').map(canonicalPath));
    for (const order of applicable) {
      for (const file of protectedFiles(order)) {
        if (!modified.has(canonicalPath(file))) continue;
        edits.push({ plan: plan.file, file, id: order.id });
        reasons.push({ code: 'check_file_modified', message: `${plan.file} lists ${file}, a check file of ${order.id}, in files_modified; checks are fixed before the implementing phase` });
      }
    }
  }
  return { edits, reasons };
}

/**
 * Check that every applicable order is cited, and projected, in some readable
 * plan's must_haves, and that no plan lists a check file in files_modified.
 * @returns {{ status: string, uncited: string[], notProjected: string[], checkFileEdits: object[], unreadablePlans: string[], reasons: object[] }}
 */
function evaluateCoverage({ applicableIds, applicable, ordersTotal, plans }) {
  if (ordersTotal === 0) return { status: STATUS.COMPLETE, uncited: [], notProjected: [], checkFileEdits: [], unreadablePlans: [], reasons: [] };
  const ids = Array.isArray(applicableIds) ? applicableIds : [];
  const idSet = new Set(ids);
  const orders = (Array.isArray(applicable) ? applicable : []).filter((o) => isPlainObject(o) && idSet.has(o.id));
  const all = Array.isArray(plans) ? plans.filter(isPlainObject) : [];
  const okPlans = all.filter((p) => p.ok);
  const badPlans = all.filter((p) => !p.ok);

  const reasons = [];
  for (const p of badPlans) reasons.push({ code: 'plan_unreadable', message: `${p.file}: ${p.error}` });
  if (ids.length > 0 && all.length === 0) {
    reasons.push({ code: 'no_plans', message: `${ids.length} applicable order(s) but the phase has no plans` });
  }

  const uncited = [];
  let notProjected = [];
  let checkFileEdits = [];
  if (all.length > 0) {
    for (const id of ids) {
      if (okPlans.some((p) => isCited(id, p.must_haves))) continue;
      uncited.push(id);
      reasons.push({ code: 'uncited', message: `${id} is applicable but no plan cites it in must_haves` });
    }
    const projection = findNotProjected(orders, uncited, okPlans);
    notProjected = projection.missing;
    reasons.push(...projection.reasons);
    const edits = findCheckFileEdits(orders, okPlans);
    checkFileEdits = edits.edits;
    reasons.push(...edits.reasons);
  }

  return {
    status: reasons.length === 0 ? STATUS.COMPLETE : STATUS.INCOMPLETE,
    uncited: uncited.sort(compareStrings),
    notProjected: notProjected.sort(compareStrings),
    checkFileEdits,
    unreadablePlans: badPlans.map((p) => p.file).sort(compareStrings),
    reasons,
  };
}

/**
 * Reduce per-order host results to one verdict. Fail-closed: an entry is green
 * only when `status` is exactly 'green' and `flagged` is exactly false.
 * @returns {{ status: string, flagged: string[], reasons: object[] }}
 */
function evaluateEnforcement({ results }) {
  const entries = Array.isArray(results) ? results.filter(isPlainObject) : [];
  const bad = entries.filter((r) => !(r.status === 'green' && r.flagged === false));
  bad.sort((a, b) => compareStrings(String(a.id), String(b.id)));
  const flagged = bad.map((r) => String(r.id));
  const reasons = bad.map((r) => ({
    code: 'enforcement_flagged',
    message: `${String(r.id)}: ${typeof r.reason === 'string' && r.reason !== '' ? r.reason : 'no reason given'}`,
  }));
  return { status: flagged.length === 0 ? STATUS.CLEAR : STATUS.FLAGGED, flagged, reasons };
}

function renderVerdict({ phase, conflicts, coverage, enforcement, generatedBy, applicableIds, reasons }) {
  const ids = Array.isArray(applicableIds) ? applicableIds : [];
  const list = Array.isArray(reasons) ? reasons.filter(isPlainObject) : [];
  const lines = list.length === 0 ? ['- no blocking findings'] : list.map((r) => `- ${oneLine(r.code)}: ${oneLine(r.message)}`);
  return [
    '---',
    'schema: "1"',
    `phase: ${JSON.stringify(oneLine(phase))}`,
    `conflicts: ${oneLine(conflicts)}`,
    `coverage: ${oneLine(coverage)}`,
    `enforcement: ${oneLine(enforcement === undefined ? STATUS.PENDING : enforcement)}`,
    `generated_by: ${oneLine(generatedBy)}`,
    `applicable: ${JSON.stringify(oneLine(ids.join(', ')))}`,
    '---',
    '',
    `# Standing Orders verdict — ${oneLine(phase)}`,
    '',
    `Machine-written by \`standing-orders ${oneLine(generatedBy)}\`. Gates read the \`conflicts\`, \`coverage\` and \`enforcement\` fields.`,
    '',
    ...lines,
  ].join('\n') + '\n';
}

module.exports = { STATUS, evaluateBlock, evaluateCoverage, evaluateEnforcement, renderVerdict };
