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

function planText({ files = [], truths = [] }) {
  const data = { requirements: ['X-1'], must_haves: { truths } };
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
    assert.deepEqual([...SUBCOMMANDS], ['select', 'conflicts', 'coverage', 'validate']);
    assert.equal(APPLICABLE_PATH, '.planning/standing-orders/APPLICABLE.md');
    assert.equal(CONFLICTS_PATH, '.planning/standing-orders/CONFLICTS.json');
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
    for (const sub of ['select', 'conflicts', 'coverage']) {
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
    const complete = setup({ files: { [`${PHASE}/03-01-PLAN.md`]: planText({ truths: ['BILL-RULE holds'] }) } });
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
      files: { [`${PHASE}/03-01-PLAN.md`]: planText({ truths: ['REF-A holds', 'REF-B holds'] }) },
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
      files: { [`${PHASE}/03-01-PLAN.md`]: planText({ truths: ['BILL-RULE holds'] }) },
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
