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
 * Subcommands: `validate` (phase 1) and the loop wiring `select`, `conflicts`
 * and `coverage` (phase 2). The same verbs are reachable directly:
 *   node standing-orders-router.cjs validate [file] [--raw]
 *   node standing-orders-router.cjs select|conflicts|coverage (--phase <n> | --phase-dir <dir>) [--req-ids <ids>] [--files <list>] [--raw]
 * Exit codes (direct CLI only): 0 ok; 1 invalid, blocked, incomplete or usage
 * error; 2 a file or directory could not be read or resolved.
 *
 * `deps` is a test seam for I/O: { exists, isFile, realpath, statSize, readFile,
 * listDir, writeFile, rename, mkdir, execFile, env, argv, nodePath, log }.
 */

const fs = require('node:fs');
const path = require('node:path');

const { parseOrders, ERROR_CODES, KINDS, VERIFICATIONS } = require('./lib/orders.cjs');
const { detectConflicts } = require('./lib/conflicts.cjs');
const { readCapabilityConfig } = require('./lib/config.cjs');
const { collectPhaseInputs, splitReqIds } = require('./lib/phase.cjs');
const { resolvePhase } = require('./lib/host.cjs');
const { evaluateBlock, evaluateCoverage, renderVerdict, STATUS } = require('./lib/gate.cjs');
const { selectApplicable, renderApplicable, normalizePath } = require('./lib/select.cjs');

const FAMILY = 'standing-orders';
const SUBCOMMANDS = Object.freeze(['select', 'conflicts', 'coverage', 'validate']);
const LOOP_SUBCOMMANDS = Object.freeze(['select', 'conflicts', 'coverage']);
const APPLICABLE_PATH = '.planning/standing-orders/APPLICABLE.md';
const CONFLICTS_PATH = '.planning/standing-orders/CONFLICTS.json';
const VERDICT_NAME = 'STANDING-ORDERS.md';
const DISABLED_MESSAGE = 'standing-orders is not enabled; set standing-orders.enabled to true';
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
    realpath: (p) => fs.realpathSync(p),
    statSize: (p) => fs.statSync(p).size,
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    log: (m) => process.stdout.write(m + '\n'),
    isFile: (p) => {
      try {
        return fs.statSync(p).isFile();
      } catch (e) {
        return false;
      }
    },
    listDir: (p) => fs.readdirSync(p),
    writeFile: (p, text) => fs.writeFileSync(p, text, { flag: 'wx' }),
    rename: (from, to) => fs.renameSync(from, to),
    mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
    execFile: (file, args, opts) => require('node:child_process').execFileSync(file, args, opts),
    env: process.env,
    argv: process.argv,
    nodePath: process.execPath,
  };
}

function toSlashes(p) {
  return String(p).replace(/\\/g, '/');
}

/** True when the absolute path `abs` is strictly inside the absolute directory `root` (a file named `..hidden` is inside). */
function isInside(root, abs) {
  const rel = path.relative(root, abs);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
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
 * Load and parse one ORDERS.yaml under `cwd`. Pure apart from `deps`.
 * `stage` says how far loading got: 'file' (the file could not be read),
 * 'parse' (it was read but is invalid) or 'ok'.
 * @returns {{ report: object, document: object|null, stage: string, root: string }}
 */
function loadOrders({ cwd, fileArg, deps }) {
  const root = path.resolve(cwd);
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
    return { report, document: null, stage: 'file', root };
  };

  const abs = path.resolve(root, fileArg);
  if (!isInside(root, abs)) {
    return fail(ERROR_CODES.PATH_OUTSIDE_CWD, `${toSlashes(fileArg)} resolves outside the project root ${toSlashes(root)}`);
  }
  if (!deps.exists(abs)) return fail(ERROR_CODES.FILE_NOT_FOUND, `${toSlashes(fileArg)} does not exist under ${toSlashes(root)}`);

  // Containment is checked on the real path too, so a symlink committed inside
  // the project cannot point the parser at a file outside it.
  let size;
  try {
    const realRoot = deps.realpath(root);
    const realFile = deps.realpath(abs);
    if (!isInside(realRoot, realFile)) {
      return fail(ERROR_CODES.PATH_OUTSIDE_CWD, `${toSlashes(fileArg)} resolves (through a link) outside the project root ${toSlashes(root)}`);
    }
    size = deps.statSize(realFile);
  } catch (e) {
    return fail(ERROR_CODES.FILE_UNREADABLE, `${toSlashes(fileArg)} could not be examined: ${e && e.message ? e.message : String(e)}`);
  }
  if (typeof size !== 'number' || !Number.isFinite(size)) {
    return fail(ERROR_CODES.FILE_UNREADABLE, `${toSlashes(fileArg)} has no readable size`);
  }
  if (size > MAX_FILE_BYTES) {
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
  if (!parsed.ok) return { report, document: null, stage: 'parse', root };
  return { report, document: parsed.document, stage: 'ok', root };
}

/** Run conflict and check-target detection on a loaded document, recording it on `report`. */
function detectInto(report, document, root, deps) {
  const existsUnderRoot = (p) => {
    const target = path.resolve(root, String(p));
    return isInside(root, target) && deps.exists(target);
  };
  const detected = detectConflicts(document, { exists: existsUnderRoot });
  report.conflicts = detected.conflicts;
  report.missingChecks = detected.missingChecks;
  for (const m of detected.missingChecks) {
    const index = document.orders.findIndex((o) => o.id === m.id);
    report.warnings.push({
      code: ERROR_CODES.CHECK_TARGET_MISSING,
      path: `$.orders[${index}].check_target`,
      message: `check target ${m.check_target} for ${m.id} was not found under the project root`,
    });
  }
  report.ok = report.errors.length === 0 && report.conflicts.length === 0;
  return report;
}

/**
 * Validate one ORDERS.yaml under `cwd`. Pure apart from `deps`.
 * @returns {object} the validate report
 */
function validateFile({ cwd, fileArg, deps }) {
  const loaded = loadOrders({ cwd, fileArg, deps });
  if (loaded.stage !== 'ok') return loaded.report;
  return detectInto(loaded.report, loaded.document, loaded.root, deps);
}

// ─── Loop subcommands: select, conflicts, coverage ────────────────────────────

const VALUE_FLAGS = new Set(['--phase', '--phase-dir', '--req-ids', '--files', '--ws']);

function errMessage(e) {
  return e && e.message ? e.message : String(e);
}

function unique(list) {
  return [...new Set(list)];
}

/** Parse the loop flags. Returns { options } or { usage: message }. */
function parseLoopFlags(subcommand, rest) {
  const options = { phase: null, phaseDir: null, reqIds: null, files: null, raw: false };
  const usageText = `Usage: standing-orders ${subcommand} (--phase <n> | --phase-dir <dir>) [--req-ids <ids>] [--files <list>] [--raw]`;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (typeof a !== 'string' || !a.startsWith('-')) {
      return { usage: `${FAMILY} ${subcommand}: unexpected argument ${JSON.stringify(a)}. ${usageText}` };
    }
    if (a === '--raw') {
      options.raw = true;
      continue;
    }
    if (!VALUE_FLAGS.has(a)) return { usage: `${FAMILY} ${subcommand}: unknown flag ${JSON.stringify(a)}. ${usageText}` };
    const value = rest[i + 1];
    if (typeof value !== 'string' || value.startsWith('-')) {
      return { usage: `${FAMILY} ${subcommand}: flag ${a} needs a value. ${usageText}` };
    }
    i += 1;
    if (a === '--phase') options.phase = value;
    else if (a === '--phase-dir') options.phaseDir = value;
    else if (a === '--req-ids') options.reqIds = value;
    else if (a === '--files') options.files = value;
  }
  if ((options.phase === null) === (options.phaseDir === null)) {
    return { usage: `${FAMILY} ${subcommand}: give exactly one of --phase and --phase-dir. ${usageText}` };
  }
  return { options };
}

/** Write `text` to `abs` through a temp file and a rename. */
function writeAtomic(io, abs, text, seq) {
  io.mkdir(path.dirname(abs));
  const tmp = `${abs}.tmp-${process.pid}-${seq}`;
  io.writeFile(tmp, text);
  io.rename(tmp, abs);
}

function containPhaseDir(root, phaseDir, io) {
  if (!isInside(root, phaseDir)) {
    return { code: 'path_outside_cwd', message: `phase directory ${toSlashes(phaseDir)} resolves outside the project root ${toSlashes(root)}` };
  }
  if (!io.exists(phaseDir)) return { code: 'phase_dir_not_found', message: `phase directory ${toSlashes(path.relative(root, phaseDir))} does not exist` };
  let realRoot;
  let realDir;
  try {
    realRoot = io.realpath(root);
    realDir = io.realpath(phaseDir);
  } catch (e) {
    return { code: 'phase_dir_not_found', message: `phase directory could not be examined: ${errMessage(e)}` };
  }
  if (!isInside(realRoot, realDir)) {
    return { code: 'path_outside_cwd', message: `phase directory ${toSlashes(path.relative(root, phaseDir))} resolves (through a link) outside the project root` };
  }
  return null;
}

/** Map a loaded ORDERS.yaml to the gate's `orders` shape. */
function ordersForGate(cwd, io) {
  const loaded = loadOrders({ cwd, fileArg: DEFAULT_ORDERS_PATH, deps: io });
  const warnings = [];
  if (loaded.stage === 'file') {
    const first = loaded.report.errors[0];
    if (first && first.code === ERROR_CODES.FILE_NOT_FOUND) {
      warnings.push({ code: 'orders_file_missing', message: first.message });
      return { orders: { state: 'missing', errors: [], conflicts: [], missingChecks: [] }, document: null, warnings };
    }
    return { orders: { state: 'unreadable', errors: loaded.report.errors, conflicts: [], missingChecks: [] }, document: null, warnings };
  }
  if (loaded.stage === 'parse') {
    return { orders: { state: 'invalid', errors: loaded.report.errors, conflicts: [], missingChecks: [] }, document: null, warnings: [...loaded.report.warnings] };
  }
  const report = detectInto(loaded.report, loaded.document, loaded.root, io);
  return {
    orders: { state: 'ok', errors: [], conflicts: report.conflicts, missingChecks: report.missingChecks },
    document: loaded.document,
    warnings: [...report.warnings],
  };
}

function humanLoopLines(result) {
  const parts = [`conflicts ${result.conflicts}`];
  if (result.coverage !== null) parts.push(`coverage ${result.coverage}`);
  const lines = [`standing-orders ${result.subcommand}: phase ${result.phase.dir} — ${parts.join(', ')}: ${result.applicable.length} applicable`];
  for (const r of result.reasons) lines.push(`  ${r.code}: ${r.message}`);
  return lines;
}

function loopFailure(subcommand, code, message, written, error) {
  error(message);
  return { schema: REPORT_SCHEMA, subcommand, ok: false, errors: [{ code, message }], written };
}

function runLoopCommand({ subcommand, rest, cwd, raw, error, io }) {
  const parsed = parseLoopFlags(subcommand, rest);
  if (parsed.usage !== undefined) return loopFailure(subcommand, 'usage', parsed.usage, [], error);
  const options = parsed.options;
  const rawOut = raw === true || options.raw;
  const emit = (result) => {
    if (rawOut) io.log(JSON.stringify(result));
    else for (const l of humanLoopLines(result)) io.log(l);
  };

  const root = path.resolve(cwd);
  const config = readCapabilityConfig({ cwd: root, env: io.env, readFile: io.readFile, statSize: io.statSize });
  if (!config.enabled) {
    const result = { schema: REPORT_SCHEMA, subcommand, ok: true, disabled: true, message: DISABLED_MESSAGE, written: [] };
    io.log(rawOut ? JSON.stringify(result) : DISABLED_MESSAGE);
    return result;
  }

  let reqIds = [];
  let phaseDir;
  if (options.phaseDir !== null) {
    phaseDir = path.resolve(root, options.phaseDir);
  } else {
    const resolved = resolvePhase({ phase: options.phase, cwd: root, env: io.env, argv: io.argv, deps: io });
    if (!resolved.ok) return loopFailure(subcommand, resolved.code, resolved.message, [], error);
    phaseDir = resolved.phaseDir;
    reqIds = resolved.reqIds;
  }
  const bad = containPhaseDir(root, phaseDir, io);
  if (bad !== null) return loopFailure(subcommand, bad.code, bad.message, [], error);
  if (options.reqIds !== null) reqIds = splitReqIds(options.reqIds);

  const phaseRel = toSlashes(path.relative(root, phaseDir));
  const loadedOrders = ordersForGate(cwd, io);
  const inputs = collectPhaseInputs({ phaseDir, deps: io });
  const extraFiles = options.files === null ? [] : options.files.split(',').map((p) => p.trim()).filter((p) => p !== '').map(normalizePath);
  const selection = {
    files: unique([...inputs.files, ...extraFiles]),
    requirements: unique([...reqIds, ...inputs.planRequirements]),
  };
  const applicable = selectApplicable(loadedOrders.document, selection);
  const applicableIds = applicable.map((o) => o.id);
  const applicableSet = new Set(applicableIds);
  const block = evaluateBlock({ orders: loadedOrders.orders, applicableIds, blockOn: config.blockOn });
  const warnings = [...config.warnings, ...loadedOrders.warnings, ...inputs.warnings];
  const verdictRel = `${phaseRel}/${VERDICT_NAME}`;

  let coverageStatus = null;
  let reasons = block.reasons;
  let uncited = [];
  let omitted = [];
  let cov = null;
  if (subcommand === 'select') coverageStatus = STATUS.PENDING;
  if (subcommand === 'coverage') {
    cov = evaluateCoverage({
      applicableIds,
      ordersTotal: loadedOrders.document ? loadedOrders.document.orders.length : 0,
      plans: inputs.plans,
    });
    coverageStatus = cov.status;
    reasons = [...block.reasons, ...cov.reasons];
    uncited = cov.uncited;
  }
  const verdictText = (coverage, generatedBy) =>
    renderVerdict({ phase: path.basename(phaseDir), conflicts: block.status, coverage, generatedBy, applicableIds, reasons });

  const written = [];
  let seq = 0;
  if (subcommand === 'select') {
    const soDir = path.resolve(root, path.dirname(APPLICABLE_PATH));
    try {
      io.mkdir(soDir);
      if (!isInside(io.realpath(root), io.realpath(soDir))) {
        return loopFailure(subcommand, 'path_outside_cwd', `${toSlashes(path.dirname(APPLICABLE_PATH))} resolves (through a link) outside the project root`, [], error);
      }
    } catch (e) {
      return loopFailure(subcommand, 'write_failed', `${subcommand}: could not prepare output directory: ${errMessage(e)}`, [], error);
    }
  }
  const put = (rel, text) => {
    writeAtomic(io, path.resolve(root, rel), text, seq++);
    written.push(rel);
  };
  try {
    if (subcommand === 'select') {
      const rendered = renderApplicable(applicable, { maxBytes: config.maxBytes, phase: path.basename(phaseDir) });
      omitted = rendered.omitted;
      const conflictsDoc = {
        schema: REPORT_SCHEMA,
        phase: phaseRel,
        status: block.status,
        reasons: block.reasons,
        conflicts: loadedOrders.orders.conflicts.map((c) => ({ ...c, applicable: Array.isArray(c.orders) && c.orders.some((id) => applicableSet.has(id)) })),
        missingChecks: loadedOrders.orders.missingChecks.map((m) => ({ ...m, applicable: applicableSet.has(m.id) })),
        errors: loadedOrders.orders.errors,
        warnings,
      };
      put(APPLICABLE_PATH, rendered.text);
      put(CONFLICTS_PATH, JSON.stringify(conflictsDoc, null, 2) + '\n');
      put(verdictRel, verdictText(STATUS.PENDING, 'select'));
    } else if (subcommand === 'coverage') {
      put(verdictRel, verdictText(cov.status, 'coverage'));
    }
  } catch (e) {
    if (subcommand === 'coverage') {
      try {
        writeAtomic(io, path.resolve(root, verdictRel), verdictText(STATUS.ERROR, 'coverage'), seq++);
      } catch (e2) {
        // the verdict could not be written at all; the failure below still reports it
      }
    }
    return loopFailure(subcommand, 'write_failed', `${subcommand}: could not write output: ${errMessage(e)}`, written, error);
  }

  const result = {
    schema: REPORT_SCHEMA,
    subcommand,
    ok: true,
    disabled: false,
    phase: { dir: phaseRel, reqIds },
    conflicts: block.status,
    coverage: coverageStatus,
    reasons,
    applicable: applicableIds,
    omitted,
    uncited,
    unrelatedConflicts: block.unrelatedConflicts,
    errors: loadedOrders.orders.errors,
    warnings,
    written,
  };
  emit(result);
  return result;
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
  const io = { ...defaultDeps(), ...deps };
  const subcommand = args[1];
  if (LOOP_SUBCOMMANDS.includes(subcommand)) {
    try {
      return runLoopCommand({ subcommand, rest: args.slice(2), cwd, raw, error, io });
    } catch (e) {
      const message = `${FAMILY} ${subcommand}: internal error: ${errMessage(e)}`;
      error(message);
      return { schema: REPORT_SCHEMA, subcommand, ok: false, errors: [{ code: 'internal_error', message }], written: [] };
    }
  }
  if (subcommand !== 'validate') {
    const msg = subcommand
      ? `${FAMILY}: unknown subcommand ${JSON.stringify(subcommand)}. Available: ${SUBCOMMANDS.join(', ')}`
      : `${FAMILY}: no subcommand given. Available: ${SUBCOMMANDS.join(', ')}`;
    error(msg);
    return { ok: false, error: msg };
  }

  const rest = args.slice(2);
  const unknownFlag = rest.find((a) => typeof a === 'string' && a.startsWith('-') && a !== '--raw');
  if (unknownFlag !== undefined) {
    const msg = `${FAMILY} validate: unknown flag ${JSON.stringify(unknownFlag)}. Usage: standing-orders validate [file] [--raw]`;
    error(msg);
    return { ok: false, error: msg };
  }
  const rawOut = raw === true || rest.includes('--raw');
  const positionals = rest.filter((a) => typeof a === 'string' && a !== '--raw');
  const fileArg = positionals.length > 0 ? positionals[0] : DEFAULT_ORDERS_PATH;

  const report = validateFile({ cwd, fileArg, deps: io });
  if (report.errors.some((e) => e.code === ERROR_CODES.PATH_OUTSIDE_CWD)) {
    error(report.errors[0].message);
  }
  if (rawOut) io.log(JSON.stringify(report));
  else for (const l of humanLines(report)) io.log(l);
  return report;
}

/** Exit code for the direct CLI: 0 ok; 2 the file could not be read; 1 otherwise. */
function exitCodeFor(report) {
  if (LOOP_SUBCOMMANDS.includes(report.subcommand)) {
    if (report.ok === false) return Array.isArray(report.errors) && report.errors.some((e) => e.code === 'usage') ? 1 : 2;
    if (report.disabled === true) return 0;
    if (report.conflicts === STATUS.BLOCKED || report.coverage === STATUS.INCOMPLETE || report.coverage === STATUS.ERROR) return 1;
    return 0;
  }
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

module.exports = { routeStandingOrdersCommand, validateFile, exitCodeFor, isInside, loadOrders, DEFAULT_ORDERS_PATH, APPLICABLE_PATH, CONFLICTS_PATH, MAX_FILE_BYTES, SUBCOMMANDS, REPORT_SCHEMA };
