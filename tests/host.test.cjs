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
      const r = run(h, phase);
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
