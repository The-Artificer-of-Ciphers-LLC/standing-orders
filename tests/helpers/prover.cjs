'use strict';

/**
 * A fake gsd-core prover for phase 6 (#7). `execFile` answers `check prohibition-enforcement --json <request>` the
 * way the host does, chosen by the request's `check.violationFixture` (a mutant is just another violation fixture,
 * ADR-0002), and records every call.
 *
 * `table` maps a violation-fixture path to the host's stdout: a string, an Error to throw, or a function of the parsed
 * request returning either. A fixture that is not in the table is answered GREEN.
 *
 * `git` answers the `git` calls the cache key makes (the HEAD tree id and the dirty check), kept apart from the prover
 * calls: a function of the argument list returning stdout (or an Error to throw). The default is a clean tree whose id
 * is TREE. Every git call is recorded in `gitCalls`.
 */

const HOST_CLI = '/opt/gsd/bin/gsd-tools.cjs';
const TREE = 'a'.repeat(40);

const verdict = (o) => JSON.stringify({ tier: 'test', located: true, kind: 'node-test', evidence: [], ...o });
const GREEN = verdict({ status: 'green', flagged: false, reason: 'ok' });
const FLAGGED = verdict({ status: 'unverified', flagged: true, reason: 'test-tier prohibition has no passing wired enforcement check' });

/** A clean tree with the id TREE. */
function cleanGit(args) {
  if (args[0] === 'rev-parse') return TREE + '\n';
  if (args[0] === 'status') return '';
  return new Error(`unexpected git call: ${args.join(' ')}`);
}

function fakeProver(table = {}, { git = cleanGit } = {}) {
  const calls = [];
  const gitCalls = [];
  const execFile = (file, args, opts) => {
    if (file === 'git') {
      gitCalls.push({ args, opts });
      const answer = git(args, opts);
      if (answer instanceof Error) throw answer;
      return answer;
    }
    const req = JSON.parse(args[4]);
    const fixture = req.check.violationFixture;
    calls.push({ file, args, opts, req, id: req.prohibition.id, fixture });
    const entry = Object.prototype.hasOwnProperty.call(table, fixture) ? table[fixture] : GREEN;
    const out = typeof entry === 'function' ? entry(req) : entry;
    if (out instanceof Error) throw out;
    return out;
  };
  return { execFile, calls, gitCalls };
}

module.exports = { HOST_CLI, GREEN, FLAGGED, TREE, verdict, fakeProver };
