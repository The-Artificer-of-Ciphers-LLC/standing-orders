'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { routeStandingOrdersCommand, DEFAULT_ORDERS_PATH, MAX_FILE_BYTES } = require('../standing-orders-router.cjs');
const { ADR_EXAMPLE, doc, variant, testOrder } = require('./helpers/fixtures.cjs');

const CWD = path.resolve(path.sep, 'proj');

/** Build an in-memory filesystem seam: files is { relativePath: text }. */
function memDeps(files, overrides = {}) {
  const abs = {};
  for (const [rel, text] of Object.entries(files)) abs[path.resolve(CWD, rel)] = text;
  const calls = { readFile: [], exists: [], log: [], error: [] };
  const deps = {
    exists: (p) => { calls.exists.push(p); return Object.prototype.hasOwnProperty.call(abs, p); },
    statSize: (p) => Buffer.byteLength(abs[p] || '', 'utf8'),
    readFile: (p) => { calls.readFile.push(p); if (!(p in abs)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return abs[p]; },
    log: (m) => calls.log.push(m),
    ...overrides,
  };
  const error = (m) => calls.error.push(m);
  return { deps, error, calls };
}

function run(args, files, { raw = false, overrides } = {}) {
  const { deps, error, calls } = memDeps(files, overrides);
  const result = routeStandingOrdersCommand({ args, cwd: CWD, raw, error, deps });
  return { result, calls };
}

describe('routeStandingOrdersCommand validate', () => {
  it('validatesDefaultPathWithInjectedDeps', () => {
    const { result, calls } = run(['standing-orders', 'validate'], { [DEFAULT_ORDERS_PATH]: ADR_EXAMPLE });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.schema, 1);
    assert.equal(result.file, DEFAULT_ORDERS_PATH.replace(/\\/g, '/'));
    assert.equal(result.summary.orders, 3);
    assert.equal(result.summary.contexts, 3);
    assert.deepEqual(result.summary.byKind, { prohibition: 1, invariant: 0, variant: 2 });
    assert.deepEqual(result.summary.byVerification, { test: 2, backstop: 1 });
    assert.deepEqual(calls.error, []);
    assert.ok(calls.log.length >= 1);
    assert.ok(calls.log.some((l) => /3 order/.test(l)));
    assert.equal(calls.readFile.length, 1);
    assert.ok(calls.readFile[0].endsWith(path.join('.planning', 'standing-orders', 'ORDERS.yaml')));
  });

  it('acceptsAnExplicitRelativeFile', () => {
    const { result, calls } = run(['standing-orders', 'validate', 'rules/ORDERS.yaml'], { 'rules/ORDERS.yaml': ADR_EXAMPLE });
    assert.equal(result.ok, true);
    assert.equal(result.file, 'rules/ORDERS.yaml');
    assert.equal(calls.readFile[0], path.resolve(CWD, 'rules/ORDERS.yaml'));
  });

  it('emitsOneLineJsonWithRaw', () => {
    const { result, calls } = run(['standing-orders', 'validate'], { [DEFAULT_ORDERS_PATH]: ADR_EXAMPLE }, { raw: true });
    assert.equal(calls.log.length, 1);
    assert.equal(calls.log[0].includes('\n'), false);
    const parsed = JSON.parse(calls.log[0]);
    assert.deepEqual(parsed, JSON.parse(JSON.stringify(result)));
    assert.equal(parsed.schema, 1);
  });

  it('rejectsMissingAndUnknownSubcommands', () => {
    for (const args of [['standing-orders'], ['standing-orders', 'frobnicate']]) {
      const { result, calls } = run(args, {});
      assert.equal(result.ok, false);
      assert.equal(calls.error.length, 1);
      assert.ok(calls.error[0].includes('validate'), 'lists available subcommands');
      assert.deepEqual(calls.readFile, []);
    }
  });

  it('refusesPathsOutsideCwd', () => {
    const outside = path.resolve(CWD, '..', 'elsewhere', 'ORDERS.yaml');
    for (const file of ['../outside.yaml', outside, 'a/../../x.yaml']) {
      const { result, calls } = run(['standing-orders', 'validate', file], { [file]: ADR_EXAMPLE });
      assert.equal(result.ok, false, file);
      assert.deepEqual(result.errors.map((e) => e.code), ['path_outside_cwd'], file);
      assert.equal(calls.error.length, 1, file);
      assert.deepEqual(calls.readFile, [], file);
    }
  });

  it('reportsMissingFile', () => {
    const { result, calls } = run(['standing-orders', 'validate'], {});
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors.map((e) => e.code), ['file_not_found']);
    assert.deepEqual(calls.readFile, []);
  });

  it('reportsUnreadableFileWithoutThrowing', () => {
    const { result } = run(['standing-orders', 'validate'], { [DEFAULT_ORDERS_PATH]: ADR_EXAMPLE }, {
      overrides: { readFile: () => { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; } },
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors.map((e) => e.code), ['file_unreadable']);
    assert.ok(result.errors[0].message.includes('EACCES'));
  });

  it('enforcesSizeCapAtBoundary', () => {
    const atCap = run(['standing-orders', 'validate'], { [DEFAULT_ORDERS_PATH]: ADR_EXAMPLE }, { overrides: { statSize: () => MAX_FILE_BYTES } });
    assert.equal(atCap.result.ok, true, 'exactly the cap is accepted');
    assert.equal(atCap.calls.readFile.length, 1);
    const over = run(['standing-orders', 'validate'], { [DEFAULT_ORDERS_PATH]: ADR_EXAMPLE }, { overrides: { statSize: () => MAX_FILE_BYTES + 1 } });
    assert.equal(over.result.ok, false);
    assert.deepEqual(over.result.errors.map((e) => e.code), ['file_too_large']);
    assert.deepEqual(over.calls.readFile, []);
  });

  it('routerIsSynchronous', () => {
    const { result } = run(['standing-orders', 'validate'], { [DEFAULT_ORDERS_PATH]: ADR_EXAMPLE });
    assert.equal(typeof result.then, 'undefined');
  });

  it('reportIncludesConflictsAndMissingChecks', () => {
    const text = doc({
      contexts: { a: {}, b: {}, all: { includes: ['a', 'b'] } },
      orders: [
        variant('X', 'op', ['all'], 'full'),
        variant('Y', 'op', ['a'], 'prorated'),
        testOrder({ id: 'T', check_target: 'tests/absent.test.cjs' }),
      ],
    });
    const { result, calls } = run(['standing-orders', 'validate'], { [DEFAULT_ORDERS_PATH]: text });
    assert.equal(result.ok, false, 'a conflict makes the file invalid');
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].kind, 'variant-outcome');
    assert.deepEqual(result.missingChecks, [{ id: 'T', check_target: 'tests/absent.test.cjs' }]);
    assert.ok(result.warnings.some((w) => w.code === 'check_target_missing'));
    assert.ok(calls.exists.some((p) => p === path.resolve(CWD, 'tests/absent.test.cjs')), 'check target probed under cwd');
  });

  it('parseErrorsMakeTheReportInvalid', () => {
    const { result, calls } = run(['standing-orders', 'validate'], { [DEFAULT_ORDERS_PATH]: 'version: 2\n' });
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors.map((e) => e.code), ['version_unsupported']);
    assert.deepEqual(result.conflicts, []);
    assert.ok(calls.log.some((l) => /version_unsupported/.test(l)), 'human output names the error code');
  });
});

describe('direct CLI', () => {
  const ROUTER = path.resolve(__dirname, '..', 'standing-orders-router.cjs');

  function cli(args, cwd) {
    try {
      const stdout = execFileSync(process.execPath, [ROUTER, ...args], { cwd, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
      return { status: 0, stdout };
    } catch (e) {
      return { status: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
    }
  }

  it('directCliExitCodes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'so-cli-'));
    try {
      fs.writeFileSync(path.join(dir, 'good.yaml'), ADR_EXAMPLE);
      fs.writeFileSync(path.join(dir, 'bad.yaml'), 'version: 2\n');
      const good = cli(['validate', 'good.yaml', '--raw'], dir);
      assert.equal(good.status, 0, good.stderr);
      const report = JSON.parse(good.stdout.trim());
      assert.equal(report.ok, true);
      assert.equal(report.summary.orders, 3);

      const bad = cli(['validate', 'bad.yaml', '--raw'], dir);
      assert.equal(bad.status, 1);
      assert.equal(JSON.parse(bad.stdout.trim()).ok, false);

      const missing = cli(['validate', 'nope.yaml'], dir);
      assert.equal(missing.status, 2);

      const usage = cli(['frobnicate'], dir);
      assert.equal(usage.status, 1);
      assert.ok(/validate/.test(usage.stderr));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
