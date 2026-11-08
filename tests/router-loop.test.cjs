'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { routeStandingOrdersCommand, SUBCOMMANDS, APPLICABLE_PATH, CONFLICTS_PATH, exitCodeFor } = require('../standing-orders-router.cjs');
const { doc, order, variant, yamlOf } = require('./helpers/fixtures.cjs');
const { memfs } = require('./helpers/memfs.cjs');

const CONFIG = '.planning/config.json';
const ORDERS = '.planning/standing-orders/ORDERS.yaml';
const PHASE = '.planning/phases/03-billing';
const VERDICT = `${PHASE}/STANDING-ORDERS.md`;
const PHASE_FLAG = ['--phase-dir', PHASE];

const enabledConfig = (extra = {}) => JSON.stringify({ 'standing-orders': { enabled: true, ...extra } });

const SCOPE_BILLING = { paths: ['src/billing/**'] };
const SCOPE_UI = { paths: ['src/ui/**'] };

const AC1_ORDERS = doc({
  orders: [order({ id: 'BILL-RULE', scope: SCOPE_BILLING }), order({ id: 'UI-RULE', scope: SCOPE_UI })],
});

const CONFLICT_ORDERS = doc({
  contexts: { 'ctx-a': { description: 'a' } },
  orders: [
    variant('REF-A', 'refund.amount', ['ctx-a'], 'full', { scope: SCOPE_BILLING }),
    variant('REF-B', 'refund.amount', ['ctx-a'], 'prorated', { scope: SCOPE_BILLING }),
  ],
});

const CONTEXT_MD = 'The refund change touches `src/billing/refund.js`.\n';

function planText({ files = [], truths = [], prohibitions }) {
  const mustHaves = { truths };
  if (prohibitions !== undefined) mustHaves.prohibitions = prohibitions;
  const data = { requirements: ['X-1'], must_haves: mustHaves };
  if (files.length > 0) data.files_modified = files;
  return '---\n' + yamlOf(data) + '---\nbody\n';
}

function setup({ config = enabledConfig(), orders = AC1_ORDERS, files = {}, overrides = {}, links = {}, contextMd = CONTEXT_MD } = {}) {
  const all = { ...files };
  if (config !== null) all[CONFIG] = config;
  if (orders !== null) all[ORDERS] = orders;
  if (contextMd !== null) all[`${PHASE}/03-CONTEXT.md`] = contextMd;
  return memfs({ files: all, links, overrides });
}

function run(m, sub, extra = PHASE_FLAG, { raw = true } = {}) {
  const result = routeStandingOrdersCommand({ args: ['standing-orders', sub, ...extra], cwd: m.cwd, raw, error: m.error, deps: m.deps });
  assert.equal(typeof result.then, 'undefined', 'router never returns a Promise');
  return result;
}

const noWrites = (m) => {
  assert.deepEqual(m.calls.writeFile, []);
  assert.deepEqual(m.calls.rename, []);
  assert.deepEqual(m.calls.mkdir, []);
};

describe('router loop subcommands', () => {
  it('exportsTheSubcommandTable', () => {
    assert.deepEqual([...SUBCOMMANDS], ['select', 'conflicts', 'coverage', 'enforce', 'trace', 'impact', 'stale', 'validate', 'promote', 'semantic', 'mutants']);
    assert.equal(APPLICABLE_PATH, '.planning/standing-orders/APPLICABLE.md');
    assert.equal(CONFLICTS_PATH, '.planning/standing-orders/CONFLICTS.json');
    assert.equal(ENFORCEMENT_PATH, '.planning/standing-orders/ENFORCEMENT.json');
  });

  // AC5: disabled means no writes and nothing read but the config files.
  it('selectDisabledWritesNothing', () => {
    for (const config of [null, JSON.stringify({ 'standing-orders': { enabled: false } })]) {
      const m = setup({ config });
      const r = run(m, 'select');
      assert.equal(r.ok, true);
      assert.equal(r.disabled, true);
      assert.equal(r.subcommand, 'select');
      assert.equal(r.message, 'standing-orders is not enabled; set standing-orders.enabled to true');
      assert.deepEqual(r.written, []);
      noWrites(m);
      assert.ok(m.calls.readFile.length > 0);
      for (const p of m.calls.readFile) assert.ok(p.endsWith('config.json'), p);
      assert.equal(m.calls.execFile.length, 0);
      assert.equal(m.calls.log.length, 1);
      assert.equal(JSON.parse(m.calls.log[0]).disabled, true);
      assert.deepEqual(m.calls.error, []);
      assert.equal(exitCodeFor(r), 0);
    }
  });

  it('coverageDisabledWritesNothing', () => {
    for (const sub of ['coverage', 'conflicts']) {
      for (const config of [null, JSON.stringify({ 'standing-orders': { enabled: false } })]) {
        const m = setup({ config });
        const r = run(m, sub);
        assert.equal(r.ok, true, sub);
        assert.equal(r.disabled, true, sub);
        assert.deepEqual(r.written, [], sub);
        noWrites(m);
        for (const p of m.calls.readFile) assert.ok(p.endsWith('config.json'), p);
      }
    }
    const human = setup({ config: null });
    run(human, 'select', PHASE_FLAG, { raw: false });
    assert.deepEqual(human.calls.log, ['standing-orders is not enabled; set standing-orders.enabled to true']);
  });

  // AC1: only the order whose scope matches a phase file is applicable.
  it('selectWritesOnlyApplicableOrders', () => {
    const m = setup();
    const r = run(m, 'select');
    assert.equal(r.ok, true);
    assert.equal(r.disabled, false);
    assert.deepEqual(r.applicable, ['BILL-RULE']);
    const applicable = m.read(APPLICABLE_PATH);
    assert.ok(applicable.includes('BILL-RULE'));
    assert.ok(!applicable.includes('UI-RULE'));
    assert.deepEqual(r.written, [VERDICT, APPLICABLE_PATH, CONFLICTS_PATH]);
    assert.equal(r.phase.dir, PHASE);
    assert.equal(r.conflicts, 'clear');
    assert.equal(r.coverage, 'pending');
    assert.equal(exitCodeFor(r), 0);
  });

  // AC2: conflicting applicable variants block planning.
  it('selectBlocksOnConflict', () => {
    const m = setup({ orders: CONFLICT_ORDERS });
    const r = run(m, 'select');
    assert.equal(r.ok, true);
    assert.equal(r.conflicts, 'blocked');
    assert.deepEqual(r.applicable, ['REF-A', 'REF-B']);
    assert.ok(m.read(VERDICT).split('\n').includes('conflicts: blocked'));
    const conflictsJson = JSON.parse(m.read(CONFLICTS_PATH));
    assert.equal(conflictsJson.schema, 1);
    assert.equal(conflictsJson.status, 'blocked');
    assert.equal(conflictsJson.phase, PHASE);
    assert.equal(conflictsJson.conflicts.length, 1);
    assert.deepEqual(conflictsJson.conflicts[0].orders, ['REF-A', 'REF-B']);
    assert.equal(conflictsJson.conflicts[0].applicable, true);
    assert.equal(conflictsJson.reasons[0].code, 'conflict');
    assert.equal(exitCodeFor(r), 1);
  });

  it('selectNeverBlocksWithBlockOnNever', () => {
    const m = setup({ orders: CONFLICT_ORDERS, config: enabledConfig({ block_on: 'never' }) });
    const r = run(m, 'select');
    assert.equal(r.conflicts, 'clear');
    assert.ok(m.read(VERDICT).split('\n').includes('conflicts: clear'));
    assert.equal(JSON.parse(m.read(CONFLICTS_PATH)).conflicts.length, 1);
  });

  it('phaseDirOutsideRefused', () => {
    const outside = setup();
    const r1 = run(outside, 'select', ['--phase-dir', '../outside']);
    assert.equal(r1.ok, false);
    assert.equal(r1.errors[0].code, 'path_outside_cwd');
    assert.equal(outside.calls.error.length, 1);
    noWrites(outside);
    assert.deepEqual(r1.written, []);

    const linked = setup({ links: { '.planning/phases/evil': '/etc/outside' } });
    const r2 = run(linked, 'select', ['--phase-dir', '.planning/phases/evil']);
    assert.equal(r2.ok, false);
    assert.equal(r2.errors[0].code, 'path_outside_cwd');
    assert.equal(linked.calls.error.length, 1);
    noWrites(linked);

    const absent = setup();
    const r3 = run(absent, 'select', ['--phase-dir', '.planning/phases/99-none']);
    assert.equal(r3.ok, false);
    assert.equal(r3.errors[0].code, 'phase_dir_not_found');
    assert.equal(absent.calls.error.length, 1);
    noWrites(absent);
    assert.equal(exitCodeFor(r3), 2);
  });

  it('usageErrors', () => {
    const cases = [
      ['--phase', '3', '--phase-dir', PHASE],
      ['--phase-dir', PHASE, '--bogus'],
      ['--phase'],
      ['--phase', '--raw'],
      ['--phase-dir', PHASE, 'positional'],
      [],
      ['--phase-dir', PHASE, '--files'],
    ];
    for (const sub of ['select', 'conflicts', 'coverage', 'enforce']) {
      for (const extra of cases) {
        const m = setup();
        const r = run(m, sub, extra);
        const label = `${sub} ${extra.join(' ')}`;
        assert.equal(r.ok, false, label);
        assert.equal(r.subcommand, sub, label);
        assert.equal(r.errors[0].code, 'usage', label);
        assert.deepEqual(r.written, [], label);
        assert.equal(m.calls.error.length, 1, label);
        assert.deepEqual(m.calls.readFile, [], label);
        noWrites(m);
        assert.equal(exitCodeFor(r), 1, label);
      }
    }
    // accepted and ignored: --ws, --raw, --req-ids, --files
    const ok = setup({ orders: doc({ orders: [order({ id: 'REQ-RULE', scope: { requirements: ['BILL-04'] } })] }) });
    const r = run(ok, 'select', [...PHASE_FLAG, '--ws', 'w1', '--req-ids', 'BILL-04', '--files', 'a/b.js, c/d.js', '--raw']);
    assert.equal(r.ok, true);
    assert.deepEqual(r.applicable, ['REQ-RULE']);
    assert.deepEqual(r.phase.reqIds, ['BILL-04']);
  });

  it('selectResetsCoverage', () => {
    const stale = '---\nschema: "1"\nphase: "03-billing"\nconflicts: clear\ncoverage: complete\ngenerated_by: coverage\napplicable: ""\n---\n\nold\n';
    const m = setup({ files: { [VERDICT]: stale } });
    run(m, 'select');
    const lines = m.read(VERDICT).split('\n');
    assert.ok(lines.includes('coverage: pending'), lines.join('|'));
    assert.ok(!lines.includes('coverage: complete'));
    assert.ok(lines.includes('generated_by: select'));
  });

  it('coverageWritesVerdict', () => {
    const complete = setup({ files: { [`${PHASE}/03-01-PLAN.md`]: planText({ truths: [{ statement: 'BILL-RULE: holds', verification: 'backstop' }] }) } });
    const r1 = run(complete, 'coverage');
    assert.equal(r1.ok, true);
    assert.equal(r1.coverage, 'complete');
    assert.equal(r1.conflicts, 'clear');
    assert.deepEqual(r1.uncited, []);
    assert.deepEqual(r1.written, [VERDICT]);
    const lines = complete.read(VERDICT).split('\n');
    assert.ok(lines.includes('coverage: complete'));
    assert.ok(lines.includes('conflicts: clear'));
    assert.ok(lines.includes('generated_by: coverage'));
    assert.equal(complete.has(APPLICABLE_PATH), false);
    assert.equal(exitCodeFor(r1), 0);

    const incomplete = setup({ files: { [`${PHASE}/03-01-PLAN.md`]: planText({ truths: ['something else'] }) } });
    const r2 = run(incomplete, 'coverage');
    assert.equal(r2.coverage, 'incomplete');
    assert.deepEqual(r2.uncited, ['BILL-RULE']);
    assert.ok(incomplete.read(VERDICT).split('\n').includes('coverage: incomplete'));
    assert.equal(exitCodeFor(r2), 1);

    const conflicted = setup({
      orders: CONFLICT_ORDERS,
      files: { [`${PHASE}/03-01-PLAN.md`]: planText({ truths: [{ statement: 'REF-A: full', verification: 'backstop' }, { statement: 'REF-B: prorated', verification: 'backstop' }] }) },
    });
    const r3 = run(conflicted, 'coverage');
    assert.equal(r3.coverage, 'complete');
    assert.equal(r3.conflicts, 'blocked');
    const lines3 = conflicted.read(VERDICT).split('\n');
    assert.ok(lines3.includes('conflicts: blocked'));
    assert.ok(lines3.includes('coverage: complete'));
    assert.equal(exitCodeFor(r3), 1);
  });

  it('coverageSeesPlanFiles', () => {
    const planTouchesBilling = planText({ files: ['src/billing/refund.js'], truths: ['nothing relevant'] });
    const m = setup({ contextMd: 'A phase document that names no file.\n', files: { [`${PHASE}/03-01-PLAN.md`]: planTouchesBilling } });
    const r = run(m, 'coverage');
    assert.deepEqual(r.applicable, ['BILL-RULE']);
    assert.equal(r.coverage, 'incomplete');
    assert.deepEqual(r.uncited, ['BILL-RULE']);

    const control = setup({
      contextMd: 'A phase document that names no file.\n',
      files: { [`${PHASE}/03-01-PLAN.md`]: planText({ files: ['src/other/x.js'], truths: ['nothing relevant'] }) },
    });
    const c = run(control, 'coverage');
    assert.deepEqual(c.applicable, []);
    assert.equal(c.coverage, 'complete');
  });

  it('conflictsWritesNothing', () => {
    const m = setup({ orders: CONFLICT_ORDERS });
    const r = run(m, 'conflicts');
    assert.equal(r.ok, true);
    assert.equal(r.subcommand, 'conflicts');
    assert.equal(r.conflicts, 'blocked');
    assert.equal(r.coverage, null);
    assert.deepEqual(r.written, []);
    noWrites(m);
    assert.equal(m.calls.log.length, 1);
    assert.equal(JSON.parse(m.calls.log[0]).conflicts, 'blocked');
    assert.equal(exitCodeFor(r), 1);
  });

  it('humanOutputIsOneSummaryLinePlusReasons', () => {
    const m = setup({ orders: CONFLICT_ORDERS });
    run(m, 'select', PHASE_FLAG, { raw: false });
    assert.ok(m.calls.log.length >= 2);
    assert.ok(m.calls.log[0].startsWith('standing-orders select: phase .planning/phases/03-billing'), m.calls.log[0]);
    assert.ok(m.calls.log[0].includes('conflicts blocked'));
    assert.ok(m.calls.log[0].includes('2 applicable'));
    assert.ok(m.calls.log[1].startsWith('  conflict: '), m.calls.log[1]);
  });

  it('writesAtomically', () => {
    const m = setup();
    const r = run(m, 'select');
    assert.equal(m.calls.rename.length, 3);
    const targets = r.written.map((rel) => path.resolve(m.cwd, rel));
    assert.deepEqual(
      m.calls.rename.map(([, to]) => to),
      targets,
    );
    for (const [from, to] of m.calls.rename) {
      assert.notEqual(from, to);
      assert.ok(from.startsWith(to + '.tmp-'), from);
      assert.equal(m.has(path.relative(m.cwd, from)), false, 'no temp file left behind');
      assert.ok(m.calls.writeFile.includes(from), 'temp file was written before the rename');
      assert.ok(!m.calls.writeFile.includes(to), 'the target is never written directly');
    }
    assert.ok(m.calls.mkdir.length >= 1);
  });

  it('resolvesPhaseThroughTheHost', () => {
    const hostCli = '/opt/gsd/bin/gsd-tools.cjs';
    const execCalls = [];
    const m = setup({ orders: doc({ orders: [order({ id: 'REQ-RULE', scope: { requirements: ['BILL-04'] } })] }) });
    m.deps.argv = ['node', hostCli];
    m.deps.isFile = (p) => p === hostCli;
    m.deps.execFile = (file, args, opts) => {
      execCalls.push({ file, args, opts });
      return JSON.stringify({ phase_found: true, phase_dir: path.join(m.cwd, PHASE), phase_req_ids: 'BILL-04' });
    };
    const r = routeStandingOrdersCommand({ args: ['standing-orders', 'select', '--phase', '3'], cwd: m.cwd, raw: true, error: m.error, deps: m.deps });
    assert.equal(r.ok, true);
    assert.equal(r.phase.dir, PHASE);
    assert.deepEqual(r.phase.reqIds, ['BILL-04']);
    assert.deepEqual(r.applicable, ['REQ-RULE']);
    assert.equal(execCalls.length, 1);
    assert.deepEqual(execCalls[0].args, [hostCli, 'init', 'plan-phase', '3', '--raw']);
  });

  it('hostFailureWritesNothing', () => {
    const m = setup();
    m.deps.argv = ['node', '/opt/gsd/bin/gsd-tools.cjs'];
    m.deps.isFile = () => true;
    m.deps.execFile = () => {
      throw new Error('boom');
    };
    const r = routeStandingOrdersCommand({ args: ['standing-orders', 'select', '--phase', '3'], cwd: m.cwd, raw: true, error: m.error, deps: m.deps });
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].code, 'phase_unresolved');
    assert.equal(m.calls.error.length, 1);
    noWrites(m);
    assert.deepEqual(r.written, []);
  });

  it('missingOrdersFileIsNoRulesNotAnError', () => {
    const m = setup({ orders: null });
    const r = run(m, 'select');
    assert.equal(r.ok, true);
    assert.equal(r.conflicts, 'clear');
    assert.deepEqual(r.applicable, []);
    assert.ok(r.warnings.some((w) => w.code === 'orders_file_missing'));
    assert.ok(m.read(VERDICT).split('\n').includes('conflicts: clear'));
  });

  it('invalidOrdersBlockSelect', () => {
    const m = setup({ orders: 'version: 1\norders: not-a-list\n' });
    const r = run(m, 'select');
    assert.equal(r.ok, true);
    assert.equal(r.conflicts, 'blocked');
    assert.ok(r.reasons.some((x) => x.code === 'orders_invalid'));
    assert.deepEqual(r.applicable, []);
    assert.ok(m.read(VERDICT).split('\n').includes('conflicts: blocked'));
  });

  it('ioFailureIsAResult', () => {
    let attempts = 0;
    const failing = setup({
      overrides: {
        writeFile: () => {
          attempts += 1;
          throw new Error('EROFS');
        },
      },
    });
    const r1 = run(failing, 'select');
    assert.equal(r1.ok, false);
    assert.equal(r1.errors[0].code, 'write_failed');
    assert.equal(failing.calls.error.length, 1);
    assert.ok(attempts >= 1);

    const mkdirFails = setup({
      overrides: {
        mkdir: () => {
          throw new Error('EACCES');
        },
      },
    });
    const r2 = run(mkdirFails, 'select');
    assert.equal(r2.ok, false);
    assert.equal(r2.errors[0].code, 'write_failed');
    assert.equal(mkdirFails.calls.error.length, 1);

    const coverageFails = setup({
      files: { [`${PHASE}/03-01-PLAN.md`]: planText({ truths: [{ statement: 'BILL-RULE: holds', verification: 'backstop' }] }) },
      overrides: {
        writeFile: () => {
          throw new Error('EROFS');
        },
      },
    });
    const r3 = run(coverageFails, 'coverage');
    assert.equal(r3.ok, false);
    assert.equal(r3.errors[0].code, 'write_failed');
    assert.equal(coverageFails.calls.error.length, 1);

    const logFails = setup({
      overrides: {
        log: () => {
          throw new Error('EPIPE');
        },
      },
    });
    const r4 = run(logFails, 'conflicts');
    assert.equal(r4.ok, false);
    assert.equal(r4.errors[0].code, 'internal_error');
    assert.equal(logFails.calls.error.length, 1);
  });

  it('listDirFailureDegradesToAWarning', () => {
    const m = setup({
      overrides: {
        listDir: () => {
          throw new Error('EIO');
        },
      },
    });
    const r = run(m, 'conflicts');
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some((w) => w.code === 'phase_dir_unreadable'));
  });

  it('standingOrdersDirSymlinkOutsideRefused', () => {
    const m = setup({ links: { '.planning/standing-orders': '/elsewhere/so' } });
    const r = run(m, 'select');
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].code, 'path_outside_cwd');
    assert.deepEqual(m.calls.rename, []);
  });

  // A later write failure must never leave a stale `coverage: complete` behind.
  it('selectWritesVerdictBeforeOtherFiles', () => {
    const stale = '---\nschema: "1"\nphase: "03-billing"\nconflicts: clear\ncoverage: complete\ngenerated_by: coverage\napplicable: ""\n---\n\nold\n';
    const m = setup({ files: { [VERDICT]: stale } });
    const realWrite = m.deps.writeFile;
    m.deps.writeFile = (p, text) => {
      if (path.basename(p).startsWith('APPLICABLE.md')) throw new Error('disk full');
      return realWrite(p, text);
    };
    const r = run(m, 'select');
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].code, 'write_failed');
    assert.deepEqual(r.written, [VERDICT]);
    const lines = m.read(VERDICT).split('\n');
    assert.ok(lines.includes('coverage: pending'), lines.join('|'));
    assert.ok(!lines.includes('coverage: complete'));
    assert.equal(m.has(APPLICABLE_PATH), false);
  });

  it('applicableMdSaysWhenOrdersUnusable', () => {
    const header =
      '# Applicable standing orders — phase 03-billing\n\n' +
      "These orders apply in addition to the phase's own must_haves, never instead of them. Cite each order id in must_haves; never list an order's check target in files_modified.\n\n";
    const footer = '0 applicable order(s) omitted to stay within the byte cap.\n';
    const notice = (state) => `ORDERS.yaml could not be used (${state}): planning is blocked until it is fixed. Run standing-orders validate.\n`;

    const invalid = setup({ orders: 'version: 1\norders: not-a-list\n' });
    assert.equal(run(invalid, 'select').ok, true);
    assert.equal(invalid.read(APPLICABLE_PATH), header + notice('invalid') + footer);

    const unreadable = setup({ links: { [ORDERS]: '/etc/outside' } });
    assert.equal(run(unreadable, 'select').ok, true);
    assert.equal(unreadable.read(APPLICABLE_PATH), header + notice('unreadable') + footer);

    const missing = setup({ orders: null });
    run(missing, 'select');
    assert.equal(missing.read(APPLICABLE_PATH), header + footer);
  });
});

const { ENFORCEMENT_PATH } = require('../standing-orders-router.cjs');
const { ENFORCE_TIMEOUT_MS } = require('../lib/host.cjs');
const { testOrder } = require('./helpers/fixtures.cjs');

const HOST_CLI = '/opt/gsd/bin/gsd-tools.cjs';
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

const T_A = testOrder({ id: 'T-A', statement: 'Never A.', scope: SCOPE_BILLING, check_target: 'tests/a.test.cjs' });
const T_B = testOrder({ id: 'T-B', statement: 'Never B.', scope: SCOPE_BILLING, check_target: 'tests/b.test.cjs' });
const ENFORCE_ORDERS = doc({ orders: [T_B, T_A] });
const PLAN = `${PHASE}/03-01-PLAN.md`;

const testProjection = (id, target) => ({ statement: `${id}: rule`, status: 'resolved', verification: 'test', check_kind: 'node-test', check_target: target, check_violation_fixture: 'tests/fixtures/bad.js', check_clean_fixture: 'tests/fixtures/good.js' });
const bsProjection = (id) => ({ statement: `${id}: rule`, verification: 'backstop' });
const PLAN_AB = planText({ prohibitions: [testProjection('T-A', 'tests/a.test.cjs'), testProjection('T-B', 'tests/b.test.cjs')] });

/**
 * Router project wired to a host CLI that exists in the in-memory filesystem.
 * `verdicts` maps an order id to the canned host stdout (or an Error to throw).
 * `snapshots` records the verdict file as it stood at each host call.
 */
function setupEnforce({ orders = ENFORCE_ORDERS, plan = PLAN_AB, verdicts = {}, overrides = {}, config, links, extraFiles = {} } = {}) {
  const execCalls = [];
  const snapshots = [];
  let m = null;
  const execFile = (file, args, opts) => {
    const id = JSON.parse(args[4]).prohibition.id;
    execCalls.push({ file, args, opts, id });
    snapshots.push(m.read(VERDICT));
    const out = verdicts[id];
    if (out instanceof Error) throw out;
    return out === undefined ? GREEN : out;
  };
  const files = { [HOST_CLI]: '// host stub\n', ...extraFiles };
  if (plan !== null) files[PLAN] = plan;
  const opts = { orders, files, overrides: { execFile, argv: ['node', HOST_CLI], ...overrides } };
  if (config !== undefined) opts.config = config;
  if (links !== undefined) opts.links = links;
  m = setup(opts);
  return { m, execCalls, snapshots };
}

const lineSet = (m, rel) => new Set(m.read(rel).split('\n'));

describe('router enforce subcommand', () => {
  it('enforceDisabledWritesNothing', () => {
    for (const config of [null, JSON.stringify({ 'standing-orders': { enabled: false } })]) {
      const { m, execCalls } = setupEnforce({ config });
      const r = run(m, 'enforce');
      assert.equal(r.ok, true);
      assert.equal(r.disabled, true);
      assert.equal(r.subcommand, 'enforce');
      assert.equal(r.message, 'standing-orders is not enabled; set standing-orders.enabled to true');
      assert.deepEqual(r.written, []);
      noWrites(m);
      for (const p of m.calls.readFile) assert.ok(p.endsWith('config.json'), p);
      assert.equal(execCalls.length, 0);
      assert.equal(exitCodeFor(r), 0);
    }
  });

  it('enforceMissingOrdersClear', () => {
    const { m, execCalls } = setupEnforce({ orders: null, plan: null });
    const r = run(m, 'enforce');
    assert.equal(r.ok, true);
    assert.equal(r.enforcement, 'clear');
    assert.ok(r.warnings.some((w) => w.code === 'orders_file_missing'));
    assert.equal(execCalls.length, 0);
    assert.ok(lineSet(m, VERDICT).has('enforcement: clear'));
    assert.ok(lineSet(m, VERDICT).has('generated_by: enforce'));
    const report = JSON.parse(m.read(ENFORCEMENT_PATH));
    assert.deepEqual(report, { schema: 1, phase: PHASE, status: 'clear', results: [] });
    assert.equal(exitCodeFor(r), 0);
  });

  it('enforceInvalidOrdersError', () => {
    const invalid = setupEnforce({ orders: 'version: 1\norders: not-a-list\n', plan: null });
    const r = run(invalid.m, 'enforce');
    assert.equal(r.ok, true);
    assert.equal(r.enforcement, 'error');
    assert.ok(r.reasons.some((x) => x.code === 'orders_invalid'));
    assert.equal(invalid.execCalls.length, 0);
    assert.ok(lineSet(invalid.m, VERDICT).has('enforcement: error'));
    assert.equal(JSON.parse(invalid.m.read(ENFORCEMENT_PATH)).status, 'error');
    assert.equal(exitCodeFor(r), 1);

    const unreadable = setupEnforce({ plan: null, links: { [ORDERS]: '/etc/outside' } });
    const u = run(unreadable.m, 'enforce');
    assert.equal(u.enforcement, 'error');
    assert.ok(u.reasons.some((x) => x.code === 'orders_unreadable'));
    assert.equal(unreadable.execCalls.length, 0);
    assert.equal(exitCodeFor(u), 1);
  });

  it('enforceBackstopOnlyClear', () => {
    const plan = planText({ truths: [{ statement: 'BILL-RULE: holds', verification: 'backstop' }] });
    const { m, execCalls } = setupEnforce({ orders: AC1_ORDERS, plan });
    const r = run(m, 'enforce');
    assert.deepEqual(r.applicable, ['BILL-RULE']);
    assert.equal(r.enforcement, 'clear');
    assert.equal(execCalls.length, 0, 'a backstop order has nothing to prove mechanically');
    assert.deepEqual(r.results, []);
    assert.ok(lineSet(m, VERDICT).has('enforcement: clear'));
    assert.equal(exitCodeFor(r), 0);
  });

  it('enforceAllGreenIsClear', () => {
    const { m, execCalls } = setupEnforce();
    const r = run(m, 'enforce');
    assert.equal(r.ok, true);
    assert.equal(r.subcommand, 'enforce');
    assert.equal(r.enforcement, 'clear');
    assert.equal(r.conflicts, 'clear');
    assert.equal(r.coverage, 'complete');
    assert.deepEqual(execCalls.map((c) => c.id), ['T-A', 'T-B']);
    const call = execCalls[0];
    assert.equal(call.file, '/usr/bin/node');
    assert.equal(call.args.length, 5);
    assert.deepEqual(call.args.slice(0, 4), [HOST_CLI, 'check', 'prohibition-enforcement', '--json']);
    assert.deepEqual(JSON.parse(call.args[4]), {
      prohibition: { id: 'T-A', statement: 'Never A.', status: 'resolved', verification: 'test' },
      check: { kind: 'node-test', target: 'tests/a.test.cjs', violationFixture: 'tests/fixtures/bad.js', cleanFixture: 'tests/fixtures/good.js' },
    });
    assert.equal(call.opts.cwd, m.cwd, 'the host runs in the project root');
    assert.equal(call.opts.timeout, ENFORCE_TIMEOUT_MS);
    assert.ok(!call.opts.shell);
    assert.deepEqual(JSON.parse(m.read(ENFORCEMENT_PATH)).results.map((x) => [x.id, x.status, x.flagged]), [
      ['T-A', 'green', false],
      ['T-B', 'green', false],
    ]);
    assert.ok(lineSet(m, VERDICT).has('enforcement: clear'));
    assert.equal(exitCodeFor(r), 0);
  });

  // AC3: a check that does not go red on its violation fixture is flagged, never green.
  it('enforceReportsFlaggedNeverGreen', () => {
    const { m } = setupEnforce({ orders: doc({ orders: [T_A] }), plan: planText({ prohibitions: [testProjection('T-A', 'tests/a.test.cjs')] }), verdicts: { 'T-A': FLAGGED } });
    const r = run(m, 'enforce');
    assert.equal(r.ok, true);
    assert.equal(r.enforcement, 'flagged');
    const verdict = lineSet(m, VERDICT);
    assert.ok(verdict.has('enforcement: flagged'));
    assert.ok(!verdict.has('enforcement: clear'));
    assert.ok(m.read(VERDICT).includes('enforcement_flagged: T-A: test-tier prohibition has no passing wired enforcement check'));
    const report = JSON.parse(m.read(ENFORCEMENT_PATH));
    assert.equal(report.schema, 1);
    assert.equal(report.phase, PHASE);
    assert.equal(report.status, 'flagged');
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0].id, 'T-A');
    assert.equal(report.results[0].flagged, true);
    assert.equal(report.results[0].reason, 'test-tier prohibition has no passing wired enforcement check');
    assert.ok(r.reasons.some((x) => x.code === 'enforcement_flagged'));
    assert.equal(exitCodeFor(r), 1);
  });

  it('enforceFailsClosedOnHostFailure', () => {
    for (const verdict of [new Error('spawn failed'), 'not json', Object.assign(new Error('slow'), { code: 'ETIMEDOUT' })]) {
      const { m } = setupEnforce({ orders: doc({ orders: [T_A] }), plan: planText({ prohibitions: [testProjection('T-A', 'tests/a.test.cjs')] }), verdicts: { 'T-A': verdict } });
      const r = run(m, 'enforce');
      assert.equal(r.enforcement, 'flagged');
      assert.equal(r.results[0].flagged, true);
      assert.ok(lineSet(m, VERDICT).has('enforcement: flagged'));
      assert.equal(exitCodeFor(r), 1);
    }
    // no host CLI at all
    const m = setup({ orders: doc({ orders: [T_A] }), files: { [PLAN]: planText({ prohibitions: [testProjection('T-A', 'tests/a.test.cjs')] }) } });
    const r = run(m, 'enforce');
    assert.equal(r.enforcement, 'flagged');
    assert.ok(r.results[0].reason.startsWith('host_unavailable'), r.results[0].reason);
    assert.equal(m.calls.execFile.length, 0);
  });

  it('enforceMixedResults', () => {
    const { m, execCalls } = setupEnforce({ verdicts: { 'T-B': FLAGGED } });
    const r = run(m, 'enforce');
    assert.equal(r.enforcement, 'flagged');
    assert.deepEqual(execCalls.map((c) => c.id), ['T-A', 'T-B'], 'one host call per applicable test order, in id order');
    const report = JSON.parse(m.read(ENFORCEMENT_PATH));
    assert.deepEqual(report.results.map((x) => [x.id, x.flagged]), [
      ['T-A', false],
      ['T-B', true],
    ]);
    assert.equal(r.reasons.filter((x) => x.code === 'enforcement_flagged').length, 1);
    assert.ok(r.reasons.some((x) => x.message.startsWith('T-B: ')));
  });

  it('enforceWritesPendingFirst', () => {
    const stale = '---\nschema: "1"\nphase: "03-billing"\nconflicts: clear\ncoverage: complete\nenforcement: clear\ngenerated_by: enforce\napplicable: ""\n---\n\nold\n';
    const { m, execCalls, snapshots } = setupEnforce({ extraFiles: { [VERDICT]: stale } });
    const order = [];
    const realWrite = m.deps.writeFile;
    m.deps.writeFile = (p, text) => {
      order.push(`write:${path.basename(p).split('.tmp-')[0]}`);
      return realWrite(p, text);
    };
    run(m, 'enforce');
    assert.ok(execCalls.length > 0);
    for (const snapshot of snapshots) {
      const lines = snapshot.split('\n');
      assert.ok(lines.includes('enforcement: pending'), lines.join('|'));
      assert.ok(!lines.includes('enforcement: clear'), 'a stale clear never survives into a host call');
    }
    assert.equal(order[0], 'write:STANDING-ORDERS.md', order.join());
    assert.deepEqual(order, ['write:STANDING-ORDERS.md', 'write:ENFORCEMENT.json', 'write:STANDING-ORDERS.md']);
    assert.ok(lineSet(m, VERDICT).has('enforcement: clear'));
  });

  it('enforceVerdictWriteFails', () => {
    const { m, execCalls } = setupEnforce({
      overrides: {
        writeFile: () => {
          throw new Error('EROFS');
        },
      },
    });
    const r = run(m, 'enforce');
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].code, 'write_failed');
    assert.equal(execCalls.length, 0, 'no host call when the pending verdict could not be written');
    assert.equal(m.calls.error.length, 1);
    assert.equal(exitCodeFor(r), 2);
  });

  it('enforceReportWriteFails', () => {
    const { m, execCalls } = setupEnforce();
    const realWrite = m.deps.writeFile;
    m.deps.writeFile = (p, text) => {
      if (path.basename(p).startsWith('ENFORCEMENT.json')) throw new Error('disk full');
      return realWrite(p, text);
    };
    const r = run(m, 'enforce');
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].code, 'write_failed');
    assert.ok(execCalls.length > 0, 'the checks ran before the report write failed');
    const lines = lineSet(m, VERDICT);
    assert.ok(lines.has('enforcement: error'), [...lines].join('|'));
    assert.ok(!lines.has('enforcement: clear'));
    assert.equal(m.has(ENFORCEMENT_PATH), false);
    assert.equal(m.calls.error.length, 1);
    assert.equal(exitCodeFor(r), 2);
  });

  it('enforceKeepsConflictsTruthful', () => {
    const orders = doc({
      contexts: { 'ctx-a': { description: 'a' } },
      orders: [variant('REF-A', 'refund.amount', ['ctx-a'], 'full', { scope: SCOPE_BILLING }), variant('REF-B', 'refund.amount', ['ctx-a'], 'prorated', { scope: SCOPE_BILLING }), T_A],
    });
    const plan = planText({
      truths: [
        { statement: 'REF-A: full', verification: 'backstop' },
        { statement: 'REF-B: prorated', verification: 'backstop' },
      ],
      prohibitions: [testProjection('T-A', 'tests/a.test.cjs')],
    });
    const { m, execCalls } = setupEnforce({ orders, plan });
    const r = run(m, 'enforce');
    assert.equal(r.ok, true);
    assert.equal(r.conflicts, 'blocked');
    assert.equal(r.enforcement, 'clear');
    assert.deepEqual(execCalls.map((c) => c.id), ['T-A'], 'enforcement is still evaluated');
    const lines = lineSet(m, VERDICT);
    assert.ok(lines.has('conflicts: blocked'));
    assert.ok(lines.has('enforcement: clear'));
    assert.equal(exitCodeFor(r), 1);
  });

  it('enforceHumanOutputNamesEnforcement', () => {
    const { m } = setupEnforce({ verdicts: { 'T-A': FLAGGED } });
    run(m, 'enforce', PHASE_FLAG, { raw: false });
    assert.ok(m.calls.log[0].startsWith('standing-orders enforce: phase .planning/phases/03-billing'), m.calls.log[0]);
    assert.ok(m.calls.log[0].includes('enforcement flagged'), m.calls.log[0]);
    assert.ok(m.calls.log.some((l) => l.startsWith('  enforcement_flagged: T-A')), m.calls.log.join('|'));
  });

  it('enforceUsageErrorsRunNothing', () => {
    for (const extra of [[], ['--phase-dir', PHASE, '--bogus'], ['--phase', '3', '--phase-dir', PHASE], ['--phase-dir', PHASE, 'positional']]) {
      const { m, execCalls } = setupEnforce();
      const r = run(m, 'enforce', extra);
      assert.equal(r.ok, false, extra.join(' '));
      assert.equal(r.errors[0].code, 'usage');
      assert.ok(r.errors[0].message.includes('standing-orders enforce'));
      assert.equal(execCalls.length, 0);
      assert.deepEqual(m.calls.readFile, []);
      noWrites(m);
      assert.equal(exitCodeFor(r), 1);
    }
  });
});

describe('router select and coverage enforcement field', () => {
  it('selectAndCoverageWriteEnforcementPending', () => {
    const select = setup();
    const rs = run(select, 'select');
    assert.equal(rs.enforcement, 'pending');
    assert.ok(lineSet(select, VERDICT).has('enforcement: pending'));

    const stale = '---\nschema: "1"\nphase: "03-billing"\nconflicts: clear\ncoverage: complete\nenforcement: clear\ngenerated_by: enforce\napplicable: ""\n---\n\nold\n';
    const reset = setup({ files: { [VERDICT]: stale } });
    run(reset, 'select');
    assert.ok(lineSet(reset, VERDICT).has('enforcement: pending'), 'select resets a stale enforcement: clear');
    assert.ok(!lineSet(reset, VERDICT).has('enforcement: clear'));

    const cover = setup({ files: { [PLAN]: planText({ truths: [bsProjection('BILL-RULE')] }), [VERDICT]: stale } });
    const rc = run(cover, 'coverage');
    assert.equal(rc.coverage, 'complete');
    assert.equal(rc.enforcement, 'pending');
    assert.ok(lineSet(cover, VERDICT).has('enforcement: pending'));
    assert.ok(!lineSet(cover, VERDICT).has('enforcement: clear'));

    const conflicts = setup();
    const rk = run(conflicts, 'conflicts');
    assert.equal(rk.enforcement, null);
    assert.deepEqual(rk.written, []);
  });

  it('humanOutputShowsPendingEnforcementForSelect', () => {
    const m = setup();
    run(m, 'select', PHASE_FLAG, { raw: false });
    assert.ok(m.calls.log[0].includes('enforcement pending'), m.calls.log[0]);
    const k = setup();
    run(k, 'conflicts', PHASE_FLAG, { raw: false });
    assert.ok(!k.calls.log[0].includes('enforcement'), k.calls.log[0]);
  });

  it('exitCodeForEnforcement', () => {
    const base = { subcommand: 'enforce', ok: true, disabled: false, conflicts: 'clear', coverage: 'complete' };
    assert.equal(exitCodeFor({ ...base, enforcement: 'clear' }), 0);
    assert.equal(exitCodeFor({ ...base, enforcement: 'pending' }), 0);
    assert.equal(exitCodeFor({ ...base, enforcement: null }), 0);
    assert.equal(exitCodeFor({ ...base, enforcement: 'flagged' }), 1);
    assert.equal(exitCodeFor({ ...base, enforcement: 'error' }), 1);
    assert.equal(exitCodeFor({ ...base, subcommand: 'coverage', enforcement: 'pending' }), 0);
    assert.equal(exitCodeFor({ ...base, enforcement: 'clear', conflicts: 'blocked' }), 1);
  });

  it('unknownSubcommandListsEnforce', () => {
    const m = setup();
    const r = run(m, 'nope');
    assert.equal(r.ok, false);
    assert.ok(r.error.includes('Available: select, conflicts, coverage, enforce, trace, impact, stale, validate'), r.error);
    assert.ok(m.calls.error[0].includes('enforce'));
    const none = routeStandingOrdersCommand({ args: ['standing-orders'], cwd: m.cwd, raw: true, error: m.error, deps: m.deps });
    assert.ok(none.error.includes('Available: select, conflicts, coverage, enforce, trace, impact, stale, validate'), none.error);
  });
});

describe('router coverage check-file and projection rules', () => {
  const TEST_ONLY = doc({ orders: [T_A] });

  // AC8 end to end: a plan that lists the check file it must not touch.
  it('coverageRejectsCheckTargetEditE2E', () => {
    const edit = planText({ files: ['src/billing/refund.js', 'tests/a.test.cjs'], prohibitions: [testProjection('T-A', 'tests/a.test.cjs')] });
    const m = setup({ orders: TEST_ONLY, files: { [PLAN]: edit } });
    const r = run(m, 'coverage');
    assert.equal(r.ok, true);
    assert.equal(r.coverage, 'incomplete');
    assert.deepEqual(r.checkFileEdits, [{ plan: '03-01-PLAN.md', file: 'tests/a.test.cjs', id: 'T-A' }]);
    assert.ok(r.reasons.some((x) => x.code === 'check_file_modified' && x.message.includes('03-01-PLAN.md') && x.message.includes('tests/a.test.cjs') && x.message.includes('T-A')));
    assert.ok(lineSet(m, VERDICT).has('coverage: incomplete'));
    assert.equal(exitCodeFor(r), 1);

    const fixture = planText({ files: ['tests/fixtures/bad.js'], prohibitions: [testProjection('T-A', 'tests/a.test.cjs')] });
    const f = run(setup({ orders: TEST_ONLY, files: { [PLAN]: fixture } }), 'coverage');
    assert.equal(f.coverage, 'incomplete');
    assert.deepEqual(f.checkFileEdits.map((e) => e.file), ['tests/fixtures/bad.js']);

    const control = planText({ files: ['src/billing/refund.js'], prohibitions: [testProjection('T-A', 'tests/a.test.cjs')] });
    const c = run(setup({ orders: TEST_ONLY, files: { [PLAN]: control } }), 'coverage');
    assert.equal(c.coverage, 'complete');
    assert.deepEqual(c.checkFileEdits, []);
    assert.deepEqual(c.notProjected, []);
    assert.equal(exitCodeFor(c), 0);
  });

  it('coverageRequiresProjectionE2E', () => {
    const cited = planText({ truths: ['T-A holds'] });
    const m = setup({ orders: TEST_ONLY, files: { [PLAN]: cited } });
    const r = run(m, 'coverage');
    assert.equal(r.coverage, 'incomplete');
    assert.deepEqual(r.notProjected, ['T-A']);
    assert.deepEqual(r.uncited, []);
    assert.ok(r.reasons.some((x) => x.code === 'not_projected'));
    assert.equal(exitCodeFor(r), 1);
    assert.ok(lineSet(m, VERDICT).has('coverage: incomplete'));

    const uncited = run(setup({ orders: TEST_ONLY, files: { [PLAN]: planText({ truths: ['unrelated'] }) } }), 'coverage');
    assert.deepEqual(uncited.uncited, ['T-A']);
    assert.deepEqual(uncited.notProjected, []);
  });
});

describe('router select and the trace ledger', () => {
  const { orderHash, TRACE_PATH } = require('../lib/trace.cjs');
  const { parsed } = require('./helpers/fixtures.cjs');
  const D = String.fromCharCode(0x2014);
  const HEADER =
    `# Applicable standing orders ${D} phase 03-billing\n\n` +
    "These orders apply in addition to the phase's own must_haves, never instead of them. Cite each order id in must_haves; never list an order's check target in files_modified.\n\n";
  // Captured from the router before the ledger existed (phase 3 output): the no-trace bytes must not move.
  const GOLDEN =
    HEADER +
    '## BILL-RULE (invariant, backstop)\n' +
    '- Statement: Something always holds.\n' +
    `- Operation: ${D}\n` +
    '- Contexts: all\n' +
    '- Scope: paths [src/billing/**]; requirements []\n' +
    `- Check: backstop ${D} no mechanical check; the verifier reports insufficient_spec\n` +
    '- Project as: must_haves.truths item {"statement":"BILL-RULE: Something always holds.","verification":"backstop"}\n' +
    `- Source: ${D}\n\n` +
    '0 applicable order(s) omitted to stay within the byte cap.\n';

  const TWO = doc({ orders: [order({ id: 'BILL-A', statement: 'Rule A.', scope: SCOPE_BILLING }), order({ id: 'BILL-B', statement: 'Rule B.', scope: SCOPE_BILLING })] });
  const specOf = (statementA) => ({ orders: [order({ id: 'BILL-A', statement: statementA, scope: SCOPE_BILLING }), order({ id: 'BILL-B', statement: 'Rule B.', scope: SCOPE_BILLING })] });
  const hashOf = (id, statementA = 'Rule A.') => orderHash(parsed(specOf(statementA)).orders.find((o) => o.id === id));
  const OLD_PHASE = '.planning/phases/02-old';
  const record = (id, overrides = {}) =>
    JSON.stringify({
      schema: 1,
      order_id: id,
      order_hash: hashOf(id),
      contexts: ['*'],
      phase: OLD_PHASE,
      plans: [],
      files: [],
      check: null,
      disposition: 'insufficient_spec',
      commit_sha: null,
      ts: '2026-11-01T00:00:00.000Z',
      ...overrides,
    }) + '\n';
  const sectionOf = (text, id) => {
    const start = text.indexOf(`## ${id} `);
    assert.notEqual(start, -1, `${id} present`);
    const next = text.indexOf('\n## ', start + 1);
    const end = next === -1 ? text.indexOf('\n\n', start + 1) : next;
    return text.slice(start, end);
  };

  // Row 34: no ledger means the same bytes as before the ledger existed.
  it('noTraceByteIdentical', () => {
    const m = setup();
    const r = run(m, 'select');
    assert.equal(r.ok, true);
    assert.equal(m.read(APPLICABLE_PATH), GOLDEN);
    assert.deepEqual(r.stale, []);
    assert.ok(!r.warnings.some((w) => w.code === 'trace_unreadable'));
    assert.equal(m.calls.appendFile.length, 0, 'select never writes the ledger');

    // an empty ledger changes nothing either
    const withTrace = setup({ files: { [TRACE_PATH]: '' } });
    const rt = run(withTrace, 'select');
    assert.equal(withTrace.read(APPLICABLE_PATH), GOLDEN);
    assert.deepEqual(rt.stale, []);
  });

  // Row 35.
  it('selectMarksStale', () => {
    const baseline = setup({ orders: TWO });
    run(baseline, 'select');
    const plain = baseline.read(APPLICABLE_PATH);
    assert.ok(!plain.includes('Stale:'));

    const ledger = record('BILL-A', { order_hash: hashOf('BILL-A', 'Rule A, as first traced.') }) + record('BILL-B');
    const m = setup({ orders: TWO, files: { [TRACE_PATH]: ledger } });
    const r = run(m, 'select');
    assert.equal(r.ok, true);
    assert.deepEqual(r.stale, ['BILL-A']);
    assert.deepEqual(r.applicable, ['BILL-A', 'BILL-B']);
    const text = m.read(APPLICABLE_PATH);
    const staleLine = `- Stale: changed since last traced in ${OLD_PHASE}; re-check this order before planning`;
    assert.equal(text.split('\n').filter((l) => l.startsWith('- Stale:')).length, 1);
    const blockA = sectionOf(text, 'BILL-A').split('\n');
    const source = blockA.findIndex((l) => l.startsWith('- Source:'));
    assert.equal(blockA[source + 1], staleLine, 'the Stale line follows Source, inside the block');
    assert.equal(blockA.length, sectionOf(plain, 'BILL-A').split('\n').length + 1, 'exactly one line added');
    assert.equal(sectionOf(text, 'BILL-B'), sectionOf(plain, 'BILL-B'), 'a current order block is unchanged');
    assert.equal(exitCodeFor(r), 0, 'stale never blocks planning');
    assert.equal(m.calls.appendFile.length, 0);

    // contexts_changed is reported with its own reason; a later current record clears the mark
    const ctx = setup({ orders: TWO, files: { [TRACE_PATH]: record('BILL-A', { contexts: ['old-leaf'] }) } });
    const rc = run(ctx, 'select');
    assert.deepEqual(rc.stale, ['BILL-A']);
    assert.ok(ctx.read(APPLICABLE_PATH).includes(`- Stale: contexts_changed since last traced in ${OLD_PHASE}; re-check this order before planning`));

    const cleared = setup({ orders: TWO, files: { [TRACE_PATH]: record('BILL-A', { order_hash: hashOf('BILL-A', 'older text') }) + record('BILL-A') } });
    assert.deepEqual(run(cleared, 'select').stale, []);
    assert.equal(cleared.read(APPLICABLE_PATH), plain);

    // a traced order that is no longer in ORDERS.yaml is not applicable, so it is not marked
    const gone = setup({ orders: TWO, files: { [TRACE_PATH]: record('GONE-RULE', { order_hash: 'sha256:' + 'c'.repeat(64) }) } });
    assert.deepEqual(run(gone, 'select').stale, []);
    assert.equal(gone.read(APPLICABLE_PATH), plain);
  });

  // Row 37: planning never depends on the ledger.
  it('selectIgnoresBadTrace', () => {
    const baseline = setup();
    run(baseline, 'select');
    const plain = baseline.read(APPLICABLE_PATH);
    assert.equal(plain, GOLDEN);

    const unreadable = setup({ files: { [TRACE_PATH]: 'x\n' } });
    const realRead = unreadable.deps.readFile;
    unreadable.deps.readFile = (p) => {
      if (p.endsWith('TRACE.jsonl')) throw new Error('EIO');
      return realRead(p);
    };
    const oversize = setup({ files: { [TRACE_PATH]: 'x\n' } });
    const realSize = oversize.deps.statSize;
    oversize.deps.statSize = (p) => (p.endsWith('TRACE.jsonl') ? 32 * 1024 * 1024 + 1 : realSize(p));
    const outside = setup({ files: { [TRACE_PATH]: 'x\n' }, links: { [TRACE_PATH]: '/etc/outside/TRACE.jsonl' } });

    for (const [name, m] of [['unreadable', unreadable], ['oversize', oversize], ['outside', outside]]) {
      const r = run(m, 'select');
      assert.equal(r.ok, true, name);
      assert.equal(r.conflicts, 'clear', name);
      assert.deepEqual(r.stale, [], name);
      assert.ok(r.warnings.some((w) => w.code === 'trace_unreadable'), `${name}: ${JSON.stringify(r.warnings)}`);
      assert.equal(m.read(APPLICABLE_PATH), plain, name);
      assert.deepEqual(r.written, [VERDICT, APPLICABLE_PATH, CONFLICTS_PATH], name);
      assert.equal(exitCodeFor(r), 0, name);
    }

    // a ledger of corrupt lines only is also harmless
    const corrupt = setup({ files: { [TRACE_PATH]: 'garbage\n{"x":\n' } });
    const rc = run(corrupt, 'select');
    assert.equal(rc.ok, true);
    assert.equal(corrupt.read(APPLICABLE_PATH), plain);
    assert.deepEqual(rc.stale, []);
  });

  // R5: an order whose id is a prototype key is marked like any other.
  it('anOrderNamedProtoIsMarkedStale', () => {
    const protoOrder = order({ id: '__proto__', statement: 'Proto rule.', scope: SCOPE_BILLING });
    const line =
      JSON.stringify({
        schema: 1,
        order_id: '__proto__',
        order_hash: 'sha256:' + '1'.repeat(64),
        contexts: ['*'],
        phase: OLD_PHASE,
        plans: [],
        files: [],
        check: null,
        disposition: 'insufficient_spec',
        commit_sha: null,
        ts: '2026-11-01T00:00:00.000Z',
      }) + '\n';
    const m = setup({ orders: doc({ orders: [protoOrder] }), files: { [TRACE_PATH]: line } });
    const r = run(m, 'select');
    assert.equal(r.ok, true);
    assert.deepEqual(r.applicable, ['__proto__']);
    assert.deepEqual(r.stale, ['__proto__']);
    assert.match(sectionOf(m.read(APPLICABLE_PATH), '__proto__'), /- Stale: changed since last traced in /);
  });
});

// Phase 6 (#7), ADR-0002 sections 2-3: `enforce` runs a test order's mutants once its base check is proven, caches the
// answers by content, and flags the order when a mutant survives. Rows 16, 23-25, 30-31 of the phase-6 test matrix.
const { fakeProver } = require('./helpers/prover.cjs');

describe('router enforce: mutants', () => {
  const MUTANTS = '.planning/standing-orders/MUTANTS.json';
  const CHECK_A = 'tests/a.test.cjs';
  const BAD = 'tests/fixtures/bad.js';
  const MUT = 'tests/fixtures/mutants';
  const MA1 = `${MUT}/m1.js`;
  const MA2 = `${MUT}/m2.js`;
  const FILES = { [CHECK_A]: 'check a', [BAD]: 'bad', 'tests/fixtures/good.js': 'good', [MA1]: 'mutant one', [MA2]: 'mutant two' };
  const withMutants = (list) => testOrder({ id: 'T-A', statement: 'Never A.', scope: SCOPE_BILLING, check_target: CHECK_A, check_mutants: list });
  const PLAN_A = planText({ prohibitions: [testProjection('T-A', CHECK_A)] });
  const abs = (m, rel) => path.resolve(m.cwd, rel);

  function setupMutants({ orders = doc({ orders: [withMutants([MA1, MA2])] }), plan = PLAN_A, table = {}, files = {}, drop = [], overrides = {}, config } = {}) {
    const prover = fakeProver(table);
    const all = { [HOST_CLI]: '// host stub\n', [PLAN]: plan, ...FILES, ...files };
    for (const rel of drop) delete all[rel];
    const opts = { orders, files: all, overrides: { execFile: prover.execFile, argv: ['node', HOST_CLI], ...overrides } };
    if (config !== undefined) opts.config = config;
    return { m: setup(opts), prover };
  }
  const report = (m) => JSON.parse(m.read(ENFORCEMENT_PATH));
  const cacheOutcomes = (m) => Object.values(JSON.parse(m.read(MUTANTS)).entries).map((e) => e.outcome).sort();
  const fixturesOf = (prover) => prover.calls.map((c) => c.fixture);

  // row 30: an order without mutants leaves no trace of the feature
  const unchangedFor = (ordersList) => () => {
    for (const orders of ordersList) {
      const prover = fakeProver();
      const m = setup({ orders, files: { [HOST_CLI]: '// host stub\n', [PLAN]: PLAN_AB }, overrides: { execFile: prover.execFile, argv: ['node', HOST_CLI] } });
      const r = run(m, 'enforce');
      assert.equal(r.enforcement, 'clear');
      assert.equal(prover.calls.length, 2, 'one prover call per order, none for mutants');
      assert.equal(m.has(MUTANTS), false, 'a project with no mutants gets no MUTANTS.json');
      assert.ok(!m.calls.readFile.some((p) => p.endsWith('MUTANTS.json')), 'and none is read');
      assert.ok(!r.written.includes(MUTANTS));
      const entry = (id) => ({ id, status: 'green', flagged: false, reason: 'ok', located: true, kind: 'node-test', evidence: [] });
      assert.deepEqual(report(m), { schema: 1, phase: PHASE, status: 'clear', results: [entry('T-A'), entry('T-B')] }, 'ENFORCEMENT.json is exactly what phase 5 wrote');
      assert.deepEqual(r.results, [entry('T-A'), entry('T-B')]);
    }
  };
  it('enforceWithoutMutantsUnchanged', unchangedFor([ENFORCE_ORDERS]));
  it('enforceEmptyMutantListUnchanged', unchangedFor([doc({ orders: [{ ...T_B, check_mutants: [] }, { ...T_A, check_mutants: [] }] })]));

  it('enforceMutantsAllKilled', () => {
    const { m, prover } = setupMutants();
    const r = run(m, 'enforce');
    assert.equal(r.ok, true);
    assert.equal(r.enforcement, 'clear');
    assert.equal(exitCodeFor(r), 0);
    assert.deepEqual(fixturesOf(prover), [BAD, MA1, MA2], 'the base check first, then each mutant as the violation fixture');
    const expected = [
      { path: MA1, outcome: 'killed', cached: false, reason: 'ok' },
      { path: MA2, outcome: 'killed', cached: false, reason: 'ok' },
    ];
    assert.deepEqual(report(m).results[0].mutants, expected);
    assert.deepEqual(r.results[0].mutants, expected);
    assert.equal(report(m).results[0].flagged, false);
    assert.equal(report(m).status, 'clear');
    assert.ok(lineSet(m, VERDICT).has('enforcement: clear'));
    assert.deepEqual(cacheOutcomes(m), ['killed', 'killed']);
    assert.ok(r.written.includes(MUTANTS));
    assert.ok(m.calls.rename.some(([, to]) => to === abs(m, MUTANTS)), 'the cache is replaced atomically');
    assert.ok(!m.calls.writeFile.includes(abs(m, MUTANTS)), 'never written in place');
  });

  // row 31
  it('enforceMutantSurvivorFlags', () => {
    const { m, prover } = setupMutants({ table: { [MA2]: FLAGGED } });
    const writes = [];
    const realWrite = m.deps.writeFile;
    m.deps.writeFile = (p, text) => {
      writes.push(path.basename(p).split('.tmp-')[0]);
      return realWrite(p, text);
    };
    const r = run(m, 'enforce');
    assert.equal(r.ok, true);
    assert.equal(r.enforcement, 'flagged', 'a survivor flags the order and the blocking gate rejects it');
    assert.equal(exitCodeFor(r), 1);
    assert.ok(lineSet(m, VERDICT).has('enforcement: flagged'));
    assert.ok(!lineSet(m, VERDICT).has('enforcement: clear'));
    assert.ok(m.read(VERDICT).includes(`enforcement_flagged: T-A: mutant_survived: ${MA2}`), m.read(VERDICT));
    assert.ok(r.reasons.some((x) => x.code === 'enforcement_flagged' && x.message === `T-A: mutant_survived: ${MA2}`), JSON.stringify(r.reasons));
    const entry = report(m).results[0];
    assert.equal(report(m).status, 'flagged');
    assert.equal(entry.status, 'green', 'the base check stays proven; only the mutant outcome flags it');
    assert.equal(entry.flagged, true);
    assert.equal(entry.reason, `mutant_survived: ${MA2}`);
    assert.deepEqual(entry.mutants.map((x) => [x.path, x.outcome, x.cached]), [[MA1, 'killed', false], [MA2, 'survived', false]]);
    assert.equal(entry.mutants[1].reason, 'test-tier prohibition has no passing wired enforcement check');
    assert.deepEqual(cacheOutcomes(m), ['killed', 'survived']);
    assert.equal(fixturesOf(prover).length, 3);
    assert.equal(writes[0], 'STANDING-ORDERS.md', 'the pending verdict still goes first');
    assert.ok(writes.includes('ENFORCEMENT.json') && writes.includes('MUTANTS.json'));
  });

  it('enforceMutantsOnlyForOrdersThatHaveThem', () => {
    const orders = doc({ orders: [T_B, withMutants([MA1, MA2])] });
    const plan = planText({ prohibitions: [testProjection('T-A', CHECK_A), testProjection('T-B', 'tests/b.test.cjs')] });
    const { m, prover } = setupMutants({ orders, plan, table: { [MA1]: FLAGGED }, files: { 'tests/b.test.cjs': 'check b' } });
    const r = run(m, 'enforce');
    assert.equal(r.enforcement, 'flagged');
    assert.equal(prover.calls.filter((c) => c.id === 'T-B').length, 1, 'T-B has no mutants: one call');
    assert.equal(prover.calls.filter((c) => c.id === 'T-A').length, 3, 'T-A: its base and its two mutants');
    const [a, b] = report(m).results;
    assert.deepEqual([a.id, a.flagged], ['T-A', true]);
    assert.deepEqual([b.id, b.flagged], ['T-B', false]);
    assert.equal('mutants' in b, false);
    assert.equal(r.reasons.filter((x) => x.code === 'enforcement_flagged').length, 1);
  });

  // row 16
  it('enforceBaseFlaggedSkipsMutants', () => {
    const { m, prover } = setupMutants({ table: { [BAD]: FLAGGED } });
    const r = run(m, 'enforce');
    assert.equal(r.enforcement, 'flagged');
    assert.deepEqual(fixturesOf(prover), [BAD], 'a check that is not proven is not run against mutants');
    const entry = report(m).results[0];
    assert.equal(entry.reason, 'test-tier prohibition has no passing wired enforcement check', 'the host reason is untouched');
    assert.equal('mutants' in entry, false);
    assert.equal(m.has(MUTANTS), false);
  });

  // row 23
  it('enforceCacheHitSecondRun', () => {
    const { m, prover } = setupMutants({ table: { [MA2]: FLAGGED } });
    const first = run(m, 'enforce');
    assert.equal(prover.calls.length, 3);
    const cacheText = m.read(MUTANTS);
    const second = run(m, 'enforce');
    assert.deepEqual(fixturesOf(prover).slice(3), [BAD], 'the second run asks the host about the base check only');
    assert.equal(second.enforcement, 'flagged', 'a cached survivor still flags the order');
    assert.deepEqual(report(m).results[0].mutants.map((x) => [x.path, x.outcome, x.cached]), [[MA1, 'killed', true], [MA2, 'survived', true]]);
    assert.equal(report(m).results[0].reason, `mutant_survived: ${MA2}`);
    assert.equal(m.read(MUTANTS), cacheText, 'nothing new to remember: the cache is not rewritten');
    assert.ok(!second.written.includes(MUTANTS));
    assert.ok(first.written.includes(MUTANTS));
  });

  // row 24 end to end
  it('enforceEditInvalidatesCache', () => {
    const { m, prover } = setupMutants();
    run(m, 'enforce');
    m.deps.writeFile(abs(m, MA1), 'mutant one, edited');
    prover.calls.length = 0;
    run(m, 'enforce');
    assert.deepEqual(fixturesOf(prover), [BAD, MA1], 'only the edited mutant runs again');
    assert.deepEqual(report(m).results[0].mutants.map((x) => [x.path, x.cached]), [[MA1, false], [MA2, true]]);

    prover.calls.length = 0;
    m.deps.writeFile(abs(m, CHECK_A), 'check a, edited');
    run(m, 'enforce');
    assert.deepEqual(fixturesOf(prover), [BAD, MA1, MA2], 'a changed check re-runs every mutant');
  });

  // row 25
  it('enforceNoCacheFlag', () => {
    const table = { [MA2]: FLAGGED };
    const { m, prover } = setupMutants({ table });
    run(m, 'enforce');
    delete table[MA2]; // the host now says MA2 is killed
    // the stored answer wins until the cache is bypassed: that is what --no-cache is for
    const stale = run(m, 'enforce');
    assert.equal(stale.enforcement, 'flagged');
    prover.calls.length = 0;
    const fresh = run(m, 'enforce', [...PHASE_FLAG, '--no-cache']);
    assert.equal(fresh.ok, true, JSON.stringify(fresh));
    assert.deepEqual(fixturesOf(prover), [BAD, MA1, MA2], 'every mutant runs again');
    assert.equal(fresh.enforcement, 'clear', 'the fresh answer replaces the stored survivor');
    assert.deepEqual(report(m).results[0].mutants.map((x) => [x.outcome, x.cached]), [['killed', false], ['killed', false]]);
    assert.deepEqual(cacheOutcomes(m), ['killed', 'killed'], 'and is written back');
    assert.ok(fresh.written.includes(MUTANTS));
    // and the next ordinary run trusts the refreshed cache
    prover.calls.length = 0;
    assert.equal(run(m, 'enforce').enforcement, 'clear');
    assert.deepEqual(fixturesOf(prover), [BAD]);
  });

  it('enforceMissingMutantFlags', () => {
    const { m, prover } = setupMutants({ drop: [MA2] });
    const r = run(m, 'enforce');
    assert.equal(r.enforcement, 'flagged');
    assert.deepEqual(fixturesOf(prover), [BAD, MA1], 'no prover call for a file that is not there');
    const entry = report(m).results[0];
    assert.equal(entry.reason, `mutant_unverified: ${MA2}`);
    assert.equal(entry.mutants[1].outcome, 'error');
    assert.ok(entry.mutants[1].reason.startsWith('mutant_missing'), entry.mutants[1].reason);
    assert.deepEqual(cacheOutcomes(m), ['killed'], 'an error is never remembered');
    assert.ok(m.read(VERDICT).includes(`enforcement_flagged: T-A: mutant_unverified: ${MA2}`));
  });

  it('enforceHostErrorOnMutantFlagsAndIsNotCached', () => {
    const { m } = setupMutants({ table: { [MA1]: new Error('spawn failed') } });
    const r = run(m, 'enforce');
    assert.equal(r.enforcement, 'flagged');
    assert.equal(report(m).results[0].reason, `mutant_unverified: ${MA1}`);
    assert.deepEqual(cacheOutcomes(m), ['killed']);
  });

  it('enforceDisabledWithMutantsReadsNothing', () => {
    const { m, prover } = setupMutants({ config: null });
    const r = run(m, 'enforce');
    assert.equal(r.disabled, true);
    assert.deepEqual(r.written, []);
    noWrites(m);
    for (const p of m.calls.readFile) assert.ok(p.endsWith('config.json'), p);
    assert.equal(prover.calls.length, 0);
  });

  it('invalidMutantPathBlocksTheLoop', () => {
    for (const bad of ['../outside.js', '/etc/passwd', MA1]) {
      const orders = doc({ orders: [withMutants(bad === MA1 ? [MA1, MA1] : [bad])] });
      const sel = setupMutants({ orders });
      const s = run(sel.m, 'select');
      assert.equal(s.conflicts, 'blocked', bad);
      assert.ok(s.reasons.some((x) => x.code === 'orders_invalid'), bad);
      const enf = setupMutants({ orders });
      const e = run(enf.m, 'enforce');
      assert.equal(e.enforcement, 'error', bad);
      assert.equal(enf.prover.calls.length, 0, 'nothing runs against an order file that does not validate');
    }
  });
});
