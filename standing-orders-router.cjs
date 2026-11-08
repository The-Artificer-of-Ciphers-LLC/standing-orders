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
 * Subcommands: `validate` (phase 1), the loop wiring `select`, `conflicts` and
 * `coverage` (phase 2), the execution gate `enforce` (phase 3) and the
 * traceability ledger `trace`, `impact` and `stale` (phase 4), and the authoring
 * commands `promote` and `semantic` (phase 5) and `mutants` (phase 6). The same verbs are reachable directly:
 *   node standing-orders-router.cjs validate [file] [--raw]
 *   node standing-orders-router.cjs select|conflicts|coverage|enforce|trace (--phase <n> | --phase-dir <dir>) [--req-ids <ids>] [--files <list>] [--raw]
 *   node standing-orders-router.cjs impact <order-id> [--raw]
 *   node standing-orders-router.cjs stale [--raw]
 *   node standing-orders-router.cjs promote (--candidates (--phase <n> | --phase-dir <dir>) | --add <order-json>) [--raw]
 *   node standing-orders-router.cjs semantic propose|resolve|list (--phase <n> | --phase-dir <dir>) [--findings <json>] [--id <S-n> --status <s> [--reason <text>]] [--auto] [--raw]
 *   node standing-orders-router.cjs mutants (--order <id> | --add <json> | --run --order <id> [--no-cache]) [--raw]
 * Exit codes (direct CLI only): 0 ok; 1 invalid, blocked, incomplete, stale or
 * usage error; 2 a file or directory could not be read or resolved.
 *
 * `deps` is a test seam for I/O: { exists, isFile, realpath, statSize, readFile,
 * listDir, writeFile, appendFile, rename, mkdir, execFile, env, argv, nodePath,
 * now, log }.
 */

const fs = require('node:fs');
const path = require('node:path');

const { parseOrders, ERROR_CODES, KINDS, VERIFICATIONS } = require('./lib/orders.cjs');
const { detectConflicts } = require('./lib/conflicts.cjs');
const { readCapabilityConfig } = require('./lib/config.cjs');
const { collectPhaseInputs, splitReqIds } = require('./lib/phase.cjs');
const { resolvePhase, runEnforcement, findHostCli, HOST_TIMEOUT_MS } = require('./lib/host.cjs');
const { evaluateBlock, evaluateCoverage, evaluateEnforcement, renderVerdict, STATUS } = require('./lib/gate.cjs');
const { selectApplicable, renderApplicable, normalizePath } = require('./lib/select.cjs');
const { errMessage, unique, isPlainObject, compareStrings } = require('./lib/util.cjs');
const { orderHash, TRACE_PATH, MAX_TRACE_BYTES, isValidPhase, buildRecords, parseTrace, newRecords, appendText, impactOf, staleOf } = require('./lib/trace.cjs');
const { MAX_PHASE_FILE_BYTES, PROMOTE_CODES, isSpecFileName, isContextFileName, buildCandidates, parseAddArgument, promoteOrder } = require('./lib/promote.cjs');
const {
  SEMANTIC_FILE,
  MAX_SEMANTIC_BYTES,
  FINDING_STATUSES,
  SEMANTIC_CODES,
  emptyDocument,
  parseSemantic,
  proposeFindings,
  resolveFinding,
  countFindings,
  serializeSemantic,
} = require('./lib/semantic.cjs');
const mutantsLib = require('./lib/mutants.cjs');

const FAMILY = 'standing-orders';
const SUBCOMMANDS = Object.freeze(['select', 'conflicts', 'coverage', 'enforce', 'trace', 'impact', 'stale', 'validate', 'promote', 'semantic', 'mutants']);
const LOOP_SUBCOMMANDS = Object.freeze(['select', 'conflicts', 'coverage', 'enforce', 'trace']);
const QUERY_SUBCOMMANDS = Object.freeze(['impact', 'stale']);
const AUTHORING_SUBCOMMANDS = Object.freeze(['promote', 'semantic', 'mutants']);
/** Upper bound for the one `git log` call that names the code commit a trace belongs to. */
const GIT_TIMEOUT_MS = 10000;
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;
const EM_DASH = String.fromCharCode(0x2014);
const APPLICABLE_PATH = '.planning/standing-orders/APPLICABLE.md';
const CONFLICTS_PATH = '.planning/standing-orders/CONFLICTS.json';
const ENFORCEMENT_PATH = '.planning/standing-orders/ENFORCEMENT.json';
const VERDICT_NAME = 'STANDING-ORDERS.md';
const DISABLED_MESSAGE = 'standing-orders is not enabled; set standing-orders.enabled to true';
const DEFAULT_ORDERS_PATH = path.join('.planning', 'standing-orders', 'ORDERS.yaml');
/** Refuse to read a rules file larger than this (bytes) — a rules file is small by nature. */
const MAX_FILE_BYTES = 256 * 1024;
const REPORT_SCHEMA = 1;
/** Refuse to read an ENFORCEMENT.json larger than this (bytes). */
const MAX_ENFORCEMENT_BYTES = 16 * 1024 * 1024;

/** Every error code the loop subcommands (select, conflicts, coverage, enforce) emit themselves. */
const LOOP_CODES = Object.freeze({
  USAGE: 'usage',
  PATH_OUTSIDE_CWD: 'path_outside_cwd',
  PHASE_DIR_NOT_FOUND: 'phase_dir_not_found',
  WRITE_FAILED: 'write_failed',
  INTERNAL_ERROR: 'internal_error',
  ORDERS_FILE_MISSING: 'orders_file_missing',
  ORDERS_UNUSABLE: 'orders_unusable',
  TRACE_TOO_LARGE: 'trace_too_large',
  TRACE_UNREADABLE: 'trace_unreadable',
  TRACE_NOT_REGULAR: 'trace_not_regular',
  PHASE_NAME_INVALID: 'phase_name_invalid',
});

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
    isSymlink: (p) => {
      try {
        return fs.lstatSync(p).isSymbolicLink();
      } catch (e) {
        if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return false;
        throw e;
      }
    },
    listDir: (p) => fs.readdirSync(p),
    writeFile: (p, text) => fs.writeFileSync(p, text, { flag: 'wx' }),
    appendFile: (p, text) => fs.appendFileSync(p, text),
    now: () => new Date(),
    rename: (from, to) => fs.renameSync(from, to),
    unlink: (p) => fs.unlinkSync(p),
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
    return fail(ERROR_CODES.FILE_UNREADABLE, `${toSlashes(fileArg)} could not be examined: ${errMessage(e)}`);
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
    return fail(ERROR_CODES.FILE_UNREADABLE, `${toSlashes(fileArg)} could not be read: ${errMessage(e)}`);
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

// ─── Loop subcommands: select, conflicts, coverage, enforce ───────────────────

// `--ws` is part of the host contract (the dispatcher forwards it): accepted and ignored.
const VALUE_FLAGS = new Set(['--phase', '--phase-dir', '--req-ids', '--files', '--ws']);

/** Parse the loop flags. Returns { options } or { usage: message }. */
function parseLoopFlags(subcommand, rest) {
  const options = { phase: null, phaseDir: null, reqIds: null, files: null, raw: false, noCache: false };
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
    if (a === '--no-cache' && subcommand === 'enforce') {
      options.noCache = true;
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
    return { code: LOOP_CODES.PATH_OUTSIDE_CWD, message: `phase directory ${toSlashes(phaseDir)} resolves outside the project root ${toSlashes(root)}` };
  }
  if (!io.exists(phaseDir)) return { code: LOOP_CODES.PHASE_DIR_NOT_FOUND, message: `phase directory ${toSlashes(path.relative(root, phaseDir))} does not exist` };
  let realRoot;
  let realDir;
  try {
    realRoot = io.realpath(root);
    realDir = io.realpath(phaseDir);
  } catch (e) {
    return { code: LOOP_CODES.PHASE_DIR_NOT_FOUND, message: `phase directory could not be examined: ${errMessage(e)}` };
  }
  if (!isInside(realRoot, realDir)) {
    return { code: LOOP_CODES.PATH_OUTSIDE_CWD, message: `phase directory ${toSlashes(path.relative(root, phaseDir))} resolves (through a link) outside the project root` };
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
      warnings.push({ code: LOOP_CODES.ORDERS_FILE_MISSING, message: first.message });
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
  if (result.enforcement !== null) parts.push(`enforcement ${result.enforcement}`);
  const lines = [`standing-orders ${result.subcommand}: phase ${result.phase.dir} — ${parts.join(', ')}: ${result.applicable.length} applicable`];
  for (const r of result.reasons) lines.push(`  ${r.code}: ${r.message}`);
  return lines;
}

function loopFailure(subcommand, code, message, written, error) {
  error(message);
  return { schema: REPORT_SCHEMA, subcommand, ok: false, errors: [{ code, message }], written };
}

/** Resolve the phase directory (and the host's requirement ids) from the parsed flags. */
function resolvePhaseDir({ options, root, io }) {
  if (options.phaseDir !== null) return { ok: true, phaseDir: path.resolve(root, options.phaseDir), reqIds: [] };
  const resolved = resolvePhase({ phase: options.phase, cwd: root, env: io.env, argv: io.argv, deps: io });
  if (!resolved.ok) return { ok: false, code: resolved.code, message: resolved.message };
  return { ok: true, phaseDir: resolved.phaseDir, reqIds: resolved.reqIds };
}

/** Everything the loop subcommands derive from the phase and ORDERS.yaml, before any write. */
function evaluateLoop({ subcommand, options, root, phaseDir, reqIds, config, io }) {
  const phaseRel = toSlashes(path.relative(root, phaseDir));
  const loadedOrders = ordersForGate(root, io);
  const inputs = collectPhaseInputs({ phaseDir, deps: io });
  const extraFiles = options.files === null ? [] : options.files.split(',').map((p) => p.trim()).filter((p) => p !== '').map(normalizePath);
  const selection = {
    files: unique([...inputs.files, ...extraFiles]),
    requirements: unique([...reqIds, ...inputs.planRequirements]),
  };
  const applicable = selectApplicable(loadedOrders.document, selection);
  const applicableIds = applicable.map((o) => o.id);
  const block = evaluateBlock({ orders: loadedOrders.orders, applicableIds, blockOn: config.blockOn });

  let coverageStatus = subcommand === 'select' ? STATUS.PENDING : null;
  let reasons = block.reasons;
  let cov = null;
  if (subcommand === 'coverage' || subcommand === 'enforce') {
    cov = evaluateCoverage({
      applicableIds,
      applicable,
      ordersTotal: loadedOrders.document ? loadedOrders.document.orders.length : 0,
      plans: inputs.plans,
    });
    coverageStatus = cov.status;
    reasons = [...block.reasons, ...cov.reasons];
  }
  return {
    phaseDir,
    phaseRel,
    reqIds,
    noCache: options.noCache === true,
    loadedOrders,
    inputs,
    files: selection.files,
    stale: Object.create(null),
    staleIds: [],
    traceWarnings: [],
    applicable,
    applicableIds,
    block,
    warnings: [...config.warnings, ...loadedOrders.warnings, ...inputs.warnings],
    verdictRel: `${phaseRel}/${VERDICT_NAME}`,
    coverageStatus,
    reasons,
    uncited: cov ? cov.uncited : [],
    notProjected: cov ? cov.notProjected : [],
    checkFileEdits: cov ? cov.checkFileEdits : [],
    cov,
  };
}

function verdictText(ev, coverage, generatedBy, enforcement = STATUS.PENDING, reasons = ev.reasons) {
  return renderVerdict({
    phase: path.basename(ev.phaseDir),
    conflicts: ev.block.status,
    coverage,
    enforcement,
    generatedBy,
    applicableIds: ev.applicableIds,
    reasons,
  });
}

/** APPLICABLE.md text; says so plainly when ORDERS.yaml could not be used, rather than listing nothing. */
function applicableText(ev, config) {
  const phase = path.basename(ev.phaseDir);
  const rendered = renderApplicable(ev.applicable, { maxBytes: config.maxBytes, phase, stale: ev.stale });
  const state = ev.loadedOrders.orders.state;
  if (state !== 'invalid' && state !== 'unreadable') return rendered;
  const empty = renderApplicable([], { maxBytes: Infinity, phase }).text;
  const footerAt = empty.lastIndexOf('0 applicable order(s) omitted');
  const notice = `ORDERS.yaml could not be used (${state}): planning is blocked until it is fixed. Run standing-orders validate.\n`;
  return { text: empty.slice(0, footerAt) + notice + empty.slice(footerAt), omitted: [] };
}

/** Make sure the output directory exists and stays inside the project. Returns a failure or null. */
function prepareOutputDir({ subcommand, root, io }) {
  const soDir = path.resolve(root, path.dirname(APPLICABLE_PATH));
  try {
    io.mkdir(soDir);
    if (!isInside(io.realpath(root), io.realpath(soDir))) {
      return { code: LOOP_CODES.PATH_OUTSIDE_CWD, message: `${toSlashes(path.dirname(APPLICABLE_PATH))} resolves (through a link) outside the project root` };
    }
  } catch (e) {
    return { code: LOOP_CODES.WRITE_FAILED, message: `${subcommand}: could not prepare output directory: ${errMessage(e)}` };
  }
  return null;
}

/**
 * `select` writes the verdict FIRST (coverage pending) so a later failure can
 * never leave a stale `coverage: complete`, then APPLICABLE.md, then CONFLICTS.json.
 */
function writeSelectOutputs({ ev, config, put }) {
  put(ev.verdictRel, verdictText(ev, STATUS.PENDING, 'select'));
  const rendered = applicableText(ev, config);
  put(APPLICABLE_PATH, rendered.text);
  const applicableSet = new Set(ev.applicableIds);
  const orders = ev.loadedOrders.orders;
  const conflictsDoc = {
    schema: REPORT_SCHEMA,
    phase: ev.phaseRel,
    status: ev.block.status,
    reasons: ev.block.reasons,
    conflicts: orders.conflicts.map((c) => ({ ...c, applicable: Array.isArray(c.orders) && c.orders.some((id) => applicableSet.has(id)) })),
    missingChecks: orders.missingChecks.map((m) => ({ ...m, applicable: applicableSet.has(m.id) })),
    errors: orders.errors,
    warnings: ev.warnings,
  };
  put(CONFLICTS_PATH, JSON.stringify(conflictsDoc, null, 2) + '\n');
  return rendered.omitted;
}

function writeCoverageOutputs({ ev, put }) {
  put(ev.verdictRel, verdictText(ev, ev.cov.status, 'coverage'));
}

/**
 * Run the host prover for every applicable `test` order. An unusable ORDERS.yaml
 * runs nothing and reports `error`; no applicable test order reports `clear`.
 */
function evaluateEnforce({ ev, root, io }) {
  const state = ev.loadedOrders.orders.state;
  if (state === 'invalid' || state === 'unreadable') return { status: STATUS.ERROR, results: [], reasons: [], cache: null };
  const tests = ev.applicable.filter((o) => o.verification === 'test');
  const hasMutants = tests.some((o) => Array.isArray(o.check_mutants) && o.check_mutants.length > 0);
  let entries = hasMutants ? mutantsLib.readCache({ root, io }) : {};
  let dirty = false;
  const results = tests.map((order) => {
    const base = runEnforcement({ order, cwd: root, env: io.env, argv: io.argv, deps: io });
    const applied = mutantsLib.applyMutants({ order, base, root, io, entries, useCache: !ev.noCache, ts: io.now().toISOString() });
    entries = applied.entries;
    if (applied.changed) dirty = true;
    return applied.result;
  });
  const verdict = evaluateEnforcement({ results });
  return { status: verdict.status, results, reasons: verdict.reasons, cache: dirty ? entries : null };
}

/**
 * `enforce` writes the verdict FIRST (enforcement pending) so a crash can never
 * leave a stale `clear`, then runs the checks, then ENFORCEMENT.json, then the
 * final verdict. Returns the enforcement outcome; throws if a final write fails.
 */
function runEnforce({ ev, root, io, put, rewriteVerdict }) {
  put(ev.verdictRel, verdictText(ev, ev.coverageStatus, 'enforce', STATUS.PENDING));
  const enforced = evaluateEnforce({ ev, root, io });
  try {
    put(ENFORCEMENT_PATH, JSON.stringify({ schema: REPORT_SCHEMA, phase: ev.phaseRel, status: enforced.status, results: enforced.results }, null, 2) + '\n');
    if (enforced.cache) put(mutantsLib.MUTANTS_PATH, mutantsLib.serializeCache(enforced.cache));
    put(ev.verdictRel, verdictText(ev, ev.coverageStatus, 'enforce', enforced.status, [...ev.reasons, ...enforced.reasons]));
  } catch (e) {
    rewriteVerdict(STATUS.ERROR);
    throw e;
  }
  return enforced;
}

function loopEnforcement(subcommand, enforced) {
  if (subcommand === 'enforce') return enforced.status;
  return subcommand === 'conflicts' ? null : STATUS.PENDING;
}

function buildLoopResult({ subcommand, ev, omitted, written, enforced }) {
  const result = {
    schema: REPORT_SCHEMA,
    subcommand,
    ok: true,
    disabled: false,
    phase: { dir: ev.phaseRel, reqIds: ev.reqIds },
    conflicts: ev.block.status,
    coverage: ev.coverageStatus,
    enforcement: loopEnforcement(subcommand, enforced),
    reasons: subcommand === 'enforce' ? [...ev.reasons, ...enforced.reasons] : ev.reasons,
    applicable: ev.applicableIds,
    omitted,
    uncited: ev.uncited,
    notProjected: ev.notProjected,
    checkFileEdits: ev.checkFileEdits,
    unrelatedConflicts: ev.block.unrelatedConflicts,
    errors: ev.loadedOrders.orders.errors,
    warnings: ev.warnings,
    written,
  };
  if (subcommand === 'enforce') result.results = enforced.results;
  if (subcommand === 'select') {
    result.stale = ev.staleIds;
    result.warnings = [...ev.warnings, ...ev.traceWarnings];
  }
  return result;
}

/** Rewrite the verdict after a failed write; the original failure is what gets reported, so this never throws. */
function bestEffortVerdict({ ev, io, root, generatedBy, coverage = ev.coverageStatus, enforcement = STATUS.PENDING, seq }) {
  try {
    writeAtomic(io, path.resolve(root, ev.verdictRel), verdictText(ev, coverage, generatedBy, enforcement), seq);
  } catch (e) {
    // the verdict could not be written at all; the failure reported by the caller still names it
  }
}

// ─── Traceability ledger: trace, impact, stale ────────────────────────────────

function traceProblem(code, message) {
  return { failure: { code, message } };
}

/** A failure when the ledger path is a symbolic link (dangling, in the project or outside it), else null. */
function ledgerLinkProblem(abs, io) {
  try {
    if (io.isSymlink(abs)) return traceProblem(LOOP_CODES.TRACE_NOT_REGULAR, `${TRACE_PATH} is a symbolic link; the ledger must be a regular file`);
  } catch (e) {
    return traceProblem(LOOP_CODES.TRACE_UNREADABLE, `${TRACE_PATH} could not be examined: ${errMessage(e)}`);
  }
  return null;
}

/** Text of a dep result that may be undefined or null. */
function outputText(out) {
  return out === undefined || out === null ? '' : String(out);
}

/**
 * Read TRACE.jsonl under `root` with the same containment and size guards as every
 * other file the router reads. A missing ledger is empty text, not a failure.
 * @returns {{ text: string } | { failure: { code: string, message: string } }}
 */
function readTraceFile({ root, io }) {
  const abs = path.resolve(root, TRACE_PATH);
  const linked = ledgerLinkProblem(abs, io);
  if (linked !== null) return linked;
  if (!io.exists(abs)) return { text: '' };
  let realFile;
  try {
    realFile = io.realpath(abs);
    if (!isInside(io.realpath(root), realFile)) {
      return traceProblem(LOOP_CODES.PATH_OUTSIDE_CWD, `${TRACE_PATH} resolves (through a link) outside the project root`);
    }
  } catch (e) {
    return traceProblem(LOOP_CODES.TRACE_UNREADABLE, `${TRACE_PATH} could not be examined: ${errMessage(e)}`);
  }
  let size;
  try {
    size = io.statSize(realFile);
  } catch (e) {
    return traceProblem(LOOP_CODES.TRACE_UNREADABLE, `${TRACE_PATH} could not be examined: ${errMessage(e)}`);
  }
  if (typeof size !== 'number' || !Number.isFinite(size)) return traceProblem(LOOP_CODES.TRACE_UNREADABLE, `${TRACE_PATH} has no readable size`);
  if (size > MAX_TRACE_BYTES) return traceProblem(LOOP_CODES.TRACE_TOO_LARGE, `${TRACE_PATH} is ${size} bytes; the limit is ${MAX_TRACE_BYTES}`);
  try {
    return { text: String(io.readFile(abs)) };
  } catch (e) {
    return traceProblem(LOOP_CODES.TRACE_UNREADABLE, `${TRACE_PATH} could not be read: ${errMessage(e)}`);
  }
}

/**
 * ENFORCEMENT.json as an object, or null when it is missing, a symbolic link, outside the
 * project, oversized, unreadable or not an object. Any problem means "unenforced", never an error.
 */
function readEnforcement({ root, io }) {
  const abs = path.resolve(root, ENFORCEMENT_PATH);
  try {
    if (io.isSymlink(abs) || !io.exists(abs)) return null;
    const realFile = io.realpath(abs);
    if (!isInside(io.realpath(root), realFile)) return null;
    const size = io.statSize(realFile);
    if (typeof size !== 'number' || !(size <= MAX_ENFORCEMENT_BYTES)) return null;
    const parsed = JSON.parse(String(io.readFile(abs)));
    return isPlainObject(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

/** The last code commit (the ledger's own commits excluded), or null plus a `commit_unresolved` warning. */
/** First non-blank line of a failure's message, so a subprocess error stays one line. */
function firstErrorLine(e) {
  const line = String(errMessage(e)).split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '');
  return line === undefined ? 'unknown error' : line;
}

function resolveCommitSha({ root, io }) {
  const unresolved = (detail) => ({ sha: null, warning: { code: 'commit_unresolved', message: `the code commit could not be resolved (${detail}); records carry commit_sha null` } });
  let out;
  try {
    out = io.execFile('git', ['log', '-1', '--format=%H', '--', '.', `:(exclude)${TRACE_PATH}`], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  } catch (e) {
    return unresolved(firstErrorLine(e));
  }
  const sha = outputText(out).trim();
  return COMMIT_SHA_RE.test(sha) ? { sha, warning: null } : unresolved('git printed no commit id');
}

function notCommitted(reason) {
  return {
    commit: { committed: false, hash: null, reason },
    warning: { code: 'trace_not_committed', message: `TRACE.jsonl was written but not committed: ${reason}` },
  };
}

/** Parse the host commit tool's JSON answer (following an `@file:` pointer), or null. */
function parseHostAnswer(out, io) {
  let text = outputText(out).trim();
  try {
    if (text.startsWith('@file:')) text = String(io.readFile(text.slice('@file:'.length))).trim();
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

/** Commit TRACE.jsonl through the host's commit tool. Never throws; a failure is a warning, not an error. */
function commitTrace({ phaseDir, root, io }) {
  const cli = findHostCli({ env: io.env, argv: io.argv, isFile: io.isFile });
  if (cli === null) return notCommitted('host_unavailable: the host CLI (gsd-tools) was not found');
  const message = `docs(standing-orders): trace ${path.basename(phaseDir)} [standing-orders trace]`;
  let out;
  try {
    out = io.execFile(io.nodePath, [cli, 'commit', message, '--files', TRACE_PATH], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: HOST_TIMEOUT_MS,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    return notCommitted(`host_failed: ${firstErrorLine(e)}`);
  }
  const answer = parseHostAnswer(out, io);
  if (answer === null) return notCommitted('host_output_invalid: the host commit output is not a JSON object');
  if (answer.committed === true) return { commit: { committed: true, hash: typeof answer.hash === 'string' ? answer.hash : null, reason: null }, warning: null };
  if (answer.skipped === true) return notCommitted(typeof answer.reason === 'string' && answer.reason !== '' ? answer.reason : 'skipped by the host');
  return notCommitted('host_declined: the host did not commit');
}

function humanTraceLines(result) {
  const hash = result.commit.hash === null ? 'none' : result.commit.hash;
  const lines = [`standing-orders trace: phase ${result.phase.dir} ${EM_DASH} ${result.appended.length} record(s) appended, ${result.skipped.length} already traced; commit ${hash}`];
  for (const w of result.warnings) lines.push(`  ${w.code}: ${w.message}`);
  return lines;
}

function traceResult({ ev, appended, skipped, commitSha, commit, warnings, written }) {
  return {
    schema: REPORT_SCHEMA,
    subcommand: 'trace',
    ok: true,
    disabled: false,
    phase: { dir: ev.phaseRel, reqIds: ev.reqIds },
    applicable: ev.applicableIds,
    appended,
    skipped,
    commit_sha: commitSha,
    commit,
    warnings,
    written,
  };
}

/** Append the new ledger records and commit them. Writes only TRACE.jsonl. */
function appendAndCommit({ ev, root, io, records, warnings, commitSha, error }) {
  const none = { committed: false, hash: null, reason: null };
  const unusable = prepareOutputDir({ subcommand: 'trace', root, io });
  if (unusable !== null) return loopFailure('trace', unusable.code, unusable.message, [], error);
  const existing = readTraceFile({ root, io });
  if (existing.failure !== undefined) return loopFailure('trace', existing.failure.code, existing.failure.message, [], error);
  const parsed = parseTrace(existing.text);
  const diff = newRecords(parsed.records, records);
  const all = [...warnings, ...parsed.warnings];
  const ids = diff.append.map((r) => r.order_id);
  if (diff.append.length === 0) return traceResult({ ev, appended: [], skipped: diff.skipped, commitSha, commit: none, warnings: all, written: [] });
  const target = path.resolve(root, TRACE_PATH);
  const relinked = ledgerLinkProblem(target, io);
  if (relinked !== null) return loopFailure('trace', relinked.failure.code, relinked.failure.message, [], error);
  try {
    io.appendFile(target, appendText(existing.text, diff.append));
  } catch (e) {
    return loopFailure('trace', LOOP_CODES.WRITE_FAILED, `trace: could not write ${TRACE_PATH}: ${errMessage(e)}`, [], error);
  }
  const committed = commitTrace({ phaseDir: ev.phaseDir, root, io });
  if (committed.warning !== null) all.push(committed.warning);
  return traceResult({ ev, appended: ids, skipped: diff.skipped, commitSha, commit: committed.commit, warnings: all, written: [TRACE_PATH] });
}

/** `trace`: record every applicable order in TRACE.jsonl (append-only, de-duplicated) and commit it. */
function runTrace({ ev, root, io, error }) {
  const state = ev.loadedOrders.orders.state;
  if (state === 'invalid' || state === 'unreadable') {
    return loopFailure('trace', LOOP_CODES.ORDERS_UNUSABLE, `trace: ORDERS.yaml could not be used (${state}); run standing-orders validate`, [], error);
  }
  const warnings = [...ev.warnings];
  if (ev.applicable.length === 0) {
    return traceResult({ ev, appended: [], skipped: [], commitSha: null, commit: { committed: false, hash: null, reason: null }, warnings, written: [] });
  }
  if (!isValidPhase(ev.phaseRel)) {
    return loopFailure('trace', LOOP_CODES.PHASE_NAME_INVALID, `trace: phase directory ${JSON.stringify(ev.phaseRel)} cannot be recorded; use letters, digits, ".", "_", "-" and "/" only (at most 200 characters, no "..")`, [], error);
  }
  const git = resolveCommitSha({ root, io });
  if (git.warning !== null) warnings.push(git.warning);
  const records = buildRecords({
    applicable: ev.applicable,
    document: ev.loadedOrders.document,
    phaseRel: ev.phaseRel,
    plans: ev.inputs.plans,
    files: ev.files,
    enforcement: readEnforcement({ root, io }),
    commitSha: git.sha,
    ts: io.now().toISOString(),
  });
  return appendAndCommit({ ev, root, io, records, warnings, commitSha: git.sha, error });
}

/** Print a trace result (a failure was already reported through `error`). */
function emitTrace({ result, rawOut, io }) {
  if (result.ok === false) return result;
  if (rawOut) io.log(JSON.stringify(result));
  else for (const l of humanTraceLines(result)) io.log(l);
  return result;
}

/** For `select`: mark the applicable orders whose latest trace is stale. A bad ledger only adds a warning. */
function attachStale(ev, root, io) {
  const document = ev.loadedOrders.document;
  const trace = readTraceFile({ root, io });
  if (trace.failure !== undefined) {
    ev.traceWarnings.push({ code: LOOP_CODES.TRACE_UNREADABLE, message: `${trace.failure.message}; stale orders are not marked` });
    return;
  }
  if (document === null) return;
  const applicable = new Set(ev.applicableIds);
  for (const s of staleOf({ records: parseTrace(trace.text).records, document })) {
    if (!applicable.has(s.id)) continue;
    ev.stale[s.id] = { reason: s.reason, last_phase: s.last_phase };
  }
  ev.staleIds = Object.keys(ev.stale).sort(compareStrings);
}

/** Parse `impact <id>` / `stale` arguments. Returns { options } or { usage: message }. */
function parseQueryFlags(subcommand, rest) {
  const usageText = subcommand === 'impact' ? 'Usage: standing-orders impact <order-id> [--raw]' : 'Usage: standing-orders stale [--raw]';
  const options = { id: null };
  const positionals = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (typeof a !== 'string') return { usage: `${FAMILY} ${subcommand}: unexpected argument ${JSON.stringify(a)}. ${usageText}` };
    if (a === '--raw') continue;
    if (a === '--ws') {
      const value = rest[i + 1];
      if (typeof value !== 'string' || value.startsWith('-')) return { usage: `${FAMILY} ${subcommand}: flag ${a} needs a value. ${usageText}` };
      i += 1;
    } else if (a.startsWith('-')) return { usage: `${FAMILY} ${subcommand}: unknown flag ${JSON.stringify(a)}. ${usageText}` };
    else positionals.push(a);
  }
  if (positionals.length !== (subcommand === 'impact' ? 1 : 0)) return { usage: `${FAMILY} ${subcommand}: wrong number of arguments. ${usageText}` };
  options.id = positionals.length > 0 ? positionals[0] : null;
  return { options };
}

function humanPhaseLine(p) {
  const list = (xs) => (Array.isArray(xs) && xs.length > 0 ? xs.join(', ') : '-');
  const commit = typeof p.commit_sha === 'string' && p.commit_sha !== '' ? p.commit_sha.slice(0, 7) : 'none';
  return `  ${p.phase}: ${p.disposition}${p.hash_mismatch === true ? ', order changed since' : ''}; commit ${commit}; plans ${list(p.plans)}; files ${list(p.files)}`;
}

function humanQueryLines(result) {
  if (result.subcommand === 'stale') {
    const lines = [`standing-orders stale: ${result.stale.length} stale order(s)`];
    for (const s of result.stale) lines.push(`  ${s.id}: ${s.reason} since last traced in ${s.last_phase}`);
    for (const w of result.warnings) lines.push(`  ${w.code}: ${w.message}`);
    return lines;
  }
  const lines = [`standing-orders impact: ${result.id} ${EM_DASH} ${result.status}; ${result.phases.length} phase(s) traced`];
  for (const p of result.phases) lines.push(humanPhaseLine(p));
  for (const w of result.warnings) lines.push(`  ${w.code}: ${w.message}`);
  return lines;
}

/** A failed query: with --raw the failure is also printed as JSON (the host shows only the error text), then reported. */
function queryFailure({ subcommand, code, message, rawOut, io, error }) {
  const result = { schema: REPORT_SCHEMA, subcommand, ok: false, errors: [{ code, message }], written: [] };
  if (rawOut) io.log(JSON.stringify(result));
  error(message);
  return result;
}

/** The document a query compares the ledger with: a MISSING ORDERS.yaml is an empty one (every traced order is removed); an unusable one is null. */
function queryDocument(loaded) {
  if (loaded.stage === 'ok') return loaded.document;
  const first = loaded.report.errors[0];
  if (loaded.stage === 'file' && first && first.code === ERROR_CODES.FILE_NOT_FOUND) return { orders: [], contexts: {}, leafSets: {}, allLeaves: [] };
  return null;
}

/** `impact <id>` and `stale`: read-only queries over TRACE.jsonl and ORDERS.yaml; not gated on `enabled`. */
function runQueryCommand({ subcommand, rest, cwd, raw, error, io }) {
  const rawOut = raw === true || rest.includes('--raw');
  const fail = (code, message) => queryFailure({ subcommand, code, message, rawOut, io, error });
  const parsed = parseQueryFlags(subcommand, rest);
  if (parsed.usage !== undefined) return fail(LOOP_CODES.USAGE, parsed.usage);
  const root = path.resolve(cwd);
  const loaded = loadOrders({ cwd: root, fileArg: DEFAULT_ORDERS_PATH, deps: io });
  const document = queryDocument(loaded);
  const trace = readTraceFile({ root, io });
  if (trace.failure !== undefined) return fail(trace.failure.code, trace.failure.message);
  const ledger = parseTrace(trace.text);
  let result;
  if (subcommand === 'impact') {
    result = { schema: REPORT_SCHEMA, subcommand, ok: true, ...impactOf({ id: parsed.options.id, records: ledger.records, document }), warnings: ledger.warnings };
  } else {
    if (document === null) return fail(LOOP_CODES.ORDERS_UNUSABLE, 'stale: ORDERS.yaml could not be used; run standing-orders validate');
    result = { schema: REPORT_SCHEMA, subcommand, ok: true, stale: staleOf({ records: ledger.records, document }), warnings: ledger.warnings };
  }
  if (rawOut) io.log(JSON.stringify(result));
  else for (const l of humanQueryLines(result)) io.log(l);
  return result;
}

function runLoopCommand({ subcommand, rest, cwd, raw, error, io }) {
  const parsed = parseLoopFlags(subcommand, rest);
  if (parsed.usage !== undefined) return loopFailure(subcommand, LOOP_CODES.USAGE, parsed.usage, [], error);
  const options = parsed.options;
  const rawOut = raw === true || options.raw;

  const root = path.resolve(cwd);
  const config = readCapabilityConfig({ cwd: root, env: io.env, readFile: io.readFile, statSize: io.statSize });
  if (!config.enabled) {
    const result = { schema: REPORT_SCHEMA, subcommand, ok: true, disabled: true, message: DISABLED_MESSAGE, written: [] };
    io.log(rawOut ? JSON.stringify(result) : DISABLED_MESSAGE);
    return result;
  }

  const phase = resolvePhaseDir({ options, root, io });
  if (!phase.ok) return loopFailure(subcommand, phase.code, phase.message, [], error);
  const bad = containPhaseDir(root, phase.phaseDir, io);
  if (bad !== null) return loopFailure(subcommand, bad.code, bad.message, [], error);
  const reqIds = options.reqIds !== null ? splitReqIds(options.reqIds) : phase.reqIds;

  const ev = evaluateLoop({ subcommand, options, root, phaseDir: phase.phaseDir, reqIds, config, io });
  if (subcommand === 'trace') return emitTrace({ result: runTrace({ ev, root, io, error }), rawOut, io });
  if (subcommand === 'select') attachStale(ev, root, io);

  if (subcommand === 'select' || subcommand === 'enforce') {
    const unusable = prepareOutputDir({ subcommand, root, io });
    if (unusable !== null) return loopFailure(subcommand, unusable.code, unusable.message, [], error);
  }

  const written = [];
  let seq = 0;
  const put = (rel, text) => {
    writeAtomic(io, path.resolve(root, rel), text, seq++);
    written.push(rel);
  };
  let omitted = [];
  let enforced = null;
  try {
    if (subcommand === 'select') omitted = writeSelectOutputs({ ev, config, put });
    else if (subcommand === 'coverage') writeCoverageOutputs({ ev, put });
    else if (subcommand === 'enforce') {
      const rewriteVerdict = (enforcement) => bestEffortVerdict({ ev, io, root, generatedBy: 'enforce', enforcement, seq: seq++ });
      enforced = runEnforce({ ev, root, io, put, rewriteVerdict });
    }
  } catch (e) {
    if (subcommand === 'coverage') bestEffortVerdict({ ev, io, root, generatedBy: 'coverage', coverage: STATUS.ERROR, seq: seq++ });
    return loopFailure(subcommand, LOOP_CODES.WRITE_FAILED, `${subcommand}: could not write output: ${errMessage(e)}`, written, error);
  }

  const result = buildLoopResult({ subcommand, ev, omitted, written, enforced });
  if (rawOut) io.log(JSON.stringify(result));
  else for (const l of humanLoopLines(result)) io.log(l);
  return result;
}

// ─── Authoring: promote, semantic ─────────────────────────────────────────────

/** Print and return a refusal for promote/semantic: the failure as JSON under --raw, the message through `error`. */
function authoringFailure({ subcommand, code, message, rawOut, io, error, extra = {} }) {
  const result = { schema: REPORT_SCHEMA, subcommand, ok: false, errors: [{ code, message }], written: [], ...extra };
  if (rawOut) io.log(JSON.stringify(result));
  error(message);
  return result;
}

function disabledResult({ subcommand, rawOut, io }) {
  const result = { schema: REPORT_SCHEMA, subcommand, ok: true, disabled: true, message: DISABLED_MESSAGE, written: [] };
  io.log(rawOut ? JSON.stringify(result) : DISABLED_MESSAGE);
  return result;
}

/**
 * Parse flags against an allowed set. A `valued` flag takes one value (never another known flag), a `bare` flag none.
 * Returns { values, flags, adds } or { usage }. A repeated `--add` is counted (the caller refuses it as a batch).
 */
function parseAuthoringFlags(subcommand, rest, { valued, bare, usageText }) {
  const known = new Set([...valued, ...bare, '--raw']);
  const values = {};
  const flags = new Set();
  let adds = 0;
  const usage = (m) => ({ usage: `${FAMILY} ${subcommand}: ${m}. ${usageText}` });
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (typeof a !== 'string' || !a.startsWith('-')) return usage(`unexpected argument ${JSON.stringify(a)}`);
    if (a === '--raw' || bare.includes(a)) {
      flags.add(a);
      continue;
    }
    if (!valued.includes(a)) return usage(`unknown flag ${JSON.stringify(a)}`);
    const value = rest[i + 1];
    if (typeof value !== 'string' || known.has(value)) return usage(`flag ${a} needs a value`);
    i += 1;
    if (a === '--add') adds += 1;
    else if (Object.prototype.hasOwnProperty.call(values, a)) return usage(`flag ${a} was given twice`);
    values[a] = value;
  }
  return { values, flags, adds };
}

/** ORDERS.yaml text for `promote --add`: { text } (null when missing) or { failure }. */
function readOrdersForWrite({ root, io }) {
  const rel = toSlashes(DEFAULT_ORDERS_PATH);
  const abs = path.resolve(root, DEFAULT_ORDERS_PATH);
  const fail = (code, message) => ({ failure: { code, message } });
  try {
    if (!io.exists(abs)) {
      if (io.isSymlink(abs)) return fail(ERROR_CODES.FILE_UNREADABLE, `${rel} is a dangling link`);
      return { text: null };
    }
    const realFile = io.realpath(abs);
    if (!isInside(io.realpath(root), realFile)) return fail(ERROR_CODES.PATH_OUTSIDE_CWD, `${rel} resolves (through a link) outside the project root`);
    const size = io.statSize(realFile);
    if (typeof size !== 'number' || !Number.isFinite(size)) return fail(ERROR_CODES.FILE_UNREADABLE, `${rel} has no readable size`);
    if (size > MAX_FILE_BYTES) return fail(ERROR_CODES.FILE_TOO_LARGE, `${rel} is ${size} bytes; the limit is ${MAX_FILE_BYTES}`);
    return { text: String(io.readFile(abs)) };
  } catch (e) {
    return fail(ERROR_CODES.FILE_UNREADABLE, `${rel} could not be read: ${errMessage(e)}`);
  }
}

/** The phase directory for promote/semantic: { phaseDir, phaseRel } or { failure } (an already reported result). */
function locatePhase({ subcommand, values, root, rawOut, io, error }) {
  const options = { phase: values['--phase'] === undefined ? null : values['--phase'], phaseDir: values['--phase-dir'] === undefined ? null : values['--phase-dir'] };
  const fail = (code, message) => authoringFailure({ subcommand, code, message, rawOut, io, error });
  const phase = resolvePhaseDir({ options, root, io });
  if (!phase.ok) return { failure: fail(phase.code, phase.message) };
  const bad = containPhaseDir(root, phase.phaseDir, io);
  if (bad !== null) return { failure: fail(bad.code, bad.message) };
  return { phaseDir: phase.phaseDir, phaseRel: toSlashes(path.relative(root, phase.phaseDir)) };
}

/** Read the SPEC and CONTEXT files of a phase directory; a file that cannot be used is skipped with a warning. */
function readPhaseFiles({ root, phaseDir, io, warnings }) {
  let names;
  try {
    names = io.listDir(phaseDir).map(String).filter((n) => isSpecFileName(n) || isContextFileName(n)).sort(compareStrings);
  } catch (e) {
    return { failure: { code: LOOP_CODES.PHASE_DIR_NOT_FOUND, message: `phase directory could not be listed: ${errMessage(e)}` } };
  }
  const files = [];
  for (const name of names) {
    const abs = path.join(phaseDir, name);
    const label = toSlashes(path.relative(root, abs));
    const skip = (why) => warnings.push({ code: PROMOTE_CODES.PHASE_FILE_SKIPPED, message: `${label} was skipped: ${why}` });
    try {
      if (!io.isFile(abs)) continue;
      const realFile = io.realpath(abs);
      if (!isInside(io.realpath(root), realFile)) {
        skip('it resolves (through a link) outside the project root');
        continue;
      }
      const size = io.statSize(realFile);
      if (typeof size !== 'number' || !(size <= MAX_PHASE_FILE_BYTES)) {
        skip(`it is larger than ${MAX_PHASE_FILE_BYTES} bytes`);
        continue;
      }
      files.push({ name, label, text: String(io.readFile(abs)) });
    } catch (e) {
      skip(`it could not be read: ${errMessage(e)}`);
    }
  }
  return { files };
}

function warningLines(warnings) {
  return warnings.map((w) => `  warning ${w.code}: ${w.message}`);
}

function humanCandidateLines(result) {
  if (result.candidates.length === 0) {
    return [`standing-orders promote: no candidates found (looked for ${result.looked_for.join(', ')} in ${result.phase_dir})`, ...warningLines(result.warnings)];
  }
  const lines = result.candidates.map((c, i) => `${i + 1}. [${c.origin}] ${c.statement} (${c.source})${c.promoted_as ? ` - already promoted as ${c.promoted_as}` : ''}`);
  if (result.truncated) lines.push('  (list truncated)');
  return [...lines, ...warningLines(result.warnings)];
}

/** `promote --candidates`: read-only, not gated on `enabled`. */
function runPromoteCandidates({ values, root, rawOut, io, error }) {
  const located = locatePhase({ subcommand: 'promote', values, root, rawOut, io, error });
  if (located.failure !== undefined) return located.failure;
  const warnings = [];
  const read = readPhaseFiles({ root, phaseDir: located.phaseDir, io, warnings });
  if (read.failure !== undefined) return authoringFailure({ subcommand: 'promote', code: read.failure.code, message: read.failure.message, rawOut, io, error });
  const loaded = loadOrders({ cwd: root, fileArg: DEFAULT_ORDERS_PATH, deps: io });
  let document = loaded.document;
  if (loaded.stage === 'file' && loaded.report.errors[0] && loaded.report.errors[0].code === ERROR_CODES.FILE_NOT_FOUND) document = { orders: [] };
  else if (loaded.stage !== 'ok') {
    warnings.push({ code: PROMOTE_CODES.ORDERS_UNUSABLE, message: 'ORDERS.yaml could not be used, so already-promoted candidates are not marked; run standing-orders validate' });
  }
  const built = buildCandidates({ files: read.files, document });
  const result = {
    schema: REPORT_SCHEMA,
    subcommand: 'promote',
    ok: true,
    disabled: false,
    mode: 'candidates',
    phase_dir: located.phaseRel,
    candidates: built.candidates,
    truncated: built.truncated,
    looked_for: ['*-SPEC.md', '*-CONTEXT.md'],
    warnings,
    written: [],
  };
  if (rawOut) io.log(JSON.stringify(result));
  else for (const l of humanCandidateLines(result)) io.log(l);
  return result;
}

/** `promote --add`: gated on `enabled`; adds exactly one order by text insertion and writes atomically. */
function runPromoteAdd({ json, root, rawOut, io, error }) {
  const fail = (code, message, extra) => authoringFailure({ subcommand: 'promote', code, message, rawOut, io, error, extra });
  const config = readCapabilityConfig({ cwd: root, env: io.env, readFile: io.readFile, statSize: io.statSize });
  if (!config.enabled) return disabledResult({ subcommand: 'promote', rawOut, io });
  const parsed = parseAddArgument(json);
  if (!parsed.ok) return fail(parsed.code, parsed.message);

  const current = readOrdersForWrite({ root, io });
  if (current.failure !== undefined) return fail(current.failure.code, current.failure.message);
  const promoted = promoteOrder({ text: current.text, order: parsed.order, maxBytes: MAX_FILE_BYTES });
  if (!promoted.ok) {
    const extra = {};
    if (promoted.paste !== undefined) extra.paste = promoted.paste;
    if (promoted.errors !== undefined) extra.details = promoted.errors;
    return fail(promoted.code, promoted.message, extra);
  }
  const unusable = prepareOutputDir({ subcommand: 'promote', root, io });
  if (unusable !== null) return fail(unusable.code, unusable.message);
  try {
    writeAtomic(io, path.resolve(root, DEFAULT_ORDERS_PATH), promoted.text, 0);
  } catch (e) {
    return fail(LOOP_CODES.WRITE_FAILED, `promote: could not write ${toSlashes(DEFAULT_ORDERS_PATH)}: ${errMessage(e)}`);
  }
  const result = { schema: REPORT_SCHEMA, subcommand: 'promote', ok: true, disabled: false, mode: 'add', added: promoted.id, written: [DEFAULT_ORDERS_PATH] };
  io.log(rawOut ? JSON.stringify(result) : `standing-orders promote: added ${promoted.id} to ${toSlashes(DEFAULT_ORDERS_PATH)}; run standing-orders validate`);
  return result;
}

function runPromoteCommand({ rest, cwd, raw, error, io }) {
  const usageText =
    'Usage: standing-orders promote --candidates (--phase <n> | --phase-dir <dir>) [--raw] | standing-orders promote --add <order-json> [--raw]';
  const rawOut = raw === true || rest.includes('--raw');
  const usage = (message) => authoringFailure({ subcommand: 'promote', code: LOOP_CODES.USAGE, message, rawOut, io, error });
  const parsed = parseAuthoringFlags('promote', rest, { valued: ['--add', '--phase', '--phase-dir', '--ws'], bare: ['--candidates'], usageText });
  if (parsed.usage !== undefined) return usage(parsed.usage);
  const { values, flags, adds } = parsed;
  const candidates = flags.has('--candidates');
  if (candidates === (adds > 0)) return usage(`${FAMILY} promote: give exactly one of --candidates and --add. ${usageText}`);
  const root = path.resolve(cwd);
  if (adds > 0) {
    if (values['--phase'] !== undefined || values['--phase-dir'] !== undefined) {
      return usage(`${FAMILY} promote: --add takes no phase flags. ${usageText}`);
    }
    if (adds > 1) {
      return authoringFailure({ subcommand: 'promote', code: PROMOTE_CODES.BATCH_REFUSED, message: 'promote adds exactly one order per call; --add was given more than once', rawOut, io, error });
    }
    return runPromoteAdd({ json: values['--add'], root, rawOut, io, error });
  }
  if ((values['--phase'] === undefined) === (values['--phase-dir'] === undefined)) {
    return usage(`${FAMILY} promote: give exactly one of --phase and --phase-dir. ${usageText}`);
  }
  return runPromoteCandidates({ values, root, rawOut, io, error });
}

/** Read the semantic ledger of a phase: { document } or { failure: { code, message } }. A missing file is an empty ledger. */
function readSemantic({ root, abs, phaseRel, io }) {
  const rel = toSlashes(path.relative(root, abs));
  const fail = (message) => ({ failure: { code: SEMANTIC_CODES.SEMANTIC_UNUSABLE, message } });
  try {
    if (io.isSymlink(abs)) return fail(`${rel} is a symbolic link; the semantic file must be a regular file`);
    if (!io.exists(abs)) return { document: emptyDocument(phaseRel) };
    const size = io.statSize(abs);
    if (typeof size !== 'number' || !Number.isFinite(size)) return fail(`${rel} has no readable size`);
    if (size > MAX_SEMANTIC_BYTES) return fail(`${rel} is ${size} bytes; the limit is ${MAX_SEMANTIC_BYTES}`);
    const parsed = parseSemantic(String(io.readFile(abs)));
    if (!parsed.ok) return fail(`${rel} is not usable and was left as it is: ${parsed.message}`);
    return { document: parsed.document };
  } catch (e) {
    return fail(`${rel} could not be read: ${errMessage(e)}`);
  }
}

function humanSemanticLines(result) {
  const c = result.counts;
  const tally = `${c.unresolved} unresolved, ${c.resolved} confirmed, ${c.dismissed} dismissed`;
  if (result.action === 'propose') {
    const added = result.added.length > 0 ? ` (${result.added.join(', ')})` : '';
    return [`standing-orders semantic propose: ${result.added.length} added${added}, ${result.duplicates.length} duplicate(s); ${tally}`];
  }
  if (result.action === 'resolve') return [`standing-orders semantic resolve: ${result.finding.id} is now ${result.finding.status}; ${tally}`];
  const lines = [`standing-orders semantic list: ${result.findings.length} finding(s); ${tally}`];
  for (const f of result.findings) lines.push(`  ${f.id} [${f.status}] ${f.orders.join(', ')}: ${f.statement}${f.reason ? ` (${f.reason})` : ''}`);
  return lines;
}

const SEMANTIC_USAGE =
  'Usage: standing-orders semantic propose (--phase <n> | --phase-dir <dir>) --findings <json> [--auto] [--raw] | semantic resolve (--phase <n> | --phase-dir <dir>) --id <S-n> --status <unresolved|resolved|dismissed> [--reason <text>] [--auto] [--raw] | semantic list (--phase <n> | --phase-dir <dir>) [--raw]';

/** Parse a `semantic` command line into { action, values, flags, proposals } or { usage }. */
function parseSemanticArgs(rest) {
  const action = rest[0];
  if (action !== 'propose' && action !== 'resolve' && action !== 'list') {
    return { usage: `${FAMILY} semantic: give an action (propose, resolve or list). ${SEMANTIC_USAGE}` };
  }
  const common = ['--phase', '--phase-dir', '--ws'];
  const spec = {
    propose: { valued: [...common, '--findings'], bare: ['--auto'] },
    resolve: { valued: [...common, '--id', '--status', '--reason'], bare: ['--auto'] },
    list: { valued: common, bare: [] },
  }[action];
  const parsed = parseAuthoringFlags(`semantic ${action}`, rest.slice(1), { ...spec, usageText: SEMANTIC_USAGE });
  if (parsed.usage !== undefined) return { usage: parsed.usage };
  const { values, flags } = parsed;
  const usage = (m) => ({ usage: `${FAMILY} semantic ${action}: ${m}. ${SEMANTIC_USAGE}` });
  if ((values['--phase'] === undefined) === (values['--phase-dir'] === undefined)) return usage('give exactly one of --phase and --phase-dir');
  let proposals = null;
  if (action === 'propose') {
    if (values['--findings'] === undefined) return usage('--findings is required');
    try {
      proposals = JSON.parse(values['--findings']);
    } catch (e) {
      return usage(`--findings is not valid JSON: ${errMessage(e)}`);
    }
    if (!Array.isArray(proposals)) return usage('--findings must be a JSON list');
  }
  if (action === 'resolve') {
    if (values['--id'] === undefined || values['--status'] === undefined) return usage('--id and --status are required');
    if (!FINDING_STATUSES.includes(values['--status'])) return usage(`--status must be one of ${FINDING_STATUSES.join(', ')}`);
  }
  return { action, values, flags, proposals };
}

/** The order ids of ORDERS.yaml as a Set, or a failure message when the file cannot be used. */
function knownOrderIds({ root, io }) {
  const loaded = loadOrders({ cwd: root, fileArg: DEFAULT_ORDERS_PATH, deps: io });
  if (loaded.stage !== 'ok') {
    const first = loaded.report.errors[0];
    return { failure: `ORDERS.yaml could not be used${first ? ` (${first.code})` : ''}; run standing-orders validate` };
  }
  return { ids: new Set(loaded.document.orders.map((o) => o.id)) };
}

/** `semantic propose|resolve|list`: the LLM conflict ledger. propose and resolve are gated on `enabled`; list is not. */
function runSemanticCommand({ rest, cwd, raw, error, io }) {
  const rawOut = raw === true || rest.includes('--raw');
  const parsed = parseSemanticArgs(rest);
  if (parsed.usage !== undefined) return authoringFailure({ subcommand: 'semantic', code: LOOP_CODES.USAGE, message: parsed.usage, rawOut, io, error });
  const { action, values, flags, proposals } = parsed;
  const fail = (code, message) => authoringFailure({ subcommand: 'semantic', code, message, rawOut, io, error });

  const root = path.resolve(cwd);
  if (action !== 'list') {
    const config = readCapabilityConfig({ cwd: root, env: io.env, readFile: io.readFile, statSize: io.statSize });
    if (!config.enabled) return disabledResult({ subcommand: 'semantic', rawOut, io });
  }
  const located = locatePhase({ subcommand: 'semantic', values, root, rawOut, io, error });
  if (located.failure !== undefined) return located.failure;

  let known = null;
  if (action === 'propose') {
    known = knownOrderIds({ root, io });
    if (known.failure !== undefined) return fail(LOOP_CODES.ORDERS_UNUSABLE, known.failure);
  }
  const target = path.join(located.phaseDir, SEMANTIC_FILE);
  const current = readSemantic({ root, abs: target, phaseRel: located.phaseRel, io });
  if (current.failure !== undefined) return fail(current.failure.code, current.failure.message);

  const written = [];
  let result;
  if (action === 'list') {
    result = { schema: REPORT_SCHEMA, subcommand: 'semantic', ok: true, disabled: false, action, findings: current.document.findings, counts: countFindings(current.document), written };
  } else {
    const auto = flags.has('--auto');
    const ts = new Date(io.now()).toISOString();
    const outcome =
      action === 'propose'
        ? proposeFindings({ document: current.document, proposals, knownIds: known.ids, auto, ts })
        : resolveFinding({ document: current.document, id: values['--id'], status: values['--status'], reason: values['--reason'], auto, ts });
    if (!outcome.ok) return fail(outcome.code === 'usage' ? LOOP_CODES.USAGE : outcome.code, outcome.message);
    if (action === 'resolve' || outcome.added.length > 0) {
      const text = serializeSemantic(outcome.document);
      if (Buffer.byteLength(text, 'utf8') > MAX_SEMANTIC_BYTES) return fail(SEMANTIC_CODES.INVALID_FINDING, `the semantic file would exceed ${MAX_SEMANTIC_BYTES} bytes`);
      try {
        writeAtomic(io, target, text, 0);
      } catch (e) {
        return fail(LOOP_CODES.WRITE_FAILED, `semantic ${action}: could not write ${SEMANTIC_FILE}: ${errMessage(e)}`);
      }
      written.push(toSlashes(path.relative(root, target)));
    }
    result = { schema: REPORT_SCHEMA, subcommand: 'semantic', ok: true, disabled: false, action, counts: countFindings(outcome.document), written };
    if (action === 'propose') {
      result.added = outcome.added;
      result.duplicates = outcome.duplicates;
    } else result.finding = outcome.finding;
  }
  if (rawOut) io.log(JSON.stringify(result));
  else for (const l of humanSemanticLines(result)) io.log(l);
  return result;
}

// ─── mutants ──────────────────────────────────────────────────────────────────

const MC = mutantsLib.MUTANT_CODES;
const isInsideRoot = mutantsLib.isInside;

function loadTestOrder({ root, io, id }) {
  const loaded = loadOrders({ cwd: root, fileArg: DEFAULT_ORDERS_PATH, deps: io });
  if (loaded.stage !== 'ok') return { code: LOOP_CODES.ORDERS_UNUSABLE, message: 'ORDERS.yaml could not be used; run standing-orders validate' };
  const order = loaded.document.orders.find((o) => o.id === id);
  if (order === undefined) return { code: MC.ORDER_NOT_FOUND, message: `no order with id ${id}` };
  if (order.verification !== 'test') return { code: MC.ORDER_NOT_TEST, message: `${id} is not a test-tier order` };
  return { order };
}

const textOf = (io, abs) => {
  try {
    return String(io.readFile(abs));
  } catch (e) {
    return null;
  }
};

/** `mutants --order <id>`: read-only list of the order's mutants with their cached outcome. */
function runMutantsList({ id, root, rawOut, io, error }) {
  const fail = (code, message) => authoringFailure({ subcommand: 'mutants', code, message, rawOut, io, error });
  const got = loadTestOrder({ root, io, id });
  if (got.code) return fail(got.code, got.message);
  const order = got.order;
  const entries = mutantsLib.readCache({ root, io });
  const targetText = textOf(io, path.resolve(root, order.check_target));
  const cleanText = order.check_clean_fixture ? textOf(io, path.resolve(root, order.check_clean_fixture)) : null;
  const mutants = order.check_mutants.map((p) => {
    const abs = path.resolve(root, p);
    let exists = false;
    let cached = null;
    try {
      exists = io.exists(abs) && io.isFile(abs);
      const file = mutantsLib.readMutant(root, p, io);
      if (file.error === undefined && targetText !== null && (!order.check_clean_fixture || cleanText !== null)) {
        const key = mutantsLib.cacheKey({ check_kind: order.check_kind, check_rule: order.check_kind === 'lint-rule' ? order.check_rule : null, target: targetText, clean: cleanText, mutant: file.text });
        if (entries[key]) cached = entries[key].outcome;
      }
    } catch (e) {
      // listed as it is
    }
    return { path: p, exists, cached_outcome: cached };
  });
  const result = { schema: REPORT_SCHEMA, subcommand: 'mutants', ok: true, disabled: false, mode: 'list', order: id, mutants, written: [] };
  if (rawOut) io.log(JSON.stringify(result));
  else {
    io.log(`standing-orders mutants: ${id} - ${mutants.length} mutant(s)`);
    for (const m of mutants) io.log(`  ${m.path}: ${m.exists ? 'present' : 'missing'}, ${m.cached_outcome === null ? 'not cached' : m.cached_outcome}`);
  }
  return result;
}

/** `mutants --run --order <id>`: the base proof plus every mutant, through the same function `enforce` uses. */
function runMutantsRun({ id, noCache, root, rawOut, io, error }) {
  const fail = (code, message) => authoringFailure({ subcommand: 'mutants', code, message, rawOut, io, error });
  const config = readCapabilityConfig({ cwd: root, env: io.env, readFile: io.readFile, statSize: io.statSize });
  if (!config.enabled) return disabledResult({ subcommand: 'mutants', rawOut, io });
  const got = loadTestOrder({ root, io, id });
  if (got.code) return fail(got.code, got.message);
  const order = got.order;
  const base = runEnforcement({ order, cwd: root, env: io.env, argv: io.argv, deps: io });
  const entries = mutantsLib.readCache({ root, io });
  const applied = mutantsLib.applyMutants({ order, base, root, io, entries, useCache: !noCache, ts: io.now().toISOString() });
  const written = [];
  if (applied.changed) {
    const unusable = prepareOutputDir({ subcommand: 'mutants', root, io });
    if (unusable !== null) return fail(unusable.code, unusable.message);
    try {
      writeAtomic(io, path.resolve(root, mutantsLib.MUTANTS_PATH), mutantsLib.serializeCache(applied.entries), 0);
      written.push(mutantsLib.MUTANTS_PATH);
    } catch (e) {
      return fail(LOOP_CODES.WRITE_FAILED, `mutants: could not write ${mutantsLib.MUTANTS_PATH}: ${errMessage(e)}`);
    }
  }
  const r = applied.result;
  const result = {
    schema: REPORT_SCHEMA,
    subcommand: 'mutants',
    ok: true,
    disabled: false,
    mode: 'run',
    order: id,
    base: { status: base.status, flagged: base.flagged, reason: base.reason },
    mutants: Array.isArray(r.mutants) ? r.mutants : [],
    verdict: r.flagged === false && r.status === 'green' ? 'clear' : 'flagged',
    written,
  };
  if (rawOut) io.log(JSON.stringify(result));
  else {
    io.log(`standing-orders mutants: ${id} - ${result.verdict}`);
    for (const m of result.mutants) io.log(`  ${m.path}: ${m.outcome}${m.cached ? ' (cached)' : ''}`);
  }
  return result;
}

const YAML_PLAIN_RE = /^[A-Za-z_][A-Za-z0-9_./-]*$/;
const YAML_WORDS = new Set(['null', 'true', 'false', 'yes', 'no', 'on', 'off', '~']);
const yamlScalar = (p) => (YAML_PLAIN_RE.test(p) && !YAML_WORDS.has(p.toLowerCase()) ? p : JSON.stringify(p));

/** Insert `p` into the check_mutants of order `id` in ORDERS.yaml text. { text } or { manual: true }. */
function insertMutantText(text, id, p) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  const bare = (l) => l.replace(/\r?\n$/, '');
  const unq = (v) => v.replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2');
  let start = -1;
  let dashIndent = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)-\s+id:\s*(.*)$/.exec(bare(lines[i]));
    if (m && unq(m[2]) === id) {
      start = i;
      dashIndent = m[1].length;
      break;
    }
  }
  if (start === -1) return { manual: true };
  const keyIndent = dashIndent + 2;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = bare(lines[i]);
    if (l.trim() === '' || /^\s*#/.test(l)) continue;
    const ind = /^\s*/.exec(l)[0].length;
    if (ind < keyIndent) {
      end = i;
      break;
    }
  }
  const keyRe = new RegExp(`^ {${keyIndent}}check_mutants:(.*)$`);
  let keyAt = -1;
  for (let i = start + 1; i < end; i += 1) {
    const m = keyRe.exec(bare(lines[i]));
    if (m) {
      keyAt = i;
      if (m[1].replace(/\s+#.*$/, '').trim() !== '') return { manual: true };
      break;
    }
  }
  const withEol = (l) => (l.endsWith('\n') ? l : l + eol);
  const sp = (n) => ' '.repeat(n);
  if (keyAt === -1) {
    let after = start + 1;
    for (let i = start + 1; i < end; i += 1) {
      const l = bare(lines[i]);
      if (l.trim() === '' || /^\s*#/.test(l)) continue;
      after = i + 1;
    }
    const head = lines.slice(0, after);
    head[head.length - 1] = withEol(head[head.length - 1]);
    return { text: head.join('') + `${sp(keyIndent)}check_mutants:${eol}${sp(keyIndent + 2)}- ${yamlScalar(p)}${eol}` + lines.slice(after).join('') };
  }
  let last = keyAt;
  let itemIndent = null;
  for (let i = keyAt + 1; i < end; i += 1) {
    const l = bare(lines[i]);
    const m = /^(\s*)-\s/.exec(l);
    if (m && m[1].length >= keyIndent) {
      if (itemIndent === null) itemIndent = m[1].length;
      last = i;
    } else if (l.trim() === '' || /^\s*#/.test(l)) continue;
    else break;
  }
  if (itemIndent === null) return { manual: true };
  const head = lines.slice(0, last + 1);
  head[head.length - 1] = withEol(head[head.length - 1]);
  return { text: head.join('') + `${sp(itemIndent)}- ${yamlScalar(p)}${eol}` + lines.slice(last + 1).join('') };
}

const DRIVE_RE = /^[A-Za-z]:/;
const canonLower = (p) => String(p).replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '').toLowerCase();

/**
 * `mutants --add <json>`: validate everything and build the new ORDERS.yaml text in
 * memory first; then write the mutant file, then ORDERS.yaml atomically; on an
 * ORDERS.yaml write failure remove the mutant file again.
 */
function runMutantsAdd({ json, root, rawOut, io, error }) {
  const fail = (code, message, extra) => authoringFailure({ subcommand: 'mutants', code, message, rawOut, io, error, extra });
  const config = readCapabilityConfig({ cwd: root, env: io.env, readFile: io.readFile, statSize: io.statSize });
  if (!config.enabled) return disabledResult({ subcommand: 'mutants', rawOut, io });
  let body;
  try {
    body = JSON.parse(json);
  } catch (e) {
    return fail(LOOP_CODES.USAGE, `mutants --add: the argument is not valid JSON: ${errMessage(e)}`);
  }
  if (Array.isArray(body)) return fail('batch_refused', 'mutants adds exactly one mutant per call; --add must be one object, not a list');
  if (!isPlainObject(body) || typeof body.order !== 'string' || typeof body.path !== 'string' || typeof body.content !== 'string' || body.order === '' || body.path === '') {
    return fail(LOOP_CODES.USAGE, 'mutants --add: give one object {"order": <id>, "path": <project path>, "content": <text>}');
  }
  const { order: id, path: p, content } = body;
  const current = readOrdersForWrite({ root, io });
  if (current.failure !== undefined) return fail(LOOP_CODES.ORDERS_UNUSABLE, current.failure.message);
  if (current.text === null) return fail(LOOP_CODES.ORDERS_UNUSABLE, 'ORDERS.yaml does not exist');
  const before = parseOrders(current.text);
  if (!before.ok) return fail(LOOP_CODES.ORDERS_UNUSABLE, 'ORDERS.yaml could not be used; run standing-orders validate');
  const order = before.document.orders.find((o) => o.id === id);
  if (order === undefined) return fail(MC.ORDER_NOT_FOUND, `no order with id ${id}`);
  if (order.verification !== 'test') return fail(MC.ORDER_NOT_TEST, `${id} is not a test-tier order`);

  const norm = p.replace(/\\/g, '/');
  if (norm.startsWith('/') || DRIVE_RE.test(norm) || norm.split('/').includes('..')) return fail(MC.PATH_INVALID, `${p} must be a relative path inside the project`);
  const c = canonLower(p);
  if (c === '.planning' || c.startsWith('.planning/')) return fail(MC.PATH_RESERVED, `${p} is under .planning`);
  if ([order.check_target, order.check_violation_fixture, order.check_clean_fixture].filter(Boolean).map(canonLower).includes(c)) return fail(MC.MUTANT_IS_CHECK_FILE, `${p} is a check file of ${id}`);
  if (order.check_mutants.map(canonLower).includes(c)) return fail(MC.MUTANT_EXISTS, `${p} is already a mutant of ${id}`);
  const abs = path.resolve(root, p);
  if (!isInsideRoot(root, abs)) return fail(MC.PATH_OUTSIDE_PROJECT, `${p} resolves outside the project`);
  try {
    // The nearest existing ancestor (a dangling link counts as existing) must really be inside the project.
    let dir = path.dirname(abs);
    while (!io.exists(dir) && !io.isSymlink(dir) && dir !== path.dirname(dir)) dir = path.dirname(dir);
    const realRoot = io.realpath(root);
    const realDir = io.realpath(dir);
    if (realDir !== realRoot && !isInsideRoot(realRoot, realDir)) return fail(MC.PATH_OUTSIDE_PROJECT, `${p} resolves (through a link) outside the project`);
    if (io.exists(abs) || io.isSymlink(abs)) return fail(MC.MUTANT_EXISTS, `${p} already exists`);
  } catch (e) {
    return fail(LOOP_CODES.WRITE_FAILED, `mutants: could not examine ${p}: ${errMessage(e)}`);
  }
  const size = Buffer.byteLength(content, 'utf8');
  if (size === 0 || size > mutantsLib.MAX_MUTANT_BYTES) return fail(MC.CONTENT_INVALID, `content must be 1 to ${mutantsLib.MAX_MUTANT_BYTES} bytes (got ${size})`);

  const manual = () => fail(MC.MANUAL, 'ORDERS.yaml cannot be extended safely; add the path by hand and save the mutant file', { paste: `check_mutants:\n  - ${yamlScalar(p)}`, content });
  const inserted = insertMutantText(current.text, id, p);
  if (inserted.manual) return manual();
  const after = parseOrders(inserted.text);
  if (!after.ok) return manual();
  const o2 = after.document.orders;
  const o1 = before.document.orders;
  const same =
    o2.length === o1.length &&
    o2.every((o, i) =>
      o.id === id
        ? orderHash({ ...o, check_mutants: o1[i].check_mutants }) === orderHash(o1[i]) && JSON.stringify(o.check_mutants) === JSON.stringify([...o1[i].check_mutants, p])
        : orderHash(o) === orderHash(o1[i]),
    );
  if (!same) return manual();
  if (Buffer.byteLength(inserted.text, 'utf8') > MAX_FILE_BYTES) return fail(ERROR_CODES.FILE_TOO_LARGE, 'ORDERS.yaml would be too large');

  try {
    io.mkdir(path.dirname(abs));
    io.writeFile(abs, content);
  } catch (e) {
    return fail(LOOP_CODES.WRITE_FAILED, `mutants: could not write ${p}: ${errMessage(e)}`);
  }
  try {
    writeAtomic(io, path.resolve(root, DEFAULT_ORDERS_PATH), inserted.text, 0);
  } catch (e) {
    let note = '';
    try {
      io.unlink(abs);
    } catch (u) {
      note = `; ${p} could not be removed: ${errMessage(u)}`;
    }
    return fail(LOOP_CODES.WRITE_FAILED, `mutants: could not write ${toSlashes(DEFAULT_ORDERS_PATH)}: ${errMessage(e)}${note}`);
  }
  const result = { schema: REPORT_SCHEMA, subcommand: 'mutants', ok: true, disabled: false, mode: 'add', order: id, path: p, written: [p, DEFAULT_ORDERS_PATH] };
  io.log(rawOut ? JSON.stringify(result) : `standing-orders mutants: added ${p} to ${id}; run standing-orders mutants --run --order ${id}`);
  return result;
}

function runMutantsCommand({ rest, cwd, raw, error, io }) {
  const usageText = 'Usage: standing-orders mutants --order <id> | --add <json> | --run --order <id> [--no-cache] [--raw]';
  const rawOut = raw === true || rest.includes('--raw');
  const usage = (message) => authoringFailure({ subcommand: 'mutants', code: LOOP_CODES.USAGE, message, rawOut, io, error });
  const parsed = parseAuthoringFlags('mutants', rest, { valued: ['--add', '--order', '--ws'], bare: ['--run', '--no-cache'], usageText });
  if (parsed.usage !== undefined) return usage(parsed.usage);
  const { values, flags, adds } = parsed;
  const run = flags.has('--run');
  const id = values['--order'];
  const root = path.resolve(cwd);
  if (adds > 0) {
    if (run || id !== undefined || flags.has('--no-cache')) return usage(`${FAMILY} mutants: --add takes no other flag. ${usageText}`);
    if (adds > 1) return authoringFailure({ subcommand: 'mutants', code: 'batch_refused', message: 'mutants adds exactly one mutant per call; --add was given more than once', rawOut, io, error });
    return runMutantsAdd({ json: values['--add'], root, rawOut, io, error });
  }
  if (id === undefined) return usage(`${FAMILY} mutants: give --order <id> (or --add <json>). ${usageText}`);
  if (flags.has('--no-cache') && !run) return usage(`${FAMILY} mutants: --no-cache needs --run. ${usageText}`);
  if (run) return runMutantsRun({ id, noCache: flags.has('--no-cache'), root, rawOut, io, error });
  return runMutantsList({ id, root, rawOut, io, error });
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
  if (LOOP_SUBCOMMANDS.includes(subcommand) || QUERY_SUBCOMMANDS.includes(subcommand) || AUTHORING_SUBCOMMANDS.includes(subcommand)) {
    let run = runQueryCommand;
    if (LOOP_SUBCOMMANDS.includes(subcommand)) run = runLoopCommand;
    else if (subcommand === 'promote') run = runPromoteCommand;
    else if (subcommand === 'semantic') run = runSemanticCommand;
    else if (subcommand === 'mutants') run = runMutantsCommand;
    try {
      return run({ subcommand, rest: args.slice(2), cwd, raw, error, io });
    } catch (e) {
      const message = `${FAMILY} ${subcommand}: internal error: ${errMessage(e)}`;
      error(message);
      return { schema: REPORT_SCHEMA, subcommand, ok: false, errors: [{ code: LOOP_CODES.INTERNAL_ERROR, message }], written: [] };
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

function isUsageFailure(report) {
  return Array.isArray(report.errors) && report.errors.some((e) => e.code === LOOP_CODES.USAGE);
}

/** Exit code for the direct CLI: 0 ok; 2 the file could not be read; 1 otherwise (`stale`: 1 when any order is stale). */
function exitCodeFor(report) {
  if (AUTHORING_SUBCOMMANDS.includes(report.subcommand)) {
    if (report.ok) return report.verdict === 'flagged' ? 1 : 0;
    return Array.isArray(report.errors) && report.errors.some((e) => FILE_ERROR_CODES.has(e.code)) ? 2 : 1;
  }
  if (QUERY_SUBCOMMANDS.includes(report.subcommand)) {
    if (report.ok === false) return isUsageFailure(report) ? 1 : 2;
    return report.subcommand === 'stale' && Array.isArray(report.stale) && report.stale.length > 0 ? 1 : 0;
  }
  if (LOOP_SUBCOMMANDS.includes(report.subcommand)) {
    if (report.ok === false) return isUsageFailure(report) ? 1 : 2;
    if (report.disabled === true) return 0;
    if (report.conflicts === STATUS.BLOCKED || report.coverage === STATUS.INCOMPLETE || report.coverage === STATUS.ERROR) return 1;
    if (report.enforcement === STATUS.FLAGGED || report.enforcement === STATUS.ERROR) return 1;
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

module.exports = { routeStandingOrdersCommand, validateFile, exitCodeFor, isInside, loadOrders, DEFAULT_ORDERS_PATH, APPLICABLE_PATH, CONFLICTS_PATH, ENFORCEMENT_PATH, TRACE_PATH, MAX_FILE_BYTES, GIT_TIMEOUT_MS, SUBCOMMANDS, REPORT_SCHEMA, LOOP_CODES };
