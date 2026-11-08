'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { HOST_TIMEOUT_MS, findHostCli, resolvePhase } = require('../lib/host.cjs');

const CWD = path.resolve(path.sep, 'proj');
const CLI = '/opt/gsd/bin/gsd-tools.cjs';
const GOOD_JSON = JSON.stringify({ phase_found: true, phase_dir: '/proj/.planning/phases/03-billing', phase_req_ids: 'BILL-04, BILL-05' });

/** Build deps with a recording execFile that returns `result` (or throws it when it is an Error). */
function harness({ result = GOOD_JSON, files = {}, hostFiles = [CLI], argv = ['node', CLI], env = {} } = {}) {
  const execCalls = [];
  const deps = {
    execFile: (file, args, opts) => {
      execCalls.push({ file, args, opts });
      if (result instanceof Error) throw result;
      return result;
    },
    readFile: (p) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
    isFile: (p) => hostFiles.includes(p),
    nodePath: '/usr/bin/node',
  };
  return { deps, execCalls, argv, env };
}

const run = (h, phase = '3') => resolvePhase({ phase, cwd: CWD, env: h.env, argv: h.argv, deps: h.deps });

describe('host', () => {
  it('resolvesViaInitPlanPhase', () => {
    const h = harness();
    const r = run(h, '3');
    assert.deepEqual(r, { ok: true, phaseDir: '/proj/.planning/phases/03-billing', reqIds: ['BILL-04', 'BILL-05'] });
    assert.equal(h.execCalls.length, 1);
    assert.equal(h.execCalls[0].file, '/usr/bin/node');
    assert.deepEqual(h.execCalls[0].args, [CLI, 'init', 'plan-phase', '3', '--raw']);
    const relative = harness({ result: JSON.stringify({ phase_found: true, phase_dir: '.planning/phases/03-billing', phase_req_ids: '' }) });
    assert.deepEqual(run(relative), { ok: true, phaseDir: path.resolve(CWD, '.planning/phases/03-billing'), reqIds: [] });
  });

  it('followsAtFilePayload', () => {
    const h = harness({ result: '@file:/tmp/gsd-out.json\n', files: { '/tmp/gsd-out.json': GOOD_JSON } });
    assert.deepEqual(run(h), { ok: true, phaseDir: '/proj/.planning/phases/03-billing', reqIds: ['BILL-04', 'BILL-05'] });
    const unreadable = harness({ result: '@file:/tmp/missing.json' });
    const r = run(unreadable);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'phase_unresolved');
  });

  it('degradesOnHostFailure', () => {
    const bad = [
      harness({ result: JSON.stringify({ phase_found: false, phase_dir: '/proj/x' }) }),
      harness({ result: 'this is not json' }),
      harness({ result: '' }),
      harness({ result: '[]' }),
      harness({ result: JSON.stringify({ phase_found: true, phase_dir: '' }) }),
      harness({ result: JSON.stringify({ phase_found: true }) }),
      harness({ result: JSON.stringify({ phase_found: 'true', phase_dir: '/proj/x' }) }),
      harness({ result: new Error('spawnSync node ETIMEDOUT') }),
    ];
    for (const h of bad) {
      const r = run(h);
      assert.equal(r.ok, false);
      assert.equal(r.code, 'phase_unresolved');
      assert.equal(typeof r.message, 'string');
      assert.ok(r.message.length > 0);
    }
    const thrown = run(harness({ result: new Error('spawnSync node ETIMEDOUT') }));
    assert.ok(thrown.message.includes('ETIMEDOUT'), thrown.message);
    const notFound = run(harness({ result: JSON.stringify({ phase_found: false }) }), '7');
    assert.ok(notFound.message.includes('7'), notFound.message);
  });

  it('noHostIsReported', () => {
    const noHost = harness({ argv: ['node', '/x/other.cjs'], env: {} });
    const r = run(noHost);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'host_unavailable');
    assert.ok(r.message.includes('--phase-dir'), r.message);
    assert.equal(noHost.execCalls.length, 0);
    // gsd-tools by name, but not a file
    const missing = harness({ argv: ['node', CLI], hostFiles: [] });
    assert.equal(run(missing).code, 'host_unavailable');
    assert.equal(missing.execCalls.length, 0);
    const shortArgv = harness({ argv: ['node'] });
    assert.equal(run(shortArgv).code, 'host_unavailable');
  });

  it('usesGsdToolsEnv', () => {
    const h = harness({ argv: ['node', '/x/other.cjs'], env: { GSD_TOOLS: '/opt/gsd/custom-tools' }, hostFiles: ['/opt/gsd/custom-tools'] });
    assert.equal(run(h).ok, true);
    assert.equal(h.execCalls[0].args[0], '/opt/gsd/custom-tools');
    assert.equal(findHostCli({ env: { GSD_TOOLS: '/opt/gsd/custom-tools' }, argv: ['node', CLI], isFile: () => true }), '/opt/gsd/custom-tools');
    assert.equal(findHostCli({ env: { GSD_TOOLS: '/nope' }, argv: ['node', CLI], isFile: (p) => p === CLI }), CLI);
    assert.equal(findHostCli({ env: {}, argv: ['node', '/opt/gsd/bin/gsd-tools'], isFile: () => true }), '/opt/gsd/bin/gsd-tools');
    assert.equal(findHostCli({ env: { GSD_TOOLS: '' }, argv: ['node', '/x/other.cjs'], isFile: () => true }), null);
    assert.equal(findHostCli({ env: {}, argv: ['node', CLI], isFile: () => false }), null);
  });

  it('rejectsBadPhaseToken', () => {
    for (const phase of ['1;rm', '', 'x'.repeat(200), ' 3', '-3', '3 4', '$(id)', 5, undefined, null]) {
      const h = harness();
      const r = resolvePhase({ phase, cwd: CWD, env: h.env, argv: h.argv, deps: h.deps });
      assert.equal(r.ok, false, JSON.stringify(phase));
      assert.equal(r.code, 'usage', JSON.stringify(phase));
      assert.equal(h.execCalls.length, 0, JSON.stringify(phase));
    }
    for (const phase of ['3', '03', '3.1', 'abc-1_2', 'x'.repeat(64)]) {
      const h = harness();
      assert.equal(run(h, phase).ok, true, phase);
      assert.equal(h.execCalls.length, 1);
    }
  });

  it('boundedSubprocess', () => {
    const h = harness();
    run(h, '3');
    const opts = h.execCalls[0].opts;
    assert.equal(opts.timeout, HOST_TIMEOUT_MS);
    assert.equal(typeof HOST_TIMEOUT_MS, 'number');
    assert.ok(Number.isInteger(HOST_TIMEOUT_MS) && HOST_TIMEOUT_MS > 0);
    assert.equal(opts.cwd, CWD);
    assert.equal(opts.encoding, 'utf8');
    assert.equal(opts.maxBuffer, 16 * 1024 * 1024);
    assert.equal(opts.windowsHide, true);
    assert.ok(!opts.shell, 'no shell');
    assert.ok(Array.isArray(h.execCalls[0].args));
  });
});

const { ENFORCE_TIMEOUT_MS, MAX_REQUEST_CHARS, MAX_STATEMENT_CHARS, enforcementRequest, runEnforcement } = require('../lib/host.cjs');
const { testOrder } = require('./helpers/fixtures.cjs');

const ELL = String.fromCharCode(0x2026);
const GREEN = JSON.stringify({ status: 'green', flagged: false, tier: 'test', reason: 'ok', located: true, kind: 'node-test', evidence: [] });
const FLAGGED = JSON.stringify({
  status: 'unverified',
  flagged: true,
  tier: 'test',
  reason: 'test-tier prohibition has no passing wired enforcement check',
  located: true,
  kind: 'node-test',
  evidence: [],
});

const ORDER = testOrder({
  id: 'T-1',
  statement: 'Never double refund.',
  check_target: 'tests/x.test.cjs',
  check_violation_fixture: 'tests/fixtures/bad.js',
  check_clean_fixture: 'tests/fixtures/good.js',
});

const failure = (reason) => ({ id: 'T-1', status: 'unverified', flagged: true, reason, located: false, kind: null, evidence: [] });

/** Like `harness`, but `result` may be a function of the parsed request. */
function eharness({ result = GREEN, files = {}, hostFiles = [CLI], argv = ['node', CLI], env = {} } = {}) {
  return harness({ result, files, hostFiles, argv, env });
}

const enforce = (h, order = ORDER) => runEnforcement({ order, cwd: CWD, env: h.env, argv: h.argv, deps: h.deps });

describe('host enforcementRequest', () => {
  it('exportsTheEnforcementBounds', () => {
    assert.equal(ENFORCE_TIMEOUT_MS, 180000);
    assert.equal(MAX_REQUEST_CHARS, 28000);
    assert.equal(MAX_STATEMENT_CHARS, 500);
  });

  it('enforcementRequestTruncation', () => {
    const statementOf = (n) => enforcementRequest(testOrder({ id: 'T-1', statement: 'a'.repeat(n - 1) + 'z' })).prohibition.statement;
    const under = statementOf(MAX_STATEMENT_CHARS - 1);
    assert.equal(under.length, MAX_STATEMENT_CHARS - 1);
    assert.ok(under.endsWith('z'));
    const at = statementOf(MAX_STATEMENT_CHARS);
    assert.equal(at.length, MAX_STATEMENT_CHARS);
    assert.ok(at.endsWith('z'), 'a statement at the limit is untouched');
    const over = statementOf(MAX_STATEMENT_CHARS + 1);
    assert.equal(over, 'a'.repeat(MAX_STATEMENT_CHARS) + ELL, 'first limit chars plus an ellipsis');
  });

  it('enforcementRequestShape', () => {
    assert.deepEqual(enforcementRequest(ORDER), {
      prohibition: { id: 'T-1', statement: 'Never double refund.', status: 'resolved', verification: 'test' },
      check: { kind: 'node-test', target: 'tests/x.test.cjs', violationFixture: 'tests/fixtures/bad.js', cleanFixture: 'tests/fixtures/good.js' },
    });
    const lint = testOrder({ id: 'L-1', statement: 'No eval.', check_kind: 'lint-rule', check_target: 'src/a.js', check_rule: 'local/no-eval' });
    assert.deepEqual(enforcementRequest(lint).check, {
      kind: 'lint-rule',
      target: 'src/a.js',
      rule: 'local/no-eval',
      violationFixture: 'tests/fixtures/bad.js',
      cleanFixture: 'tests/fixtures/good.js',
    });
    const stray = testOrder({ id: 'T-2', check_rule: 'local/stray', check_violation_fixture: null, check_clean_fixture: '' });
    assert.deepEqual(enforcementRequest(stray).check, { kind: 'node-test', target: 'tests/x.test.cjs' });
    const emptyRule = testOrder({ id: 'L-2', check_kind: 'lint-rule', check_rule: '', check_violation_fixture: null, check_clean_fixture: null });
    assert.deepEqual(enforcementRequest(emptyRule).check, { kind: 'lint-rule', target: 'tests/x.test.cjs' });
  });
});

describe('host runEnforcement', () => {
  it('runEnforcementGreen', () => {
    const h = eharness();
    const r = enforce(h);
    assert.deepEqual(r, { id: 'T-1', status: 'green', flagged: false, reason: 'ok', located: true, kind: 'node-test', evidence: [] });
    assert.equal(h.execCalls.length, 1);
    const call = h.execCalls[0];
    assert.equal(call.file, '/usr/bin/node');
    assert.deepEqual(call.args, [CLI, 'check', 'prohibition-enforcement', '--json', JSON.stringify(enforcementRequest(ORDER))]);
    assert.equal(call.opts.cwd, CWD);
    assert.equal(call.opts.timeout, ENFORCE_TIMEOUT_MS);
    assert.equal(call.opts.encoding, 'utf8');
    assert.equal(call.opts.maxBuffer, 16 * 1024 * 1024);
    assert.equal(call.opts.windowsHide, true);
    assert.ok(!call.opts.shell, 'no shell');
  });

  // AC3 (unit): a check that passes on its violation fixture is reported flagged, never green.
  it('runEnforcementFlagged', () => {
    const r = enforce(eharness({ result: FLAGGED }));
    assert.deepEqual(r, {
      id: 'T-1',
      status: 'unverified',
      flagged: true,
      reason: 'test-tier prohibition has no passing wired enforcement check',
      located: true,
      kind: 'node-test',
      evidence: [],
    });
    // contradictory or partial host output is passed through, never upgraded
    assert.equal(enforce(eharness({ result: JSON.stringify({ status: 'green', flagged: true }) })).flagged, true);
    assert.equal(enforce(eharness({ result: JSON.stringify({ status: 'green' }) })).flagged, true, 'a missing flagged field is flagged');
    assert.equal(enforce(eharness({ result: JSON.stringify({ status: 'green', flagged: 'false' }) })).flagged, true);
    const odd = enforce(eharness({ result: JSON.stringify({ status: 7, flagged: false, reason: 4, located: 'yes', kind: 3, evidence: 'x' }) }));
    assert.deepEqual(odd, { id: 'T-1', status: 'unverified', flagged: false, reason: '', located: false, kind: null, evidence: [] });
  });

  it('runEnforcementTimeout', () => {
    const base = () => new Error('spawnSync node ETIMEDOUT');
    const byCode = Object.assign(base(), { code: 'ETIMEDOUT' });
    const byKilled = Object.assign(base(), { killed: true });
    const bySignal = Object.assign(base(), { signal: 'SIGTERM' });
    for (const e of [byCode, byKilled, bySignal]) {
      const h = eharness({ result: e });
      let r;
      assert.doesNotThrow(() => {
        r = enforce(h);
      });
      assert.deepEqual(r, failure(`host_timeout: no verdict within ${ENFORCE_TIMEOUT_MS} ms`));
      assert.equal(h.execCalls.length, 1);
    }
    // a plain non-zero exit, even with a null signal, is not a timeout
    const exited = Object.assign(new Error('Command failed'), { status: 1, signal: null, killed: false, stderr: 'boom' });
    assert.ok(enforce(eharness({ result: exited })).reason.startsWith('host_failed: exit 1'));
  });

  it('runEnforcementExitNonZero', () => {
    const exit2 = Object.assign(new Error('Command failed'), { status: 2, signal: null, stderr: '\n\n  first real line\nsecond line\n' });
    assert.deepEqual(enforce(eharness({ result: exit2 })), failure('host_failed: exit 2: first real line'));
    const long = Object.assign(new Error('Command failed'), { status: 1, signal: null, stderr: 'x'.repeat(500) + '\nnext' });
    assert.deepEqual(enforce(eharness({ result: long })), failure('host_failed: exit 1: ' + 'x'.repeat(200)));
    const asBuffer = Object.assign(new Error('Command failed'), { status: 69, signal: null, stderr: Buffer.from('from a buffer\nmore') });
    assert.deepEqual(enforce(eharness({ result: asBuffer })), failure('host_failed: exit 69: from a buffer'));
  });

  it('runEnforcementBadOutput', () => {
    for (const out of ['0', '"s"', '[]', 'null', 'true', 'not json', '', '   \n', '{"status":']) {
      const h = eharness({ result: out });
      let r;
      assert.doesNotThrow(() => {
        r = enforce(h);
      }, JSON.stringify(out));
      assert.equal(r.status, 'unverified', JSON.stringify(out));
      assert.equal(r.flagged, true, JSON.stringify(out));
      assert.ok(r.reason.startsWith('host_output_invalid'), `${JSON.stringify(out)} -> ${r.reason}`);
      assert.equal(r.located, false);
      assert.equal(r.kind, null);
      assert.deepEqual(r.evidence, []);
      assert.equal(r.id, 'T-1');
    }
  });

  it('runEnforcementFileOutput', () => {
    const viaFile = eharness({ result: '@file:/tmp/gsd-enforce.json\n', files: { '/tmp/gsd-enforce.json': GREEN } });
    assert.equal(enforce(viaFile).status, 'green');
    assert.equal(enforce(viaFile).flagged, false);
    const trimmed = eharness({ result: '\n  ' + GREEN + '\n\n' });
    assert.equal(enforce(trimmed).status, 'green');
    const unreadable = eharness({ result: '@file:/tmp/missing.json' });
    const r = enforce(unreadable);
    assert.equal(r.flagged, true);
    assert.ok(r.reason.startsWith('host_output_invalid: '), r.reason);
    assert.ok(r.reason.includes('ENOENT /tmp/missing.json'), r.reason);
    const notJson = eharness({ result: '@file:/tmp/x.json', files: { '/tmp/x.json': 'nope' } });
    assert.ok(enforce(notJson).reason.startsWith('host_output_invalid'));
  });

  it('runEnforcementNoHost', () => {
    const noHost = eharness({ argv: ['node', '/x/other.cjs'], env: {} });
    assert.deepEqual(enforce(noHost), failure('host_unavailable: the host CLI (gsd-tools) was not found'));
    assert.equal(noHost.execCalls.length, 0);
    const notAFile = eharness({ hostFiles: [] });
    assert.equal(enforce(notAFile).reason, 'host_unavailable: the host CLI (gsd-tools) was not found');
    assert.equal(notAFile.execCalls.length, 0);
    const viaEnv = eharness({ argv: ['node', '/x/other.cjs'], env: { GSD_TOOLS: '/opt/gsd/custom-tools' }, hostFiles: ['/opt/gsd/custom-tools'] });
    assert.equal(enforce(viaEnv).status, 'green');
    assert.equal(viaEnv.execCalls[0].args[0], '/opt/gsd/custom-tools');
  });

  it('runEnforcementRequestBound', () => {
    const baseLen = JSON.stringify(enforcementRequest(testOrder({ id: 'T-1', check_target: '' }))).length;
    const atLimit = testOrder({ id: 'T-1', check_target: 'a'.repeat(MAX_REQUEST_CHARS - baseLen) });
    assert.equal(JSON.stringify(enforcementRequest(atLimit)).length, MAX_REQUEST_CHARS);
    const spawned = eharness();
    assert.equal(enforce(spawned, atLimit).status, 'green');
    assert.equal(spawned.execCalls.length, 1);

    const overLimit = testOrder({ id: 'T-1', check_target: 'a'.repeat(MAX_REQUEST_CHARS - baseLen + 1) });
    const blocked = eharness();
    assert.deepEqual(enforce(blocked, overLimit), failure(`request_too_large: ${MAX_REQUEST_CHARS + 1} chars`));
    assert.equal(blocked.execCalls.length, 0, 'an oversized request is never spawned');
  });
});
