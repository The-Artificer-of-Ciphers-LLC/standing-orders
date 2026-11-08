#!/usr/bin/env node
'use strict';

/**
 * standing-orders-router.cjs — command family router for `standing-orders`.
 *
 * Host contract (gsd-core ADR-959 / ADR-1244 D7, `gsd-tools.cjs`
 * dispatchOverlayCapabilityCommand): the dispatcher `require()`s this module
 * from the capability's install root and calls the exported router
 * SYNCHRONOUSLY as `routeStandingOrdersCommand({ args, cwd, raw, error })`, where
 *   args[0] === 'standing-orders'   (family name)
 *   args[1] === subcommand
 *   args[2..] === positionals / flags
 * A router that returns a Promise is rejected by the host.
 *
 * Phase 1 ships only `validate`. Until the manifest lands (phase 2) the same
 * verb is reachable directly:
 *   node standing-orders-router.cjs validate [file] [--raw]
 * Exit codes (direct CLI only): 0 valid; 1 invalid or usage error; 2 the file
 * could not be read (missing, unreadable, too large, outside the project).
 *
 * `deps` is a test seam for I/O: { exists, statSize, readFile, log }.
 */

const fs = require('node:fs');
const path = require('node:path');

const { parseOrders, ERROR_CODES, KINDS, VERIFICATIONS } = require('./lib/orders.cjs');
const { detectConflicts } = require('./lib/conflicts.cjs');

const FAMILY = 'standing-orders';
const SUBCOMMANDS = Object.freeze(['validate']);
const DEFAULT_ORDERS_PATH = path.join('.planning', 'standing-orders', 'ORDERS.yaml');
/** Refuse to read a rules file larger than this (bytes) — a rules file is small by nature. */
const MAX_FILE_BYTES = 256 * 1024;
const REPORT_SCHEMA = 1;

const FILE_ERROR_CODES = new Set([
  ERROR_CODES.PATH_OUTSIDE_CWD,
  ERROR_CODES.FILE_NOT_FOUND,
  ERROR_CODES.FILE_UNREADABLE,
  ERROR_CODES.FILE_TOO_LARGE,
]);

function defaultDeps() {
  return {
    exists: (p) => fs.existsSync(p),
    statSize: (p) => fs.statSync(p).size,
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    log: (m) => process.stdout.write(m + '\n'),
  };
}

function toSlashes(p) {
  return String(p).replace(/\\/g, '/');
}

function emptySummary() {
  const byKind = {};
  for (const k of KINDS) byKind[k] = 0;
  const byVerification = {};
  for (const v of VERIFICATIONS) byVerification[v] = 0;
  return { orders: 0, contexts: 0, byKind, byVerification };
}

function summarize(document) {
  const s = emptySummary();
  if (!document) return s;
  s.orders = document.orders.length;
  s.contexts = Object.keys(document.contexts).length;
  for (const o of document.orders) {
    s.byKind[o.kind] += 1;
    s.byVerification[o.verification] += 1;
  }
  return s;
}

/**
 * Validate one ORDERS.yaml under `cwd`. Pure apart from `deps`.
 * @returns {{ report: object, usageError: string|null }}
 */
function validateFile({ cwd, fileArg, deps }) {
  const report = {
    schema: REPORT_SCHEMA,
    ok: false,
    file: toSlashes(fileArg),
    errors: [],
    warnings: [],
    conflicts: [],
    missingChecks: [],
    summary: emptySummary(),
  };
  const fail = (code, message) => {
    report.errors.push({ code, path: '$', message });
    return report;
  };

  const root = path.resolve(cwd);
  const abs = path.resolve(root, fileArg);
  const rel = path.relative(root, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return fail(ERROR_CODES.PATH_OUTSIDE_CWD, `${toSlashes(fileArg)} resolves outside the project root ${toSlashes(root)}`);
  }
  if (!deps.exists(abs)) return fail(ERROR_CODES.FILE_NOT_FOUND, `${toSlashes(fileArg)} does not exist under ${toSlashes(root)}`);

  let size;
  try {
    size = deps.statSize(abs);
  } catch (e) {
    return fail(ERROR_CODES.FILE_UNREADABLE, `${toSlashes(fileArg)} could not be examined: ${e && e.message ? e.message : String(e)}`);
  }
  if (typeof size === 'number' && size > MAX_FILE_BYTES) {
    return fail(ERROR_CODES.FILE_TOO_LARGE, `${toSlashes(fileArg)} is ${size} bytes; the limit is ${MAX_FILE_BYTES}`);
  }

  let text;
  try {
    text = deps.readFile(abs);
  } catch (e) {
    return fail(ERROR_CODES.FILE_UNREADABLE, `${toSlashes(fileArg)} could not be read: ${e && e.message ? e.message : String(e)}`);
  }

  const parsed = parseOrders(text);
  report.errors = parsed.errors;
  report.warnings = [...parsed.warnings];
  report.summary = summarize(parsed.document);
  if (!parsed.ok) return report;

  const existsUnderRoot = (p) => {
    const target = path.resolve(root, String(p));
    const r = path.relative(root, target);
    if (r.startsWith('..') || path.isAbsolute(r)) return false;
    return deps.exists(target);
  };
  const detected = detectConflicts(parsed.document, { exists: existsUnderRoot });
  report.conflicts = detected.conflicts;
  report.missingChecks = detected.missingChecks;
  for (const m of detected.missingChecks) {
    const index = parsed.document.orders.findIndex((o) => o.id === m.id);
    report.warnings.push({
      code: ERROR_CODES.CHECK_TARGET_MISSING,
      path: `$.orders[${index}].check_target`,
      message: `check target ${m.check_target} for ${m.id} was not found under the project root`,
    });
  }
  report.ok = report.errors.length === 0 && report.conflicts.length === 0;
  return report;
}

function humanLines(report) {
  const verdict = report.ok ? 'OK' : 'INVALID';
  const s = report.summary;
  const lines = [
    `standing-orders validate: ${report.file} — ${verdict}: ${s.orders} order(s), ${s.contexts} context(s), ${report.conflicts.length} conflict(s), ${report.warnings.length} warning(s)`,
  ];
  for (const e of report.errors) lines.push(`  error ${e.code} at ${e.path}: ${e.message}`);
  for (const c of report.conflicts) lines.push(`  conflict ${c.kind}: ${c.message}`);
  for (const w of report.warnings) lines.push(`  warning ${w.code} at ${w.path}: ${w.message}`);
  return lines;
}

/**
 * Route a `standing-orders` command. Synchronous.
 * @param {{ args: string[], cwd: string, raw?: boolean, error: (msg: string) => void, deps?: object }} options
 */
function routeStandingOrdersCommand({ args = [], cwd = process.cwd(), raw = false, error = () => {}, deps = {} }) {
  const d = { ...defaultDeps(), ...deps };
  const subcommand = args[1];
  if (subcommand !== 'validate') {
    const msg = subcommand
      ? `${FAMILY}: unknown subcommand ${JSON.stringify(subcommand)}. Available: ${SUBCOMMANDS.join(', ')}`
      : `${FAMILY}: no subcommand given. Available: ${SUBCOMMANDS.join(', ')}`;
    error(msg);
    return { ok: false, error: msg };
  }

  const rest = args.slice(2);
  const rawOut = raw === true || rest.includes('--raw');
  const positionals = rest.filter((a) => typeof a === 'string' && !a.startsWith('--'));
  const fileArg = positionals.length > 0 ? positionals[0] : DEFAULT_ORDERS_PATH;

  const report = validateFile({ cwd, fileArg, deps: d });
  if (report.errors.some((e) => e.code === ERROR_CODES.PATH_OUTSIDE_CWD)) {
    error(report.errors[0].message);
  }
  if (rawOut) d.log(JSON.stringify(report));
  else for (const l of humanLines(report)) d.log(l);
  return report;
}

/** Exit code for the direct CLI: 0 ok; 2 the file could not be read; 1 otherwise. */
function exitCodeFor(report) {
  if (report.ok) return 0;
  if (Array.isArray(report.errors) && report.errors.some((e) => FILE_ERROR_CODES.has(e.code))) return 2;
  return 1;
}

if (require.main === module) {
  const report = routeStandingOrdersCommand({
    args: [FAMILY, ...process.argv.slice(2)],
    cwd: process.cwd(),
    raw: false,
    error: (msg) => process.stderr.write(msg + '\n'),
  });
  process.exitCode = exitCodeFor(report);
}

module.exports = { routeStandingOrdersCommand, validateFile, exitCodeFor, DEFAULT_ORDERS_PATH, MAX_FILE_BYTES, SUBCOMMANDS, REPORT_SCHEMA };
