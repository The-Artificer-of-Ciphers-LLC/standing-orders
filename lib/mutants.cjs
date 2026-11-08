'use strict';

/**
 * lib/mutants.cjs — mutant enforcement for test-tier standing orders (ADR-0002).
 *
 * A mutant is a violation fixture that differs from the base only by being a
 * second "bad" input. It is proven by the very same prover call as the base
 * (runEnforcement), with only `check_violation_fixture` replaced. Mutants run
 * only after the base result is green and unflagged, in sorted path order,
 * sequentially.
 *
 * Fail-closed: an `error` outcome is never cached, and a cache problem means
 * "empty", never "killed". Mutant files and the cache file are read with the
 * same containment discipline the router uses for ENFORCEMENT.json: no
 * symlinks, the real path must stay inside the real project root, bounded size.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const { runEnforcement } = require('./host.cjs');
const { canonicalize } = require('./trace.cjs');
const { isPlainObject, compareStrings } = require('./util.cjs');

const MUTANTS_PATH = '.planning/standing-orders/MUTANTS.json';
const MAX_CACHE_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 2000;
const MAX_MUTANT_BYTES = 65536;
const MUTANT_CODES = Object.freeze({
  ORDER_NOT_FOUND: 'order_not_found',
  ORDER_NOT_TEST: 'order_not_test',
  PATH_INVALID: 'path_invalid',
  PATH_OUTSIDE_PROJECT: 'path_outside_project',
  PATH_RESERVED: 'path_reserved',
  MUTANT_IS_CHECK_FILE: 'mutant_is_check_file',
  MUTANT_EXISTS: 'mutant_exists',
  CONTENT_INVALID: 'content_invalid',
  MANUAL: 'manual',
});

const sha = (t) => crypto.createHash('sha256').update(String(t), 'utf8').digest('hex');

function cacheKey({ check_kind, check_rule, target, clean, mutant }) {
  const o = { check_kind, target: sha(target), mutant: sha(mutant) };
  if (check_rule) o.check_rule = check_rule;
  if (typeof clean === 'string') o.clean = sha(clean);
  return sha(canonicalize(o));
}

const validEntry = (e) => isPlainObject(e) && (e.outcome === 'killed' || e.outcome === 'survived') && typeof e.ts === 'string';

function parseCache(text) {
  const out = {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return out;
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.entries)) return out;
  for (const key of Object.keys(parsed.entries)) {
    if (key === '__proto__') continue;
    const e = parsed.entries[key];
    if (validEntry(e)) out[key] = { outcome: e.outcome, ts: e.ts };
  }
  return out;
}

function serializeCache(entries) {
  let keys = Object.keys(entries);
  if (keys.length > MAX_CACHE_ENTRIES) {
    keys = keys.sort((a, b) => compareStrings(entries[b].ts, entries[a].ts) || compareStrings(a, b)).slice(0, MAX_CACHE_ENTRIES);
  }
  const out = {};
  for (const k of keys.sort(compareStrings)) out[k] = entries[k];
  return JSON.stringify({ schema: 1, entries: out }, null, 2) + '\n';
}

function isInside(root, abs) {
  const rel = path.relative(root, abs);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

/** Read the cache. Any problem (missing, symlink, outside root, too big, bad JSON) is "empty". */
function readCache({ root, io }) {
  try {
    const abs = path.resolve(root, MUTANTS_PATH);
    if (io.isSymlink(abs)) return {};
    if (!io.exists(abs) || !io.isFile(abs)) return {};
    const real = io.realpath(abs);
    if (!isInside(io.realpath(root), real)) return {};
    const size = io.statSize(real);
    if (typeof size !== 'number' || !(size <= MAX_CACHE_BYTES)) return {};
    return parseCache(String(io.readFile(abs)));
  } catch (e) {
    return {};
  }
}

function readText(root, rel, io) {
  try {
    return String(io.readFile(path.resolve(root, rel)));
  } catch (e) {
    return null;
  }
}

/** Read one mutant file with containment: { text } or { error }. */
function readMutant(root, p, io) {
  try {
    const abs = path.resolve(root, p);
    if (!isInside(root, abs)) return { error: `mutant_unreadable: ${p} resolves outside the project` };
    if (io.isSymlink(abs)) return { error: `mutant_unreadable: ${p} is a symbolic link` };
    if (!io.exists(abs)) return { error: `mutant_missing: ${p} does not exist` };
    if (!io.isFile(abs)) return { error: `mutant_unreadable: ${p} is not a regular file` };
    const real = io.realpath(abs);
    if (!isInside(io.realpath(root), real)) return { error: `mutant_unreadable: ${p} resolves outside the project` };
    const size = io.statSize(real);
    if (typeof size !== 'number' || !(size <= MAX_MUTANT_BYTES)) return { error: `mutant_unreadable: ${p} is larger than ${MAX_MUTANT_BYTES} bytes` };
    return { text: String(io.readFile(abs)) };
  } catch (e) {
    return { error: `mutant_unreadable: ${p}: ${e && e.message}` };
  }
}

const isFailureReason = (r) => /^(host_|request_too_large)/.test(r || '');

/**
 * Run the mutants of `order` after a proven base. Returns
 * { result, entries, changed }: `result` is `base` itself when there is nothing
 * to do (no mutants, or the base is not green and unflagged).
 */
function applyMutants({ order, base, root, io, entries = {}, useCache = true, ts }) {
  const list = isPlainObject(order) && Array.isArray(order.check_mutants) ? order.check_mutants.filter((x) => typeof x === 'string' && x !== '') : [];
  if (list.length === 0 || !(base && base.status === 'green' && base.flagged === false)) return { result: base, entries, changed: false };
  const sorted = [...list].sort(compareStrings);
  const next = { ...entries };
  let changed = false;
  const targetText = readText(root, order.check_target, io);
  const cleanText = order.check_clean_fixture ? readText(root, order.check_clean_fixture, io) : null;
  const hashable = targetText !== null && (!order.check_clean_fixture || cleanText !== null);
  const results = sorted.map((p) => {
    const file = readMutant(root, p, io);
    if (file.error !== undefined) return { path: p, outcome: 'error', cached: false, reason: file.error };
    const key = hashable ? cacheKey({ check_kind: order.check_kind, check_rule: order.check_kind === 'lint-rule' ? order.check_rule : null, target: targetText, clean: cleanText, mutant: file.text }) : null;
    if (useCache && key !== null && validEntry(entries[key])) return { path: p, outcome: entries[key].outcome, cached: true, reason: 'cached' };
    const r = runEnforcement({ order: { ...order, check_violation_fixture: p }, cwd: root, env: io.env, argv: io.argv, deps: io });
    let outcome = 'survived';
    if (r.status === 'green' && r.flagged === false) outcome = 'killed';
    else if (r.flagged === true && r.status === 'unverified' && isFailureReason(r.reason)) outcome = 'error';
    if (outcome !== 'error' && key !== null) {
      next[key] = { outcome, ts };
      changed = true;
    }
    return { path: p, outcome, cached: false, reason: r.reason };
  });
  const survived = results.filter((x) => x.outcome === 'survived').map((x) => x.path);
  const unverified = results.filter((x) => x.outcome === 'error').map((x) => x.path);
  const parts = [];
  if (survived.length > 0) parts.push(`mutant_survived: ${survived.join(', ')}`);
  if (unverified.length > 0) parts.push(`mutant_unverified: ${unverified.join(', ')}`);
  const flagged = parts.length > 0;
  return { result: { ...base, flagged, reason: flagged ? parts.join('; ') : base.reason, mutants: results }, entries: next, changed };
}

module.exports = { MUTANTS_PATH, MAX_CACHE_BYTES, MAX_CACHE_ENTRIES, MAX_MUTANT_BYTES, MUTANT_CODES, cacheKey, parseCache, serializeCache, readCache, readMutant, applyMutants, isInside };
