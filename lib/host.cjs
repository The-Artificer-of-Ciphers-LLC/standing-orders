'use strict';

/**
 * lib/host.cjs — resolve a phase number to its directory through the host
 * (`gsd-tools init plan-phase <phase> --raw`).
 *
 * All I/O is injected (`deps.execFile`, `deps.readFile`, `deps.isFile`,
 * `deps.nodePath`). The subprocess is never run through a shell, its argument
 * list is fixed, the phase is validated first, and the call is bounded by
 * HOST_TIMEOUT_MS. Never throws: failures are returned as `{ ok: false, code, message }`.
 *
 * `runEnforcement` asks the host prover (`gsd-tools check prohibition-enforcement`)
 * about one `test` order, bounded by ENFORCE_TIMEOUT_MS. It never throws either:
 * every failure is a flagged, `unverified` result carrying a reason.
 */

const path = require('node:path');
const { splitReqIds } = require('./phase.cjs');
const { isPlainObject, errMessage } = require('./util.cjs');

const HOST_TIMEOUT_MS = 30000;
const ENFORCE_TIMEOUT_MS = 180000;
const MAX_REQUEST_CHARS = 28000;
const MAX_STATEMENT_CHARS = 500;
const MAX_STDERR_CHARS = 200;
const PHASE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HOST_CLI_NAMES = new Set(['gsd-tools.cjs', 'gsd-tools']);
const FILE_PREFIX = '@file:';

/** The host CLI path: `GSD_TOOLS`, else the running script when it is gsd-tools, else null. */
function findHostCli({ env, argv, isFile }) {
  const e = env || {};
  if (typeof e.GSD_TOOLS === 'string' && e.GSD_TOOLS !== '' && isFile(e.GSD_TOOLS)) return e.GSD_TOOLS;
  const script = Array.isArray(argv) ? argv[1] : undefined;
  if (typeof script === 'string' && HOST_CLI_NAMES.has(path.basename(script)) && isFile(script)) return script;
  return null;
}

function unresolved(phase, detail) {
  return { ok: false, code: 'phase_unresolved', message: `phase ${phase} could not be resolved through the host: ${detail}` };
}

function resolvePhase({ phase, cwd, env, argv, deps }) {
  if (typeof phase !== 'string' || !PHASE_TOKEN_RE.test(phase)) {
    return { ok: false, code: 'usage', message: `invalid phase ${JSON.stringify(phase)}; expected a short token such as 3 or 03-billing` };
  }
  const cli = findHostCli({ env, argv, isFile: deps.isFile });
  if (cli === null) {
    return { ok: false, code: 'host_unavailable', message: 'the host CLI (gsd-tools) was not found; pass --phase-dir <path> instead of --phase' };
  }

  let out;
  try {
    out = deps.execFile(deps.nodePath, [cli, 'init', 'plan-phase', phase, '--raw'], {
      cwd,
      timeout: HOST_TIMEOUT_MS,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (e) {
    return unresolved(phase, errMessage(e));
  }

  let text = String(out === undefined || out === null ? '' : out).trim();
  if (text.startsWith(FILE_PREFIX)) {
    try {
      text = String(deps.readFile(text.slice(FILE_PREFIX.length))).trim();
    } catch (e) {
      return unresolved(phase, errMessage(e));
    }
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return unresolved(phase, `the host output is not JSON (${errMessage(e)})`);
  }
  if (!isPlainObject(json) || json.phase_found !== true || typeof json.phase_dir !== 'string' || json.phase_dir === '') {
    return unresolved(phase, 'the host did not report a phase directory');
  }
  return { ok: true, phaseDir: path.resolve(cwd, json.phase_dir), reqIds: splitReqIds(json.phase_req_ids) };
}

function nonEmptyString(v) {
  return typeof v === 'string' && v !== '';
}

/** The `check prohibition-enforcement` request for one `test` order; the statement is cut to keep the argument short. */
function enforcementRequest(order) {
  const o = isPlainObject(order) ? order : {};
  const statement = typeof o.statement === 'string' ? o.statement : String(o.statement);
  const check = { kind: o.check_kind, target: o.check_target };
  if (o.check_kind === 'lint-rule' && nonEmptyString(o.check_rule)) check.rule = o.check_rule;
  if (nonEmptyString(o.check_violation_fixture)) check.violationFixture = o.check_violation_fixture;
  if (nonEmptyString(o.check_clean_fixture)) check.cleanFixture = o.check_clean_fixture;
  return {
    prohibition: {
      id: o.id,
      statement: statement.length > MAX_STATEMENT_CHARS ? statement.slice(0, MAX_STATEMENT_CHARS) + String.fromCharCode(0x2026) : statement,
      status: 'resolved',
      verification: 'test',
    },
    check,
  };
}

function enforcementFailure(id, reason) {
  return { id, status: 'unverified', flagged: true, reason, located: false, kind: null, evidence: [] };
}

function firstLine(value) {
  const line = String(value === undefined || value === null ? '' : value).split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '');
  return (line === undefined ? '' : line).slice(0, MAX_STDERR_CHARS);
}

function isTimeout(e) {
  return e.code === 'ETIMEDOUT' || e.killed === true || (e.signal !== undefined && e.signal !== null);
}

/** The reason a failed host call is flagged: a timeout, or the exit status with the first stderr line. */
function execFailureReason(e) {
  const err = e && typeof e === 'object' ? e : { message: String(e) };
  if (isTimeout(err)) return `host_timeout: no verdict within ${ENFORCE_TIMEOUT_MS} ms`;
  return `host_failed: exit ${err.status}: ${firstLine(err.stderr)}`;
}

/** Run the prover and parse its JSON verdict, or return a flagged failure. */
function callProver({ id, cli, json, cwd, deps }) {
  let out;
  try {
    out = deps.execFile(deps.nodePath, [cli, 'check', 'prohibition-enforcement', '--json', json], {
      cwd,
      timeout: ENFORCE_TIMEOUT_MS,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (e) {
    return { failure: enforcementFailure(id, execFailureReason(e)) };
  }
  try {
    let text = String(out === undefined || out === null ? '' : out).trim();
    if (text.startsWith(FILE_PREFIX)) text = String(deps.readFile(text.slice(FILE_PREFIX.length))).trim();
    const parsed = JSON.parse(text);
    if (!isPlainObject(parsed)) return { failure: enforcementFailure(id, 'host_output_invalid: the host output is not a JSON object') };
    return { parsed };
  } catch (e) {
    return { failure: enforcementFailure(id, `host_output_invalid: ${errMessage(e)}`) };
  }
}

/**
 * Ask the host whether one `test` order's check is proven. Fail-closed: only the
 * host's own `flagged: false` yields an unflagged result.
 * @returns {{ id: string, status: string, flagged: boolean, reason: string, located: boolean, kind: string|null, evidence: any[] }}
 */
function runEnforcement({ order, cwd, env, argv, deps }) {
  const id = isPlainObject(order) ? order.id : undefined;
  try {
    const json = JSON.stringify(enforcementRequest(order));
    if (json.length > MAX_REQUEST_CHARS) return enforcementFailure(id, `request_too_large: ${json.length} chars`);
    const cli = findHostCli({ env, argv, isFile: deps.isFile });
    if (cli === null) return enforcementFailure(id, 'host_unavailable: the host CLI (gsd-tools) was not found');
    const { failure, parsed: out } = callProver({ id, cli, json, cwd, deps });
    if (failure !== undefined) return failure;
    return {
      id,
      status: typeof out.status === 'string' ? out.status : 'unverified',
      flagged: out.flagged !== false,
      reason: typeof out.reason === 'string' ? out.reason : '',
      located: out.located === true,
      kind: typeof out.kind === 'string' ? out.kind : null,
      evidence: Array.isArray(out.evidence) ? out.evidence : [],
    };
  } catch (e) {
    return enforcementFailure(id, `host_failed: ${errMessage(e)}`);
  }
}

module.exports = {
  HOST_TIMEOUT_MS, ENFORCE_TIMEOUT_MS, MAX_REQUEST_CHARS, MAX_STATEMENT_CHARS, PHASE_TOKEN_RE, findHostCli, resolvePhase, enforcementRequest, runEnforcement,
};
