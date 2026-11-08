'use strict';

// Host contract suite: exercises the capability against a REAL gsd-core host.
// Every test is skipped unless GSD_CORE_DIR names a gsd-core checkout/package root.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const GSD_CORE_DIR = process.env.GSD_CORE_DIR || '';
const SKIP_MSG = 'set GSD_CORE_DIR to a gsd-core install to run host contract tests';
const CLI = GSD_CORE_DIR ? path.join(GSD_CORE_DIR, 'gsd-core', 'bin', 'gsd-tools.cjs') : '';
const LIB = GSD_CORE_DIR ? path.join(GSD_CORE_DIR, 'gsd-core', 'bin', 'lib') : '';

const POINTS = [
  'discuss:pre', 'discuss:post', 'plan:pre', 'plan:post', 'execute:pre', 'execute:wave:pre',
  'execute:wave:post', 'execute:post', 'verify:pre', 'verify:post', 'ship:pre', 'ship:post',
];

const ROADMAP = [
  '# Roadmap',
  '',
  '## Phases',
  '',
  '- [ ] **Phase 3: Billing** - refunds',
  '',
  '## Phase Details',
  '',
  '### Phase 3: Billing',
  '**Goal**: refunds work',
  '**Requirements**: BILL-04, BILL-05',
  '**Success Criteria**:',
  '  1. refunds',
  '',
].join('\n');

const BUNDLE_ITEMS = ['capability.json', 'standing-orders-router.cjs', 'lib', 'fragments', 'references', 'package.json', 'LICENSE', 'README.md'];

const tempDirs = [];
after(() => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

function mkTemp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'so-host-'));
  tempDirs.push(d);
  return d;
}

function hostTimeout() {
  return require('../lib/host.cjs').HOST_TIMEOUT_MS;
}

function makeBundle() {
  const base = mkTemp();
  const dir = path.join(base, 'standing-orders');
  fs.mkdirSync(dir);
  for (const item of BUNDLE_ITEMS) {
    const src = path.join(REPO, item);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(dir, item), { recursive: true });
  }
  return dir;
}

function run(args, cwd, home) {
  return childProcess.execFileSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: hostTimeout(),
    env: { ...process.env, HOME: home },
  });
}

function tryRun(args, cwd, home) {
  try {
    return { ok: true, stdout: run(args, cwd, home), stderr: '' };
  } catch (e) {
    return { ok: false, stdout: String(e.stdout || ''), stderr: String(e.stderr || ''), error: e };
  }
}

function lastJson(stdout) {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

function makeProject(config) {
  const cwd = mkTemp();
  const home = mkTemp();
  fs.mkdirSync(path.join(cwd, '.planning', 'phases', '03-billing'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), ROADMAP);
  fs.writeFileSync(
    path.join(cwd, '.planning', 'phases', '03-billing', '03-CONTEXT.md'),
    'Touches `src/billing/refund.js` for refunds.\n',
  );
  if (config !== undefined) {
    fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  }
  return { cwd, home };
}

function install(project, bundle) {
  return run(['capability', 'install', bundle, '--scope', 'project', '--yes'], project.cwd, project.home);
}

function gated(name, fn) {
  test(name, (t) => {
    if (!GSD_CORE_DIR) {
      t.skip(SKIP_MSG);
      return;
    }
    fn(t);
  });
}

function renderHooks(project, point) {
  return run(['loop', 'render-hooks', point, '--raw'], project.cwd, project.home);
}

function ours(hooks) {
  return hooks.filter((h) => h && h.capId === 'standing-orders');
}

const ORDERS_HEAD = ['version: "1"', 'contexts:', '  contract-a: {}', '  contract-b: {}', '  any-contract:', '    includes: [contract-a, contract-b]', 'orders:'];
const ORDER_A = [
  '  - id: REFUND-AMOUNT-A', '    kind: variant', '    statement: "Full refund under contract A."', '    operation: refund.amount',
  '    outcome: full', '    contexts: [contract-a]', '    scope:', '      paths: ["src/billing/**"]', '    verification: backstop',
];
const ORDER_B = [
  '  - id: REFUND-AMOUNT-B', '    kind: variant', '    statement: "Prorated refund under any contract."', '    operation: refund.amount',
  '    outcome: prorated', '    contexts: [any-contract]', '    scope:', '      paths: ["src/billing/**"]', '    verification: backstop',
];
const ORDER_UI = [
  '  - id: UI-ONLY', '    kind: invariant', '    statement: "UI rule."', '    scope:', '      paths: ["src/ui/**"]', '    verification: backstop',
];

function writeOrders(cwd, blocks) {
  const dir = path.join(cwd, '.planning', 'standing-orders');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ORDERS.yaml'), [...ORDERS_HEAD, ...blocks.flat()].join('\n') + '\n');
}

gated('manifestValidates', () => {
  const v = require(path.join(LIB, 'capability-validator.cjs'));
  const cap = JSON.parse(fs.readFileSync(path.join(REPO, 'capability.json'), 'utf8'));
  const dir = makeBundle();
  assert.deepEqual(v.validateCapability(cap, 'standing-orders'), []);
  assert.deepEqual(v.validateAgainstContract(cap, 'standing-orders'), []);
  assert.deepEqual(v.materializeHookFragments(cap, dir), []);
});

gated('installsFromLocalPathAndDispatches', () => {
  const bundle = makeBundle();
  const project = makeProject();
  install(project, bundle);
  const out = run(['standing-orders', 'validate', '--raw'], project.cwd, project.home);
  const lines = out.split('\n').filter((l) => l.trim());
  assert.equal(lines.length, 1);
  const report = JSON.parse(lines[0]);
  assert.equal(report.schema, 1);
  assert.equal(report.errors[0].code, 'file_not_found');
});

test('installsFromGit', (t) => {
  if (!GSD_CORE_DIR) {
    t.skip(SKIP_MSG);
    return;
  }
  const source = process.env.STANDING_ORDERS_GIT_SOURCE;
  if (!source) {
    t.skip('set STANDING_ORDERS_GIT_SOURCE to a git install URL to run this test');
    return;
  }
  const project = makeProject();
  run(['capability', 'install', source, '--scope', 'project', '--yes'], project.cwd, project.home);
  const list = run(['capability', 'list'], project.cwd, project.home);
  assert.ok(list.includes('standing-orders'), list);
});

gated('disabledRenderHooksByteIdentical', () => {
  const bundle = makeBundle();
  for (const config of [{}, { 'standing-orders': { enabled: false } }]) {
    const a = makeProject(config);
    install(a, bundle);
    const b = { cwd: mkTemp(), home: mkTemp() };
    fs.cpSync(path.join(a.cwd, '.planning'), path.join(b.cwd, '.planning'), { recursive: true });
    for (const point of POINTS) {
      assert.equal(renderHooks(a, point), renderHooks(b, point), `render-hooks ${point} differs (config ${JSON.stringify(config)})`);
    }
  }
});

gated('enabledHooksRender', () => {
  const bundle = makeBundle();
  const project = makeProject({ 'standing-orders': { enabled: true } });
  install(project, bundle);

  const pre = ours(JSON.parse(renderHooks(project, 'plan:pre')).activeHooks);
  const steps = pre.filter((h) => h.ref && h.ref.command === 'standing-orders select');
  assert.equal(steps.length, 1, JSON.stringify(pre));
  const contributions = pre.filter((h) => h.fragment && typeof h.fragment.inline === 'string' && h.fragment.inline.includes('in addition to'));
  assert.equal(contributions.length, 1, JSON.stringify(pre));
  const preGates = pre.filter((h) => h.check && h.check.predicate);
  assert.equal(preGates.length, 1, JSON.stringify(pre));
  assert.equal(preGates[0].check.predicate.field, 'conflicts');

  const post = ours(JSON.parse(renderHooks(project, 'plan:post')).activeHooks);
  const postSteps = post.filter((h) => h.ref && h.ref.command === 'standing-orders coverage');
  assert.equal(postSteps.length, 1, JSON.stringify(post));
  const fields = post.filter((h) => h.check && h.check.predicate).map((h) => h.check.predicate.field).sort();
  assert.deepEqual(fields, ['conflicts', 'coverage']);
});

gated('hostRunsSelectAndPredicateReadsVerdict', () => {
  const bundle = makeBundle();
  const project = makeProject({ 'standing-orders': { enabled: true } });
  install(project, bundle);
  const { cwd, home } = project;
  const predicate = JSON.stringify({ kind: 'artifact-frontmatter-equals', artifact: 'STANDING-ORDERS.md', field: 'conflicts', equals: 'clear' });
  const phaseDir = '.planning/phases/03-billing';
  const check = () => lastJson(run([
    'check', 'predicate', '--predicate', predicate, '--phase-dir', phaseDir,
    '--phase-number', '3', '--phase-req-ids', 'BILL-04', '--raw',
  ], cwd, home));

  writeOrders(cwd, [ORDER_A, ORDER_B, ORDER_UI]);
  const first = tryRun(['standing-orders', 'select', '--phase', '3', '--raw'], cwd, home);
  const r1 = lastJson(first.stdout);
  assert.equal(r1.conflicts, 'blocked', first.stdout + first.stderr);
  const applicable = fs.readFileSync(path.join(cwd, '.planning', 'standing-orders', 'APPLICABLE.md'), 'utf8');
  assert.ok(applicable.includes('REFUND-AMOUNT-A'));
  assert.ok(!applicable.includes('UI-ONLY'));
  assert.equal(check().block, true);

  writeOrders(cwd, [ORDER_A, ORDER_UI]);
  const second = tryRun(['standing-orders', 'select', '--phase', '3', '--raw'], cwd, home);
  const r2 = lastJson(second.stdout);
  assert.equal(r2.conflicts, 'clear', second.stdout + second.stderr);
  assert.equal(check().block, false);
});

gated('configParityWithHost', () => {
  const hostCfg = require(path.join(LIB, 'capability-activation.cjs'));
  const { resolveConfigValue } = require('../lib/config.cjs');
  const keys = ['standing-orders.enabled', 'standing-orders.block_on'];

  const fixtures = [
    { name: 'root nested enabled', root: { 'standing-orders': { enabled: true } } },
    { name: 'root flat key', root: { 'standing-orders.enabled': true } },
    { name: 'root invalid json', root: '{not json' },
    { name: 'workstream override with env', root: { 'standing-orders': { block_on: 'conflict' } }, ws: { 'standing-orders': { block_on: 'never' } }, env: 'ws1' },
    { name: 'workstream override without env', root: { 'standing-orders': { block_on: 'conflict' } }, ws: { 'standing-orders': { block_on: 'never' } } },
  ];

  const saved = { ws: process.env.GSD_WORKSTREAM, proj: process.env.GSD_PROJECT };
  try {
    delete process.env.GSD_PROJECT;
    for (const f of fixtures) {
      const cwd = mkTemp();
      fs.mkdirSync(path.join(cwd, '.planning'), { recursive: true });
      fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), typeof f.root === 'string' ? f.root : JSON.stringify(f.root));
      if (f.ws) {
        const wsDir = path.join(cwd, '.planning', 'workstreams', 'ws1');
        fs.mkdirSync(wsDir, { recursive: true });
        fs.writeFileSync(path.join(wsDir, 'config.json'), JSON.stringify(f.ws));
      }
      if (f.env) process.env.GSD_WORKSTREAM = f.env;
      else delete process.env.GSD_WORKSTREAM;
      for (const key of keys) {
        const host = hostCfg.resolveConfigKey(key, { config: {}, cwd, registry: { configSchema: {} }, quiet: true });
        const mine = resolveConfigValue(key, { cwd, env: process.env, readFile: (p) => fs.readFileSync(p, 'utf8') });
        assert.deepEqual(
          { found: mine.found, value: mine.value },
          { found: host.found, value: host.value },
          `${f.name}: ${key}`,
        );
      }
    }
  } finally {
    if (saved.ws === undefined) delete process.env.GSD_WORKSTREAM;
    else process.env.GSD_WORKSTREAM = saved.ws;
    if (saved.proj === undefined) delete process.env.GSD_PROJECT;
    else process.env.GSD_PROJECT = saved.proj;
  }
});
