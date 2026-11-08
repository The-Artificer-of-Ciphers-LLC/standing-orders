'use strict';

// Phase 5 (#6): the `promote` and `semantic` router subcommands, driven through routeStandingOrdersCommand with the
// argv shapes the shipping skills use (`--phase-dir <d> --raw`, `--add '<json>'`) over an injected in-memory filesystem.
// Test names follow .gsd/phase/feat-6-promotion-llm-conflicts/50-test-matrix.md (rows 29-36, 41, 51-56).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const router = require('../standing-orders-router.cjs');
const { routeStandingOrdersCommand, exitCodeFor } = router;
const { doc, order } = require('./helpers/fixtures.cjs');
const { memfs } = require('./helpers/memfs.cjs');

const CONFIG = '.planning/config.json';
const ORDERS = '.planning/standing-orders/ORDERS.yaml';
const PHASE = '.planning/phases/03-billing';
const SPEC_PATH = `${PHASE}/03-SPEC.md`;
const CONTEXT_PATH = `${PHASE}/03-CONTEXT.md`;
const SEM = `${PHASE}/STANDING-ORDERS-SEMANTIC.json`;
const PHASE_FLAG = ['--phase-dir', PHASE];
const DISABLED = 'standing-orders is not enabled; set standing-orders.enabled to true';
const TS = '2026-11-08T00:00:00.000Z';
const NOW = '2026-11-09T10:00:00.000Z';

const enabledConfig = () => JSON.stringify({ 'standing-orders': { enabled: true } });
const abs = (m, rel) => path.resolve(m.cwd, rel);

const SPEC_TEXT = [
  '# Phase 3 spec',
  '',
  '## Prohibitions (must-NOT)',
  '',
  '| statement | Requirement | Status | Verification / Reason |',
  '|---|---|---|---|',
  '| A refund is never executed twice. | BILL-04 | resolved | test: tests/billing/refund.test.cjs |',
  '| Never email card numbers. | n/a | resolved | judgment |',
  '| Never refund after 90 days. | BILL-05 | dismissed | out of scope |',
  '',
].join('\n');
const CONTEXT_TEXT = ['# Phase 3 context', '', '<decisions>', '- **D-01:** Refunds go through the ledger service.', '</decisions>', ''].join('\n');

const PLAIN_ORDERS = doc({ orders: [order({ id: 'BILL-RULE', statement: 'Bill rule.' }), order({ id: 'BILL-TWO', statement: 'Second bill rule.' })] });
const PROMOTED_ORDERS = doc({
  orders: [
    order({ id: 'BILL-RULE', statement: 'Bill rule.' }),
    order({ id: 'NO-DOUBLE-REFUND', kind: 'prohibition', statement: 'Worded differently on purpose.', source: `${SPEC_PATH} prohibition 1` }),
  ],
});

const NEW_ORDER_JSON = JSON.stringify({ id: 'NEW-RULE', kind: 'invariant', statement: 'A new rule.', verification: 'backstop' });
const FOUND = JSON.stringify([{ orders: ['BILL-RULE', 'BILL-TWO'], statement: 'The two bill rules contradict each other.' }]);

function setup({ config = enabledConfig(), orders = PLAIN_ORDERS, files = {}, links = {}, phaseFiles = true, overrides = {} } = {}) {
  const all = { ...(phaseFiles ? { [SPEC_PATH]: SPEC_TEXT, [CONTEXT_PATH]: CONTEXT_TEXT } : {}), ...files };
  if (config !== null) all[CONFIG] = config;
  if (orders !== null) all[ORDERS] = orders;
  return memfs({ files: all, dirs: [PHASE], links, overrides });
}

function run(m, args, { raw = false } = {}) {
  const result = routeStandingOrdersCommand({ args: ['standing-orders', ...args], cwd: m.cwd, raw, error: m.error, deps: m.deps });
  assert.equal(typeof result.then, 'undefined', 'the router never returns a Promise');
  return result;
}

const noWrites = (m) => {
  assert.deepEqual(m.calls.writeFile, []);
  assert.deepEqual(m.calls.appendFile, []);
  assert.deepEqual(m.calls.rename, []);
  assert.deepEqual(m.calls.mkdir, []);
};

const lastJson = (m) => JSON.parse(m.calls.log[m.calls.log.length - 1]);
const codeOf = (r) => (Array.isArray(r.errors) && r.errors.length > 0 ? r.errors[0].code : undefined);
const semFile = (findings, extra = {}) => JSON.stringify({ schema: 1, phase: PHASE, findings, ...extra }, null, 2) + '\n';
const openFinding = (overrides = {}) => ({
  id: 'S-1',
  orders: ['BILL-RULE'],
  statement: 'Contradicts the spec.',
  status: 'unresolved',
  reason: null,
  proposed_by: 'agent',
  resolved_by: null,
  ts: TS,
  ...overrides,
});

describe('router promote: --add', () => {
  it('routerPromoteAddDisabled', () => {
    for (const config of [null, JSON.stringify({ 'standing-orders': { enabled: false } }), JSON.stringify({})]) {
      const m = setup({ config });
      const r = run(m, ['promote', '--add', NEW_ORDER_JSON, '--raw']);
      assert.equal(r.ok, true);
      assert.equal(r.disabled, true);
      assert.equal(r.subcommand, 'promote');
      assert.equal(r.message, DISABLED);
      assert.deepEqual(r.written, []);
      noWrites(m);
      assert.equal(m.read(ORDERS), PLAIN_ORDERS, 'ORDERS.yaml untouched');
      assert.deepEqual(lastJson(m), r, '--raw prints the result as JSON');
      assert.equal(exitCodeFor(r), 0);
    }
  });

  it('routerPromoteFlagShapes', () => {
    const cases = [
      [['promote', '--add', NEW_ORDER_JSON, '--add', NEW_ORDER_JSON, '--raw'], 'batch_refused'],
      [['promote', '--add', `[${NEW_ORDER_JSON}]`, '--raw'], 'batch_refused'],
      [['promote', '--add', '[]', '--raw'], 'batch_refused'],
      [['promote', '--candidates', '--add', NEW_ORDER_JSON, ...PHASE_FLAG, '--raw'], 'usage'],
      [['promote', ...PHASE_FLAG, '--raw'], 'usage'],
      [['promote', '--raw'], 'usage'],
      [['promote'], 'usage'],
      [['promote', '--add', NEW_ORDER_JSON, ...PHASE_FLAG, '--raw'], 'usage'],
      [['promote', '--add', NEW_ORDER_JSON, '--phase', '3', '--raw'], 'usage'],
      [['promote', '--add', '--raw'], 'usage'],
      [['promote', '--add'], 'usage'],
      [['promote', '--add', 'not json', '--raw'], 'usage'],
      [['promote', '--add', '"a string"', '--raw'], 'usage'],
      [['promote', '--candidates', '--phase', '3', ...PHASE_FLAG, '--raw'], 'usage'],
      [['promote', '--candidates', ...PHASE_FLAG, '--bogus', '--raw'], 'usage'],
      [['promote', '--candidates', ...PHASE_FLAG, 'positional', '--raw'], 'usage'],
      [['promote', '--candidates', ...PHASE_FLAG, '--findings', FOUND, '--raw'], 'usage'],
    ];
    for (const [args, code] of cases) {
      const m = setup();
      const r = run(m, args);
      const label = args.join(' ');
      assert.equal(r.ok, false, label);
      assert.equal(r.subcommand, 'promote', label);
      assert.equal(codeOf(r), code, label);
      assert.deepEqual(r.written, [], label);
      assert.equal(m.calls.error.length, 1, `${label}: the message is reported once`);
      noWrites(m);
      assert.equal(m.read(ORDERS), PLAIN_ORDERS, label);
      assert.equal(exitCodeFor(r), 1, label);
    }
  });

  it('routerPromoteAddWritesOneOrderAtomically', () => {
    const m = setup();
    const r = run(m, ['promote', '--add', NEW_ORDER_JSON, '--raw']);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.subcommand, 'promote');
    assert.equal(r.mode, 'add');
    assert.equal(r.added, 'NEW-RULE');
    assert.deepEqual(r.written, [router.DEFAULT_ORDERS_PATH]);
    assert.equal(m.read(ORDERS), PLAIN_ORDERS + '  - id: "NEW-RULE"\n    kind: "invariant"\n    statement: "A new rule."\n    verification: "backstop"\n');
    assert.equal(m.calls.rename.length, 1, 'one atomic replace');
    assert.equal(m.calls.rename[0][1], abs(m, ORDERS));
    assert.deepEqual(m.calls.writeFile.map((p) => p === abs(m, ORDERS)), [false], 'the target is never written directly');
    assert.deepEqual(lastJson(m), r);
    assert.equal(exitCodeFor(r), 0);
    // the file now validates, with the new order in it
    const check = run(m, ['validate', '--raw']);
    assert.equal(check.ok, true, JSON.stringify(check));
    assert.equal(check.summary.orders, 3);
  });

  it('routerPromoteAddCreatesMissingFile', () => {
    const m = setup({ orders: null });
    const r = run(m, ['promote', '--add', NEW_ORDER_JSON, '--raw']);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(m.read(ORDERS), 'version: "1"\norders:\n  - id: "NEW-RULE"\n    kind: "invariant"\n    statement: "A new rule."\n    verification: "backstop"\n');
    assert.deepEqual(r.written, [router.DEFAULT_ORDERS_PATH]);
    assert.ok(m.calls.mkdir.includes(path.dirname(abs(m, ORDERS))), 'the output directory is created');
  });

  it('routerPromoteRefusals', () => {
    const cases = [
      ['duplicate id', { orders: PLAIN_ORDERS }, JSON.stringify({ id: 'BILL-RULE', kind: 'invariant', statement: 'x', verification: 'backstop' }), 'duplicate_id'],
      ['invalid order', { orders: PLAIN_ORDERS }, JSON.stringify({ id: 'BAD-1', kind: 'invariant', statement: 'x', verification: 'backstop', bogus: 1 }), 'invalid_order'],
      ['variant without outcome', { orders: PLAIN_ORDERS }, JSON.stringify({ id: 'V-1', kind: 'variant', statement: 'x', operation: 'op.x', verification: 'backstop' }), 'invalid_order'],
      ['broken file', { orders: 'version: "1"\norders: not-a-list\n' }, NEW_ORDER_JSON, 'orders_unusable'],
      ['flow list', { orders: 'version: "1"\norders: [{id: A}]\n' }, NEW_ORDER_JSON, 'insert_unsupported'],
    ];
    for (const [label, setupArgs, json, code] of cases) {
      const m = setup(setupArgs);
      const before = m.read(ORDERS);
      const r = run(m, ['promote', '--add', json, '--raw']);
      assert.equal(r.ok, false, label);
      assert.equal(r.subcommand, 'promote', label);
      assert.equal(codeOf(r), code, label);
      assert.deepEqual(r.written, [], label);
      assert.equal(m.read(ORDERS), before, `${label}: ORDERS.yaml is byte-identical`);
      noWrites(m);
      assert.equal(m.calls.error.length, 1, label);
      assert.equal(exitCodeFor(r), 1, label);
      if (code === 'insert_unsupported') {
        assert.equal(r.paste, '  - id: "NEW-RULE"\n    kind: "invariant"\n    statement: "A new rule."\n    verification: "backstop"\n', 'the paste-ready block');
      }
      assert.deepEqual(lastJson(m), r, `${label}: --raw prints the refusal as JSON`);
    }
  });

  it('routerPromoteRefusesLinkedOrders', () => {
    const linked = setup({ orders: null, links: { [ORDERS]: '/etc/outside' } });
    const r = run(linked, ['promote', '--add', NEW_ORDER_JSON, '--raw']);
    assert.equal(r.ok, false);
    assert.equal(codeOf(r), 'path_outside_cwd');
    noWrites(linked);
    assert.equal(exitCodeFor(r), 2);

    // over the size the router reads: refused before anything is parsed
    const big = setup({ orders: 'version: "1"\norders:\n# ' + 'x'.repeat(router.MAX_FILE_BYTES) + '\n' });
    const bigResult = run(big, ['promote', '--add', NEW_ORDER_JSON, '--raw']);
    assert.equal(codeOf(bigResult), 'file_too_large');
    noWrites(big);
    assert.equal(exitCodeFor(bigResult), 2);
  });

  it('routerPromoteRefusesOversizeResult', () => {
    const base = doc({ orders: [order({ id: 'BILL-RULE', statement: 'Bill rule.' })] });
    const pad = router.MAX_FILE_BYTES - 1 - Buffer.byteLength(base, 'utf8') - 3;
    const text = `${base}# ${'x'.repeat(pad)}\n`;
    assert.equal(Buffer.byteLength(text, 'utf8'), router.MAX_FILE_BYTES - 1);
    const m = setup({ orders: text });
    const r = run(m, ['promote', '--add', NEW_ORDER_JSON, '--raw']);
    assert.equal(r.ok, false);
    assert.equal(codeOf(r), 'file_too_large');
    assert.equal(m.read(ORDERS), text, 'the file is untouched');
    noWrites(m);
    assert.equal(exitCodeFor(r), 2);
  });

  it('routerPromoteReportsWriteFailure', () => {
    for (const failing of ['writeFile', 'rename']) {
      const m = setup({ overrides: { [failing]: () => { throw new Error('disk full'); } } });
      const r = run(m, ['promote', '--add', NEW_ORDER_JSON, '--raw']);
      assert.equal(r.ok, false, failing);
      assert.equal(r.subcommand, 'promote', failing);
      assert.ok(Array.isArray(r.errors) && r.errors.length === 1, failing);
      assert.match(r.errors[0].message, /disk full/, failing);
      assert.equal(m.read(ORDERS), PLAIN_ORDERS, `${failing}: ORDERS.yaml is intact`);
      assert.deepEqual(r.written, [], failing);
      assert.equal(exitCodeFor(r), 1, failing);
    }
  });
});

describe('router promote: --candidates', () => {
  it('routerPromoteCandidates', () => {
    for (const config of [enabledConfig(), null]) {
      const m = setup({ orders: PROMOTED_ORDERS, config });
      const r = run(m, ['promote', '--candidates', ...PHASE_FLAG, '--raw']);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.subcommand, 'promote');
      assert.equal(r.mode, 'candidates');
      assert.notEqual(r.disabled, true, 'candidates are not gated on enabled');
      assert.equal(r.phase_dir, PHASE);
      assert.equal(r.truncated, false);
      assert.deepEqual(r.looked_for, ['*-SPEC.md', '*-CONTEXT.md']);
      assert.deepEqual(r.warnings, []);
      assert.deepEqual(r.written, []);
      assert.deepEqual(r.candidates, [
        { origin: 'spec-prohibition', source: `${SPEC_PATH} prohibition 1`, statement: 'A refund is never executed twice.', requirements: ['BILL-04'], verification: 'test', already_promoted: true, promoted_as: 'NO-DOUBLE-REFUND' },
        { origin: 'spec-prohibition', source: `${SPEC_PATH} prohibition 2`, statement: 'Never email card numbers.', requirements: [], verification: 'backstop', already_promoted: false, promoted_as: null },
        { origin: 'context-decision', source: `${CONTEXT_PATH} D-01`, statement: 'Refunds go through the ledger service.', requirements: [], verification: 'backstop', already_promoted: false, promoted_as: null },
      ]);
      noWrites(m);
      assert.deepEqual(lastJson(m), r);
      assert.equal(exitCodeFor(r), 0);
    }
  });

  it('routerPromoteCandidatesHumanLines', () => {
    const m = setup({ orders: PROMOTED_ORDERS });
    const r = run(m, ['promote', '--candidates', ...PHASE_FLAG]);
    assert.equal(r.ok, true);
    assert.deepEqual(m.calls.log, [
      `1. [spec-prohibition] A refund is never executed twice. (${SPEC_PATH} prohibition 1) - already promoted as NO-DOUBLE-REFUND`,
      `2. [spec-prohibition] Never email card numbers. (${SPEC_PATH} prohibition 2)`,
      `3. [context-decision] Refunds go through the ledger service. (${CONTEXT_PATH} D-01)`,
    ]);
  });

  it('routerPromoteCandidatesOrdersFileStates', () => {
    const missing = setup({ orders: null });
    const r1 = run(missing, ['promote', '--candidates', ...PHASE_FLAG, '--raw']);
    assert.equal(r1.ok, true);
    assert.equal(r1.candidates.length, 3);
    assert.ok(r1.candidates.every((c) => c.already_promoted === false && c.promoted_as === null));
    assert.ok(!r1.warnings.some((w) => w.code === 'orders_unusable'));

    for (const orders of ['version: "1"\norders: not-a-list\n', 'not: [valid']) {
      const invalid = setup({ orders });
      const r2 = run(invalid, ['promote', '--candidates', ...PHASE_FLAG, '--raw']);
      assert.equal(r2.ok, true, 'candidates are still listed');
      assert.equal(r2.candidates.length, 3);
      assert.ok(r2.candidates.every((c) => c.already_promoted === null && c.promoted_as === null));
      assert.ok(r2.warnings.some((w) => w.code === 'orders_unusable'));
      noWrites(invalid);
      assert.equal(exitCodeFor(r2), 0);
    }
  });

  it('routerPromoteCandidatesNoPhaseFiles', () => {
    const m = setup({ phaseFiles: false, files: { [`${PHASE}/03-PLAN.md`]: '# plan\n', [`${PHASE}/03-UI-SPEC.md`]: SPEC_TEXT, [`${PHASE}/03-AI-SPEC.md`]: SPEC_TEXT } });
    const r = run(m, ['promote', '--candidates', ...PHASE_FLAG, '--raw']);
    assert.equal(r.ok, true);
    assert.deepEqual(r.candidates, [], 'UI-SPEC.md and AI-SPEC.md are not SPEC.md');
    assert.deepEqual(r.looked_for, ['*-SPEC.md', '*-CONTEXT.md']);
    assert.equal(r.truncated, false);
    assert.deepEqual(m.calls.readFile.filter((p) => p.includes('SPEC')), [], 'those files are not even read');
  });

  it('routerCandidatesSkipsBadFiles', () => {
    const skipped = (r, name) => r.warnings.filter((w) => w.code === 'phase_file_skipped' && w.message.includes(name));

    // a link that resolves outside the project
    const linked = setup({ phaseFiles: false, files: { [CONTEXT_PATH]: CONTEXT_TEXT }, links: { [SPEC_PATH]: '/etc/outside/SPEC.md' } });
    const isFile = linked.deps.isFile;
    linked.deps.isFile = (p) => isFile(p) || p === abs(linked, SPEC_PATH);
    const r1 = run(linked, ['promote', '--candidates', ...PHASE_FLAG, '--raw']);
    assert.equal(r1.ok, true, JSON.stringify(r1));
    assert.equal(skipped(r1, '03-SPEC.md').length, 1, JSON.stringify(r1.warnings));
    assert.deepEqual(r1.candidates.map((c) => c.origin), ['context-decision'], 'the other file is still read');
    assert.ok(!linked.calls.readFile.includes('/etc/outside/SPEC.md'));
    assert.equal(exitCodeFor(r1), 0);

    // over the 1 MiB cap
    const oversized = setup({ files: { [SPEC_PATH]: 'x'.repeat(1024 * 1024 + 1) } });
    const r2 = run(oversized, ['promote', '--candidates', ...PHASE_FLAG, '--raw']);
    assert.equal(r2.ok, true);
    assert.equal(skipped(r2, '03-SPEC.md').length, 1);
    assert.deepEqual(r2.candidates.map((c) => c.origin), ['context-decision']);

    // unreadable
    const unreadable = setup();
    const readFile = unreadable.deps.readFile;
    unreadable.deps.readFile = (p) => {
      if (p === abs(unreadable, SPEC_PATH)) throw new Error('EIO: read failed');
      return readFile(p);
    };
    const r3 = run(unreadable, ['promote', '--candidates', ...PHASE_FLAG, '--raw']);
    assert.equal(r3.ok, true);
    assert.equal(skipped(r3, '03-SPEC.md').length, 1);
    assert.deepEqual(r3.candidates.map((c) => c.origin), ['context-decision']);
    noWrites(unreadable);

    // exactly 1 MiB is read
    const edge = setup({ files: { [SPEC_PATH]: SPEC_TEXT + '\n' + 'x'.repeat(1024 * 1024 - Buffer.byteLength(SPEC_TEXT, 'utf8') - 1) } });
    assert.equal(Buffer.byteLength(edge.read(SPEC_PATH), 'utf8'), 1024 * 1024);
    const r4 = run(edge, ['promote', '--candidates', ...PHASE_FLAG, '--raw']);
    assert.equal(skipped(r4, '03-SPEC.md').length, 0);
    assert.equal(r4.candidates.length, 3);
  });

  it('routerCandidatesContainsPhaseDir', () => {
    const outside = setup();
    const r1 = run(outside, ['promote', '--candidates', '--phase-dir', '../outside', '--raw']);
    assert.equal(r1.ok, false);
    assert.equal(r1.subcommand, 'promote');
    assert.equal(codeOf(r1), 'path_outside_cwd');
    assert.equal(exitCodeFor(r1), 2);
    noWrites(outside);
    assert.deepEqual(outside.calls.readFile.filter((p) => p.includes('SPEC') || p.includes('CONTEXT')), []);

    const absolute = setup();
    assert.equal(codeOf(run(absolute, ['promote', '--candidates', '--phase-dir', '/etc', '--raw'])), 'path_outside_cwd');

    const linked = setup({ links: { '.planning/phases/04-linked': '/etc/outside' } });
    assert.equal(codeOf(run(linked, ['promote', '--candidates', '--phase-dir', '.planning/phases/04-linked', '--raw'])), 'path_outside_cwd');

    const absent = setup();
    const r2 = run(absent, ['promote', '--candidates', '--phase-dir', '.planning/phases/99-none', '--raw']);
    assert.equal(r2.ok, false);
    assert.equal(codeOf(r2), 'phase_dir_not_found');
    noWrites(absent);
  });

  it('routerPromoteThenCandidatesMarks', () => {
    const m = setup();
    const before = run(m, ['promote', '--candidates', ...PHASE_FLAG, '--raw']);
    assert.equal(before.candidates.length, 3);
    assert.ok(before.candidates.every((c) => c.already_promoted === false));
    const pick = before.candidates[1];

    const added = run(m, ['promote', '--add', JSON.stringify({ id: 'NO-CARD-EMAILS', kind: 'prohibition', statement: pick.statement, source: pick.source, verification: 'backstop' }), '--raw']);
    assert.equal(added.ok, true, JSON.stringify(added));

    const after = run(m, ['promote', '--candidates', ...PHASE_FLAG, '--raw']);
    assert.equal(after.candidates.length, 3, 're-running marks, it does not hide');
    assert.deepEqual(after.candidates.map((c) => c.already_promoted), [false, true, false]);
    assert.equal(after.candidates[1].promoted_as, 'NO-CARD-EMAILS');
    assert.deepEqual(after.candidates.map((c) => c.source), before.candidates.map((c) => c.source));
  });
});

describe('router promote: exit codes', () => {
  it('exitCodesForPromoteAndSemantic', () => {
    for (const subcommand of ['promote', 'semantic']) {
      const failed = (code) => ({ schema: 1, subcommand, ok: false, errors: [{ code, message: 'm' }], written: [] });
      assert.equal(exitCodeFor({ schema: 1, subcommand, ok: true, written: [] }), 0, `${subcommand} ok`);
      assert.equal(exitCodeFor({ schema: 1, subcommand, ok: true, disabled: true, message: DISABLED, written: [] }), 0, `${subcommand} disabled`);
      for (const code of ['usage', 'batch_refused', 'duplicate_id', 'invalid_order', 'insert_unsupported', 'orders_unusable', 'reason_required', 'auto_never_dismisses', 'auto_cannot_confirm', 'finding_not_found', 'unknown_order', 'too_many_findings', 'invalid_finding', 'semantic_unusable', 'phase_dir_not_found', 'write_failed', 'internal_error']) {
        assert.equal(exitCodeFor(failed(code)), 1, `${subcommand} ${code}`);
      }
      for (const code of ['path_outside_cwd', 'file_not_found', 'file_unreadable', 'file_too_large']) {
        assert.equal(exitCodeFor(failed(code)), 2, `${subcommand} ${code}`);
      }
    }
    assert.ok(router.SUBCOMMANDS.includes('promote') && router.SUBCOMMANDS.includes('semantic'));
  });
});

describe('router semantic', () => {
  it('routerAutoNeverDismisses', () => {
    const text = semFile([openFinding()]);
    for (const [args, code] of [
      [['--id', 'S-1', '--status', 'dismissed', '--reason', 'r', '--auto'], 'auto_never_dismisses'],
      [['--id', 'S-1', '--status', 'resolved', '--auto'], 'auto_cannot_confirm'],
      [['--id', 'S-1', '--status', 'unresolved', '--auto'], 'auto_cannot_confirm'],
    ]) {
      const m = setup({ files: { [SEM]: text } });
      const r = run(m, ['semantic', 'resolve', ...PHASE_FLAG, ...args, '--raw']);
      assert.equal(r.ok, false, args.join(' '));
      assert.equal(r.subcommand, 'semantic');
      assert.equal(codeOf(r), code, args.join(' '));
      assert.equal(m.read(SEM), text, 'the semantic file is byte-identical');
      noWrites(m);
      assert.equal(exitCodeFor(r), 1);
      assert.deepEqual(lastJson(m), r);
    }
  });

  it('routerSemanticDisabled', () => {
    for (const config of [null, JSON.stringify({ 'standing-orders': { enabled: false } })]) {
      const m = setup({ config });
      for (const args of [
        ['propose', ...PHASE_FLAG, '--findings', FOUND, '--raw'],
        ['resolve', ...PHASE_FLAG, '--id', 'S-1', '--status', 'resolved', '--raw'],
      ]) {
        const r = run(m, ['semantic', ...args]);
        assert.equal(r.ok, true, args[0]);
        assert.equal(r.disabled, true, args[0]);
        assert.equal(r.subcommand, 'semantic', args[0]);
        assert.equal(r.message, DISABLED, args[0]);
        assert.deepEqual(r.written, [], args[0]);
        assert.equal(exitCodeFor(r), 0, args[0]);
      }
      noWrites(m);
      assert.equal(m.has(SEM), false);
    }
  });

  it('routerSemanticNeverOverwritesInvalid', () => {
    const invalid = {
      'not json': '{not json',
      'dismissed with blank reason': semFile([openFinding({ status: 'dismissed', reason: '  ', resolved_by: 'human' })]),
      'bad status': semFile([openFinding({ status: 'maybe' })]),
      'schema 2': semFile([], { schema: 2 }),
      'duplicate ids': semFile([openFinding(), openFinding({ statement: 'again' })]),
      'a bare array': '[]',
    };
    for (const [label, text] of Object.entries(invalid)) {
      for (const args of [
        ['propose', ...PHASE_FLAG, '--findings', FOUND, '--raw'],
        ['resolve', ...PHASE_FLAG, '--id', 'S-1', '--status', 'resolved', '--raw'],
        ['list', ...PHASE_FLAG, '--raw'],
      ]) {
        const m = setup({ files: { [SEM]: text } });
        const r = run(m, ['semantic', ...args]);
        assert.equal(r.ok, false, `${label}: ${args[0]}`);
        assert.equal(codeOf(r), 'semantic_unusable', `${label}: ${args[0]}`);
        assert.equal(m.read(SEM), text, `${label}: ${args[0]}: never overwritten`);
        noWrites(m);
        assert.equal(exitCodeFor(r), 1, label);
      }
    }
  });

  it('routerSemanticList', () => {
    const missing = setup();
    const r1 = run(missing, ['semantic', 'list', ...PHASE_FLAG, '--raw']);
    assert.equal(r1.ok, true, JSON.stringify(r1));
    assert.equal(r1.subcommand, 'semantic');
    assert.equal(r1.action, 'list');
    assert.deepEqual(r1.findings, []);
    assert.deepEqual(r1.counts, { unresolved: 0, resolved: 0, dismissed: 0 });
    assert.deepEqual(r1.written, []);
    noWrites(missing);
    assert.equal(exitCodeFor(r1), 0);

    const findings = [
      openFinding({ id: 'S-1' }),
      openFinding({ id: 'S-2', statement: 'second', status: 'resolved', resolved_by: 'human' }),
      openFinding({ id: 'S-3', statement: 'third', status: 'dismissed', reason: 'not a conflict', resolved_by: 'human' }),
      openFinding({ id: 'S-5', statement: 'fifth' }),
    ];
    for (const config of [enabledConfig(), null]) {
      const present = setup({ files: { [SEM]: semFile(findings) }, config });
      const r2 = run(present, ['semantic', 'list', ...PHASE_FLAG, '--raw']);
      assert.equal(r2.ok, true);
      assert.notEqual(r2.disabled, true, 'list is not gated on enabled');
      assert.deepEqual(r2.findings, findings);
      assert.deepEqual(r2.counts, { unresolved: 2, resolved: 1, dismissed: 1 });
      noWrites(present);
      assert.deepEqual(lastJson(present), r2);
    }
  });

  it('routerSemanticRefusesLink', () => {
    const text = semFile([openFinding()]);
    for (const args of [
      ['propose', ...PHASE_FLAG, '--findings', FOUND, '--raw'],
      ['resolve', ...PHASE_FLAG, '--id', 'S-1', '--status', 'resolved', '--raw'],
      ['list', ...PHASE_FLAG, '--raw'],
    ]) {
      for (const target of ['/etc/outside/semantic.json', abs(setup(), `${PHASE}/real-target.json`)]) {
        const m = setup({ links: { [SEM]: target }, files: { [`${PHASE}/real-target.json`]: text } });
        const r = run(m, ['semantic', ...args]);
        assert.equal(r.ok, false, args[0]);
        assert.equal(codeOf(r), 'semantic_unusable', args[0]);
        noWrites(m);
        assert.equal(exitCodeFor(r), 1);
      }
    }
  });

  it('routerSemanticRefusesOversizeFile', () => {
    const m = setup({ files: { [SEM]: ' '.repeat(4 * 1024 * 1024 + 1) } });
    const r = run(m, ['semantic', 'list', ...PHASE_FLAG, '--raw']);
    assert.equal(r.ok, false);
    assert.equal(codeOf(r), 'semantic_unusable');
    noWrites(m);
  });

  it('routerSemanticUsage', () => {
    const cases = [
      ['semantic'],
      ['semantic', '--raw'],
      ['semantic', 'frobnicate', ...PHASE_FLAG, '--raw'],
      ['semantic', 'list', ...PHASE_FLAG, '--findings', FOUND, '--raw'],
      ['semantic', 'list', ...PHASE_FLAG, '--auto', '--raw'],
      ['semantic', 'list', ...PHASE_FLAG, '--id', 'S-1', '--raw'],
      ['semantic', 'propose', ...PHASE_FLAG, '--id', 'S-1', '--findings', FOUND, '--raw'],
      ['semantic', 'propose', ...PHASE_FLAG, '--status', 'resolved', '--findings', FOUND, '--raw'],
      ['semantic', 'propose', ...PHASE_FLAG, '--raw'],
      ['semantic', 'resolve', ...PHASE_FLAG, '--findings', FOUND, '--id', 'S-1', '--status', 'resolved', '--raw'],
      ['semantic', 'resolve', ...PHASE_FLAG, '--status', 'resolved', '--raw'],
      ['semantic', 'resolve', ...PHASE_FLAG, '--id', 'S-1', '--raw'],
      ['semantic', 'resolve', ...PHASE_FLAG, '--id', 'S-1', '--status', 'bogus', '--raw'],
      ['semantic', 'list', '--raw'],
      ['semantic', 'list', '--phase', '3', ...PHASE_FLAG, '--raw'],
      ['semantic', 'list', ...PHASE_FLAG, 'positional', '--raw'],
      ['semantic', 'list', ...PHASE_FLAG, '--bogus', '--raw'],
      ['semantic', 'list', '--phase-dir', '--raw'],
    ];
    for (const args of cases) {
      const m = setup({ files: { [SEM]: semFile([openFinding()]) } });
      const r = run(m, args);
      const label = args.join(' ');
      assert.equal(r.ok, false, label);
      assert.equal(r.subcommand, 'semantic', label);
      assert.equal(codeOf(r), 'usage', label);
      assert.equal(m.calls.error.length, 1, label);
      noWrites(m);
      assert.equal(m.calls.execFile.length, 0, label);
      assert.equal(exitCodeFor(r), 1, label);
    }
  });

  it('routerSemanticRefusesUnreadableFindings', () => {
    for (const findings of ['not json', '{"orders":["BILL-RULE"],"statement":"x"}', '[]', '"s"', 'null']) {
      const m = setup({ files: { [SEM]: semFile([openFinding()]) } });
      const before = m.read(SEM);
      const r = run(m, ['semantic', 'propose', ...PHASE_FLAG, '--findings', findings, '--raw']);
      assert.equal(r.ok, false, findings);
      assert.ok(['usage', 'invalid_finding'].includes(codeOf(r)), `${findings}: ${codeOf(r)}`);
      assert.equal(m.read(SEM), before, findings);
      noWrites(m);
      assert.equal(exitCodeFor(r), 1, findings);
    }
  });

  it('routerSemanticContainsPhaseDir', () => {
    for (const args of [
      ['propose', '--phase-dir', '../outside', '--findings', FOUND, '--raw'],
      ['resolve', '--phase-dir', '../outside', '--id', 'S-1', '--status', 'resolved', '--raw'],
      ['list', '--phase-dir', '../outside', '--raw'],
    ]) {
      const m = setup();
      const r = run(m, ['semantic', ...args]);
      assert.equal(r.ok, false, args[0]);
      assert.equal(codeOf(r), 'path_outside_cwd', args[0]);
      noWrites(m);
      assert.equal(exitCodeFor(r), 2, args[0]);
    }
  });

  it('routerSemanticProposeNeedsKnownOrders', () => {
    const unknown = setup({ files: { [SEM]: semFile([openFinding()]) } });
    const before = unknown.read(SEM);
    const r1 = run(unknown, ['semantic', 'propose', ...PHASE_FLAG, '--findings', JSON.stringify([{ orders: ['BILL-RULE', 'NOPE'], statement: 'x' }]), '--raw']);
    assert.equal(codeOf(r1), 'unknown_order');
    assert.equal(unknown.read(SEM), before);
    noWrites(unknown);
    assert.equal(exitCodeFor(r1), 1);

    for (const orders of [null, 'version: "1"\norders: not-a-list\n']) {
      const m = setup({ orders });
      const r2 = run(m, ['semantic', 'propose', ...PHASE_FLAG, '--findings', FOUND, '--raw']);
      assert.equal(r2.ok, false);
      assert.equal(codeOf(r2), 'orders_unusable');
      assert.equal(m.has(SEM), false);
      noWrites(m);
      assert.equal(exitCodeFor(r2), 1);
    }

    const tooMany = setup();
    const many = JSON.stringify(Array.from({ length: 51 }, (_, i) => ({ orders: ['BILL-RULE'], statement: `finding ${i}` })));
    assert.equal(codeOf(run(tooMany, ['semantic', 'propose', ...PHASE_FLAG, '--findings', many, '--raw'])), 'too_many_findings');
    noWrites(tooMany);
  });

  it('routerSemanticReportsWriteFailure', () => {
    const m = setup({ overrides: { rename: () => { throw new Error('disk full'); } } });
    const r = run(m, ['semantic', 'propose', ...PHASE_FLAG, '--findings', FOUND, '--raw']);
    assert.equal(r.ok, false);
    assert.equal(r.subcommand, 'semantic');
    assert.match(r.errors[0].message, /disk full/);
    assert.equal(m.has(SEM), false);
    assert.equal(exitCodeFor(r), 1);
  });

  it('routerSemanticEndToEnd', () => {
    let clock = NOW;
    const m = setup({ overrides: { now: () => new Date(clock) } });

    const proposed = run(m, ['semantic', 'propose', ...PHASE_FLAG, '--findings', FOUND, '--raw']);
    assert.equal(proposed.ok, true, JSON.stringify(proposed));
    assert.equal(proposed.subcommand, 'semantic');
    assert.equal(proposed.action, 'propose');
    assert.deepEqual(proposed.added, ['S-1']);
    assert.deepEqual(proposed.duplicates, []);
    assert.deepEqual(proposed.counts, { unresolved: 1, resolved: 0, dismissed: 0 });
    assert.deepEqual(proposed.written, [SEM]);
    assert.equal(m.calls.rename.length, 1);
    assert.equal(m.calls.rename[0][1], abs(m, SEM), 'written atomically');
    assert.deepEqual(JSON.parse(m.read(SEM)), {
      schema: 1,
      phase: PHASE,
      findings: [{ id: 'S-1', orders: ['BILL-RULE', 'BILL-TWO'], statement: 'The two bill rules contradict each other.', status: 'unresolved', reason: null, proposed_by: 'agent', resolved_by: null, ts: NOW }],
    });
    assert.ok(m.read(SEM).endsWith('}\n'));
    assert.equal(exitCodeFor(proposed), 0);

    // the same finding again, in another order: nothing new
    const afterFirst = m.read(SEM);
    const again = run(m, ['semantic', 'propose', ...PHASE_FLAG, '--findings', JSON.stringify([{ orders: ['BILL-TWO', 'BILL-RULE'], statement: 'The two bill rules   contradict each other.' }]), '--raw']);
    assert.equal(again.ok, true);
    assert.deepEqual(again.added, []);
    assert.deepEqual(again.duplicates, [0]);
    assert.equal(m.read(SEM), afterFirst);

    // an unattended proposal is allowed and is marked
    clock = '2026-11-09T11:00:00.000Z';
    const auto = run(m, ['semantic', 'propose', ...PHASE_FLAG, '--findings', JSON.stringify([{ orders: ['BILL-RULE'], statement: 'A second, separate finding.' }]), '--auto', '--raw']);
    assert.equal(auto.ok, true, JSON.stringify(auto));
    assert.deepEqual(auto.added, ['S-2']);
    const afterAuto = JSON.parse(m.read(SEM)).findings;
    assert.equal(afterAuto[1].proposed_by, 'auto');
    assert.equal(afterAuto[1].ts, '2026-11-09T11:00:00.000Z');
    assert.equal(afterAuto[0].ts, NOW, 'the first finding keeps its time');

    // a human decides
    clock = '2026-11-09T12:00:00.000Z';
    const noReason = run(m, ['semantic', 'resolve', ...PHASE_FLAG, '--id', 'S-1', '--status', 'dismissed', '--raw']);
    assert.equal(codeOf(noReason), 'reason_required');
    const blank = run(m, ['semantic', 'resolve', ...PHASE_FLAG, '--id', 'S-1', '--status', 'dismissed', '--reason', '   ', '--raw']);
    assert.equal(codeOf(blank), 'reason_required');
    assert.equal(JSON.parse(m.read(SEM)).findings[0].status, 'unresolved');

    const dismissed = run(m, ['semantic', 'resolve', ...PHASE_FLAG, '--id', 'S-1', '--status', 'dismissed', '--reason', 'They apply to different contexts.', '--raw']);
    assert.equal(dismissed.ok, true, JSON.stringify(dismissed));
    assert.equal(dismissed.action, 'resolve');
    assert.equal(dismissed.finding.id, 'S-1');
    assert.equal(dismissed.finding.status, 'dismissed');
    assert.equal(dismissed.finding.reason, 'They apply to different contexts.');
    assert.equal(dismissed.finding.resolved_by, 'human');
    assert.equal(dismissed.finding.ts, '2026-11-09T12:00:00.000Z');
    assert.deepEqual(dismissed.counts, { unresolved: 1, resolved: 0, dismissed: 1 });
    assert.deepEqual(dismissed.written, [SEM]);

    const confirmed = run(m, ['semantic', 'resolve', ...PHASE_FLAG, '--id', 'S-2', '--status', 'resolved', '--reason', 'Fix ORDERS.yaml.', '--raw']);
    assert.equal(confirmed.ok, true);
    assert.deepEqual(confirmed.counts, { unresolved: 0, resolved: 1, dismissed: 1 });

    const missing = run(m, ['semantic', 'resolve', ...PHASE_FLAG, '--id', 'S-9', '--status', 'resolved', '--raw']);
    assert.equal(codeOf(missing), 'finding_not_found');

    const listed = run(m, ['semantic', 'list', ...PHASE_FLAG, '--raw']);
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.counts, { unresolved: 0, resolved: 1, dismissed: 1 });
    assert.deepEqual(listed.findings.map((f) => [f.id, f.status]), [['S-1', 'dismissed'], ['S-2', 'resolved']]);
    assert.deepEqual(listed.written, []);
  });

  it('routerSemanticHumanOutputAndPhaseRel', () => {
    const m = setup();
    const r = run(m, ['semantic', 'propose', ...PHASE_FLAG, '--findings', FOUND]);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(m.calls.log.length >= 1, 'a human-readable summary is printed');
    for (const line of m.calls.log) assert.doesNotThrow(() => String(line));
    assert.equal(JSON.parse(m.read(SEM)).phase, PHASE, 'the document records the phase directory relative to the project root, with slashes');
  });
});
