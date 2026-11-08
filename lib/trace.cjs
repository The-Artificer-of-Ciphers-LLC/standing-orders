'use strict';

/**
 * lib/trace.cjs -- the append-only traceability ledger (PRD-0001 R13-R15; ADR-0001 section 7).
 *
 * TRACE.jsonl holds one JSON object per line: which order was applicable in which
 * phase, the hash of the order as it was then, the plans and files that carried it,
 * its check and disposition, and the code commit it was traced at. `impact` and
 * `stale` read it back against the current ORDERS.yaml.
 *
 * Pure: every function takes its inputs as arguments and never throws for bad
 * input. All file and process I/O lives in the router. The reader is lenient (an
 * invalid line is reported and skipped, never rewritten); the writer is strict
 * (fixed key order, `schema: 1`).
 */

const crypto = require('node:crypto');
const { effectiveLeaves } = require('./orders.cjs');
const { globToRegExp } = require('./select.cjs');
const { isCited, protectedFiles, canonicalPath } = require('./phase.cjs');
const { isPlainObject, unique, compareStrings, nonEmptyString } = require('./util.cjs');

const TRACE_PATH = '.planning/standing-orders/TRACE.jsonl';
const TRACE_SCHEMA = 1;
/** Refuse to read a ledger larger than this (bytes). */
const MAX_TRACE_BYTES = 32 * 1024 * 1024;
const DISPOSITIONS = Object.freeze(['proven', 'flagged', 'unenforced', 'insufficient_spec']);
const RECORD_KEYS = Object.freeze(['schema', 'order_id', 'order_hash', 'contexts', 'phase', 'plans', 'files', 'check', 'disposition', 'commit_sha', 'ts']);
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
/** A recorded phase: a relative path of plain characters (a leading `.` is allowed: `.planning/phases/03-x`). */
const PHASE_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/;
const MAX_ID_CHARS = 200;
/** A ledger line longer than this (characters) is skipped before it is parsed. */
const MAX_LINE_CHARS = 65536;

/** True for a value the canonical form leaves out: null, undefined, an empty list, or an object of only such values. */
function isOmitted(v) {
  if (v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (isPlainObject(v)) return Object.keys(v).every((k) => isOmitted(v[k]));
  return false;
}

/** Deterministic JSON: keys sorted, null/undefined/empty entries dropped, array order kept. */
function canonicalize(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (isPlainObject(value)) {
    const parts = [];
    for (const key of Object.keys(value).sort(compareStrings)) {
      if (isOmitted(value[key])) continue;
      parts.push(JSON.stringify(key) + ':' + canonicalize(value[key]));
    }
    return '{' + parts.join(',') + '}';
  }
  const s = JSON.stringify(value);
  return s === undefined ? 'null' : s;
}

function sortedUnique(list) {
  return unique(list).sort(compareStrings);
}

/** A copy of a normalized order whose set-valued lists are sorted and de-duplicated. */
function canonicalOrder(order) {
  const copy = { ...order };
  if (Array.isArray(copy.contexts)) copy.contexts = sortedUnique(copy.contexts);
  if (Array.isArray(copy.check_mutants)) copy.check_mutants = sortedUnique(copy.check_mutants);
  if (isPlainObject(copy.scope)) {
    copy.scope = { ...copy.scope };
    for (const key of ['paths', 'requirements']) if (Array.isArray(copy.scope[key])) copy.scope[key] = sortedUnique(copy.scope[key]);
  }
  return copy;
}

/** `sha256:<hex>` over the canonical form of a normalized order. */
function orderHash(order) {
  return 'sha256:' + crypto.createHash('sha256').update(canonicalize(canonicalOrder(order)), 'utf8').digest('hex');
}

/** The disposition of an order in a phase, from the last ENFORCEMENT.json (or null). */
function dispositionFor(order, enforcement, phaseRel, changedFiles) {
  if (!isPlainObject(order) || order.verification !== 'test') return 'insufficient_spec';
  if (!isPlainObject(enforcement) || enforcement.phase !== phaseRel || !Array.isArray(enforcement.results)) return 'unenforced';
  const result = enforcement.results.find((r) => isPlainObject(r) && r.id === order.id);
  if (result === undefined) return 'unenforced';
  // A proof binds to the order it proved: a result that names another version of this order proves nothing here.
  // (A report written before order_hash existed has no such key and keeps its meaning.)
  if (Object.prototype.hasOwnProperty.call(result, 'order_hash') && result.order_hash !== orderHash(order)) return 'unenforced';
  if (result.status !== 'green' || result.flagged !== false) return 'flagged';
  // ...and to the check files it ran: a file that changed since enforce verified it voids the proof.
  const changed = changedFiles instanceof Set ? changedFiles : new Set();
  if (protectedFiles(order).some((f) => changed.has(canonicalPath(f)))) return 'flagged';
  return 'proven';
}

/** The check an order names, or null for a backstop. */
function checkOf(order) {
  if (!isPlainObject(order) || order.verification !== 'test') return null;
  const check = { kind: order.check_kind, target: order.check_target };
  if (order.check_kind === 'lint-rule' && nonEmptyString(order.check_rule)) check.rule = order.check_rule;
  return check;
}

function plansCiting(order, plans) {
  const list = Array.isArray(plans) ? plans : [];
  return sortedUnique(list.filter((p) => isPlainObject(p) && p.ok === true && isCited(order.id, p.must_haves)).map((p) => p.file));
}

function filesMatching(order, files) {
  const paths = isPlainObject(order.scope) && Array.isArray(order.scope.paths) ? order.scope.paths : [];
  const candidates = Array.isArray(files) ? files.filter((f) => typeof f === 'string') : [];
  const matched = [];
  for (const glob of paths) {
    const matcher = globToRegExp(glob);
    for (const f of candidates) if (matcher.test(f)) matched.push(f);
  }
  return sortedUnique(matched);
}

/** One ledger record per applicable order, in input order. */
function buildRecords({ applicable, document, phaseRel, plans, files, enforcement, commitSha, ts, changedFiles }) {
  return (Array.isArray(applicable) ? applicable : []).map((order) => ({
    schema: TRACE_SCHEMA,
    order_id: order.id,
    order_hash: orderHash(order),
    contexts: effectiveLeaves(order, document),
    phase: phaseRel,
    plans: plansCiting(order, plans),
    files: filesMatching(order, files),
    check: checkOf(order),
    disposition: dispositionFor(order, enforcement, phaseRel, changedFiles),
    commit_sha: commitSha === undefined ? null : commitSha,
    ts,
  }));
}

function serializeRecord(record) {
  return JSON.stringify(record);
}

/** True for a phase name safe to store and to print: a short relative path of plain characters with no `..` segment. */
function isValidPhase(phase) {
  return typeof phase === 'string' && PHASE_RE.test(phase) && !phase.split('/').includes('..');
}

function isRecord(v) {
  return (
    isPlainObject(v) &&
    v.schema === TRACE_SCHEMA &&
    nonEmptyString(v.order_id) &&
    v.order_id.length <= MAX_ID_CHARS &&
    typeof v.order_hash === 'string' &&
    HASH_RE.test(v.order_hash) &&
    isValidPhase(v.phase)
  );
}

/** Parse a ledger leniently: invalid lines are reported with their 1-based number and skipped. */
function parseTrace(text) {
  const records = [];
  const warnings = [];
  if (typeof text !== 'string') return { records, warnings };
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (line.trim() === '') continue;
    if (line.length > MAX_LINE_CHARS) {
      warnings.push({ code: 'trace_line_invalid', line: i + 1, message: `TRACE.jsonl line ${i + 1} is longer than ${MAX_LINE_CHARS} characters and was ignored` });
      continue;
    }
    let value;
    try {
      value = JSON.parse(line);
    } catch (e) {
      warnings.push({ code: 'trace_line_invalid', line: i + 1, message: `TRACE.jsonl line ${i + 1} is not valid JSON and was ignored` });
      continue;
    }
    if (isRecord(value)) records.push(value);
    else warnings.push({ code: 'trace_line_invalid', line: i + 1, message: `TRACE.jsonl line ${i + 1} is not a schema 1 trace record and was ignored` });
  }
  return { records, warnings };
}

/** The identity of a record for de-duplication: order, hash, phase and code commit. */
function dedupeKey(record) {
  return JSON.stringify([record.order_id, record.order_hash, record.phase, record.commit_sha === undefined ? null : record.commit_sha]);
}

/** Split candidates into those to append and the ids already traced (including repeats within the batch). */
function newRecords(existing, candidates) {
  const seen = new Set((Array.isArray(existing) ? existing : []).map(dedupeKey));
  const append = [];
  const skipped = [];
  for (const record of Array.isArray(candidates) ? candidates : []) {
    const key = dedupeKey(record);
    if (seen.has(key)) {
      skipped.push(record.order_id);
      continue;
    }
    seen.add(key);
    append.push(record);
  }
  return { append, skipped };
}

/** The bytes to append to a ledger holding `existingText`: a separating newline if needed, then one line per record. */
function appendText(existingText, records) {
  if (!Array.isArray(records) || records.length === 0) return '';
  const existing = typeof existingText === 'string' ? existingText : '';
  const lead = existing !== '' && !existing.endsWith('\n') ? '\n' : '';
  return lead + records.map((r) => serializeRecord(r) + '\n').join('');
}

/** The last record per order id, in file order. */
function latestById(records) {
  const map = new Map();
  for (const r of Array.isArray(records) ? records : []) map.set(r.order_id, r);
  return map;
}

function orderIn(document, id) {
  const orders = isPlainObject(document) && Array.isArray(document.orders) ? document.orders : [];
  return orders.find((o) => isPlainObject(o) && o.id === id);
}

function sameSet(a, b) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  return JSON.stringify(sortedUnique(left)) === JSON.stringify(sortedUnique(right));
}

function phaseEntry(record, mismatch) {
  return {
    phase: record.phase,
    plans: Array.isArray(record.plans) ? record.plans : [],
    files: Array.isArray(record.files) ? record.files : [],
    check: record.check === undefined ? null : record.check,
    disposition: record.disposition,
    commit_sha: record.commit_sha === undefined ? null : record.commit_sha,
    ts: record.ts,
    order_hash: record.order_hash,
    hash_mismatch: mismatch,
  };
}

/** Every phase an order was traced in (latest record per phase), compared with the current ORDERS.yaml. */
function impactOf({ id, records, document }) {
  const mine = (Array.isArray(records) ? records : []).filter((r) => r.order_id === id);
  const order = orderIn(document, id);
  const currentHash = order === undefined ? null : orderHash(order);
  if (mine.length === 0) {
    return { id, traced: false, status: 'untraced', current_hash: currentHash, hash_mismatch: false, contexts_changed: false, phases: [] };
  }
  const latest = mine[mine.length - 1];
  const perPhase = new Map();
  for (const r of mine) perPhase.set(r.phase, r);
  // true: the order was removed or edited since this record; false: unchanged; null: ORDERS.yaml unusable.
  const mismatchOf = (r) => {
    if (!isPlainObject(document)) return null;
    return order === undefined ? true : r.order_hash !== currentHash;
  };
  const phases = [...perPhase.values()].sort((a, b) => compareStrings(a.phase, b.phase)).map((r) => phaseEntry(r, mismatchOf(r)));
  const result = { id, traced: true, current_hash: currentHash, phases };
  if (!isPlainObject(document)) return { ...result, status: 'orders_unusable', hash_mismatch: null, contexts_changed: null };
  if (order === undefined) return { ...result, status: 'removed', hash_mismatch: true, contexts_changed: null };
  const mismatch = latest.order_hash !== currentHash;
  return { ...result, status: mismatch ? 'changed' : 'current', hash_mismatch: mismatch, contexts_changed: !sameSet(latest.contexts, effectiveLeaves(order, document)) };
}

function staleReason(record, order, document) {
  if (order === undefined) return 'removed';
  if (record.order_hash !== orderHash(order)) return 'changed';
  if (!sameSet(record.contexts, effectiveLeaves(order, document))) return 'contexts_changed';
  return null;
}

/** The orders whose latest trace no longer matches ORDERS.yaml, sorted by id. */
function staleOf({ records, document }) {
  if (!isPlainObject(document)) return [];
  const out = [];
  for (const [id, record] of latestById(records)) {
    const order = orderIn(document, id);
    const reason = staleReason(record, order, document);
    if (reason === null) continue;
    out.push({ id, reason, last_phase: record.phase, last_hash: record.order_hash, current_hash: order === undefined ? null : orderHash(order) });
  }
  return out.sort((a, b) => compareStrings(a.id, b.id));
}

module.exports = {
  TRACE_PATH, TRACE_SCHEMA, MAX_TRACE_BYTES, DISPOSITIONS, RECORD_KEYS,
  isValidPhase, canonicalize, canonicalOrder, orderHash, dispositionFor, checkOf, buildRecords, serializeRecord, parseTrace, dedupeKey, newRecords, appendText, latestById, impactOf, staleOf,
};
