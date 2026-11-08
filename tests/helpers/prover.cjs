'use strict';

/**
 * A fake gsd-core prover for phase 6 (#7). `execFile` answers `check prohibition-enforcement --json <request>` the
 * way the host does, chosen by the request's `check.violationFixture` (a mutant is just another violation fixture,
 * ADR-0002), and records every call.
 *
 * `table` maps a violation-fixture path to the host's stdout: a string, an Error to throw, or a function of the parsed
 * request returning either. A fixture that is not in the table is answered GREEN.
 */

const HOST_CLI = '/opt/gsd/bin/gsd-tools.cjs';

const verdict = (o) => JSON.stringify({ tier: 'test', located: true, kind: 'node-test', evidence: [], ...o });
const GREEN = verdict({ status: 'green', flagged: false, reason: 'ok' });
const FLAGGED = verdict({ status: 'unverified', flagged: true, reason: 'test-tier prohibition has no passing wired enforcement check' });

function fakeProver(table = {}) {
  const calls = [];
  const execFile = (file, args, opts) => {
    const req = JSON.parse(args[4]);
    const fixture = req.check.violationFixture;
    calls.push({ file, args, opts, req, id: req.prohibition.id, fixture });
    const entry = Object.prototype.hasOwnProperty.call(table, fixture) ? table[fixture] : GREEN;
    const out = typeof entry === 'function' ? entry(req) : entry;
    if (out instanceof Error) throw out;
    return out;
  };
  return { execFile, calls };
}

module.exports = { HOST_CLI, GREEN, FLAGGED, verdict, fakeProver };
