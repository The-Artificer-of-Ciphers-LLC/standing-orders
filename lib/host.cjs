'use strict';

/**
 * lib/host.cjs — resolve a phase number to its directory through the host
 * (`gsd-tools init plan-phase <phase> --raw`).
 *
 * All I/O is injected (`deps.execFile`, `deps.readFile`, `deps.isFile`,
 * `deps.nodePath`). The subprocess is never run through a shell, its argument
 * list is fixed, the phase is validated first, and the call is bounded by
 * HOST_TIMEOUT_MS. Never throws: failures are returned as `{ ok: false, code, message }`.
 */

const path = require('node:path');
const { splitReqIds } = require('./phase.cjs');
const { isPlainObject, errMessage } = require('./util.cjs');

const HOST_TIMEOUT_MS = 30000;
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

module.exports = { HOST_TIMEOUT_MS, PHASE_TOKEN_RE, findHostCli, resolvePhase };
