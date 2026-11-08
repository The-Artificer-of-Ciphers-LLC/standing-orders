'use strict';

/**
 * lib/gate.cjs — decide whether a phase is blocked by Standing Orders findings
 * and whether its plans cover the applicable orders, and render the
 * machine-written verdict file gates read.
 *
 * Pure: no I/O, never throws for bad input.
 */

const path = require('node:path');
const { isCited, isProjected, projectionOf, protectedSet, canonicalPath, normalizeToken } = require('./phase.cjs');
const { oneLine, globToRegExp } = require('./select.cjs');
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

const MAX_BRACE_ALTERNATIVES = 64;
/** More brace groups than this (or a longer glob) is not expanded: the entry then covers every protected file. */
const MAX_BRACE_GROUPS = 8;
const MAX_GLOB_CHARS = 1024;
const GLOB_CHARS_RE = /[*?{[]/;
const BRACKET_CLASS_RE = /\[[^\]]*\]/g;
const MATCH_ALL = Object.freeze({ test: () => true });
const DRIVE_PATH_RE = /^[A-Za-z]:/;

/** Expand `{a,b}` groups; null when the expansion would exceed the bound (the caller then over-matches). */
function expandBraces(glob) {
  // bound the work before any recursion: the number of groups is the recursion depth
  if (glob.length > MAX_GLOB_CHARS || glob.split('{').length - 1 > MAX_BRACE_GROUPS) return null;
  const open = glob.indexOf('{');
  if (open === -1) return [glob];
  let depth = 0;
  let close = -1;
  const commas = [];
  for (let i = open; i < glob.length && close === -1; i++) {
    const c = glob[i];
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) close = i;
    else if (c === ',' && depth === 1) commas.push(i);
  }
  if (close === -1) return [glob];
  const pre = glob.slice(0, open);
  const post = glob.slice(close + 1);
  const bounds = [open, ...commas, close];
  const out = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const rest = expandBraces(pre + glob.slice(bounds[i] + 1, bounds[i + 1]) + post);
    if (rest === null) return null;
    out.push(...rest);
    if (out.length > MAX_BRACE_ALTERNATIVES) return null;
  }
  return out;
}

/**
 * Matchers for one glob entry (lower case, like canonicalPath). A glob too branchy to expand matches everything (the
 * safe direction); a bracket class is a wildcard that may over-match, never a literal.
 */
function globMatchers(glob) {
  const expanded = expandBraces(glob);
  if (expanded === null) return [MATCH_ALL];
  return expanded.map((p) => globToRegExp(p.replace(BRACKET_CLASS_RE, '?')));
}

/**
 * The entry as a root-relative path (separators `/`, no leading `./`), or null when it cannot name a file of the
 * project: an absolute path outside the root, or a drive path. Absolute paths inside the root are made relative.
 */
function rootRelative(entry, root) {
  const raw = String(entry).trim();
  const e = normalizeToken(raw);
  // `./` and `.//` name the root itself
  if (e === '' && /^(?:\.[/\\]*)+$/.test(raw)) return '.';
  if (e === '' || DRIVE_PATH_RE.test(e)) return null;
  if (!e.startsWith('/')) return e;
  if (typeof root !== 'string' || root === '') return null;
  const r = normalizeToken(root).replace(/\/+$/, '').toLowerCase();
  const n = path.posix.normalize(e).toLowerCase();
  if (n === r || n === r + '/') return '.';
  if (!n.startsWith(r + '/')) return null;
  return path.posix.normalize(e).slice(r.length + 1);
}

/** One protected file with the spellings it can be reached by: its canonical path and, when it exists, its real path. */
function protectedKeys(item, probe) {
  const keys = [canonicalPath(item.file)];
  const real = probe && typeof probe.real === 'function' ? safeProbe(() => probe.real(item.file)) : null;
  const realKey = typeof real === 'string' && real !== '' ? canonicalPath(real) : '';
  if (realKey !== '' && !keys.includes(realKey)) keys.push(realKey);
  return keys;
}

function safeProbe(fn) {
  try {
    return fn();
  } catch (e) {
    return null;
  }
}

/** Does `entry` (one files_modified item) cover the protected file whose spellings are `keys`? */
function entryCovers(entry, keys, { root, probe }) {
  const rel = rootRelative(entry, root);
  if (rel === null) return false;
  if (GLOB_CHARS_RE.test(rel)) {
    // a trailing slash names the directory (`tests/**/` is `tests/**`)
    const lower = rel.toLowerCase().replace(/\/+$/, '');
    const matchers = globMatchers(lower);
    // a glob also covers a file by matching a directory that holds it (`tests/f*` names `tests/fixtures`)
    return keys.some((k) => {
      const parts = k.split('/');
      const candidates = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
      return matchers.some((m) => candidates.some((c) => m.test(c)));
    });
  }
  const c = canonicalPath(rel);
  const slash = /[/\\]\s*$/.test(String(entry).trim());
  const dirOnDisk = (raw) => probe && typeof probe.isDir === 'function' && safeProbe(() => probe.isDir(raw)) === true;
  const spellings = [{ canon: c, dir: c === '' || slash || dirOnDisk(rel) }];
  const real = c !== '' && !c.startsWith('../') && probe && typeof probe.real === 'function' ? safeProbe(() => probe.real(rel)) : null;
  if (typeof real === 'string' && real !== '' && canonicalPath(real) !== c) spellings.push({ canon: canonicalPath(real), dir: dirOnDisk(real) });
  return spellings.some((s) => keys.some((k) => k === s.canon || (s.dir && (s.canon === '' || k.startsWith(s.canon + '/')))));
}

/** Plans that list a check file (or ORDERS.yaml) in files_modified, directly or through a directory, glob, absolute path or link. */
function findCheckFileEdits(applicable, okPlans, ctx = {}) {
  const set = protectedSet(Array.isArray(ctx.allOrders) ? ctx.allOrders : applicable, { includeOrders: typeof ctx.ordersPath === 'string' });
  const items = ctx.ordersPath === undefined ? set : set.map((i) => (i.id === null ? { ...i, file: ctx.ordersPath } : i));
  const keyed = items.map((item) => ({ item, keys: protectedKeys(item, ctx.probe) }));
  const edits = [];
  const reasons = [];
  for (const plan of okPlans) {
    const entries = (Array.isArray(plan.files_modified) ? plan.files_modified : []).filter((f) => typeof f === 'string');
    const seen = new Set();
    for (const { item, keys } of keyed) {
      const dedupe = `${item.id}\u0000${item.file}`;
      if (seen.has(dedupe) || !entries.some((entry) => entryCovers(entry, keys, ctx))) continue;
      seen.add(dedupe);
      edits.push({ plan: plan.file, file: item.file, id: item.id });
      reasons.push({
        code: 'check_file_modified',
        message: item.id === null
          ? `${plan.file} lists ${item.file}, the rules file, in files_modified; the rules are fixed before the implementing phase`
          : `${plan.file} lists ${item.file}, a check file of ${item.id}, in files_modified; checks are fixed before the implementing phase`,
      });
    }
  }
  return { edits, reasons };
}

/**
 * Check that every applicable order is cited, and projected, in some readable
 * plan's must_haves, and that no plan lists a check file in files_modified.
 * @returns {{ status: string, uncited: string[], notProjected: string[], checkFileEdits: object[], unreadablePlans: string[], reasons: object[] }}
 */
function evaluateCoverage({ applicableIds, applicable, ordersTotal, plans, allOrders, ordersPath, root, probe }) {
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
    const edits = findCheckFileEdits(orders, okPlans, { allOrders, ordersPath, root, probe });
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
