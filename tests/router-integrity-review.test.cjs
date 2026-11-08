'use strict';

// #15 review findings F1-F7, test-first: a missing record is always flagged, trace needs order_hash and integrity,
// coverage will not re-baseline changed check files, oversize files, brace bound, directory/bracket entries, operation keys.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');

const { routeStandingOrdersCommand } = require('../standing-orders-router.cjs');
const { TRACE_PATH, orderHash, dispositionFor } = require('../lib/trace.cjs');
const { evaluateCoverage } = require('../lib/gate.cjs');
const { detectConflicts } = require('../lib/conflicts.cjs');
const { doc, testOrder, yamlOf, parsed, variant } = require('./helpers/fixtures.cjs');
const { memfs } = require('./helpers/memfs.cjs');

const CONFIG = '.planning/config.json';
const ORDERS = '.planning/standing-orders/ORDERS.yaml';
const ENFORCEMENT = '.planning/standing-orders/ENFORCEMENT.json';
const PHASE = '.planning/phases/03-billing';
const INTEGRITY = `${PHASE}/STANDING-ORDERS-INTEGRITY.json`;
const PLAN = `${PHASE}/03-01-PLAN.md`;
const HOST_CLI = '/opt/gsd/bin/gsd-tools.cjs';
const COMMITTED = JSON.stringify({ committed: true, hash: 'abc1234', skipped: false, reason: null });
const GREEN = JSON.stringify({ status: 'green', flagged: false, tier: 'test', reason: 'ok', located: true, kind: 'node-test', evidence: [] });
const T_A = testOrder({ id: 'T-A', statement: 'Never A.', scope: { paths: ['src/billing/**'] }, check_target: 'tests/a.test.cjs' });
const PROJECT_FILES = {
  'tests/a.test.cjs': '// a\n',
  'tests/fixtures/bad.js': 'bad\n',
  'tests/fixtures/good.js': 'good\n',
  'src/billing/refund.js': 'refund\n',
};
const proj = { statement: 'T-A: rule', status: 'resolved', verification: 'test', check_kind: 'node-test', check_target: 'tests/a.test.cjs', check_violation_fixture: 'tests/fixtures/bad.js', check_clean_fixture: 'tests/fixtures/good.js' };
const planText = (files = []) => {
  const data = { requirements: ['X-1'], must_haves: { truths: [], prohibitions: [proj] } };
  if (files.length > 0) data.files_modified = files;
  return '---\n' + yamlOf(data) + '---\nbody\n';
};

function setup({ orders = doc({ orders: [T_A] }), plan = planText(), files = {} } = {}) {
  const execCalls = [];
  const execFile = (file, args) => {
    if (file === 'git') return 'a1'.repeat(20) + '\n';
    if (args.includes('prohibition-enforcement')) {
      execCalls.push(1);
      return GREEN;
    }
    return COMMITTED;
  };
  const all = { [HOST_CLI]: '// host\n', [CONFIG]: JSON.stringify({ 'standing-orders': { enabled: true } }), [`${PHASE}/03-CONTEXT.md`]: 'The change touches `src/billing/refund.js`.\n', ...PROJECT_FILES, ...files };
  if (orders !== null) all[ORDERS] = orders;
  if (plan !== null) all[PLAN] = plan;
  const m = memfs({ files: all, overrides: { execFile, argv: ['node', HOST_CLI] } });
  m.execCalls = execCalls;
  return m;
}
const run = (m, sub) => routeStandingOrdersCommand({ args: ['standing-orders', sub, '--phase-dir', PHASE], cwd: m.cwd, raw: true, error: m.error, deps: m.deps });
const abs = (m, rel) => path.resolve(m.cwd, rel);
const edit = (m, rel, text) => m.deps.writeFile(abs(m, rel), text);
const remove = (m, rel) => m.deps.unlink(abs(m, rel));
const dispositionOf = (m, id) => m.read(TRACE_PATH).split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)).find((x) => x.order_id === id).disposition;

describe('F1: no integrity record is always flagged', () => {
  it('enforceWithoutRecordAndWithoutOrdersIsFlagged', () => {
    const m = setup({ orders: null, plan: null });
    const r = run(m, 'enforce');
    assert.equal(r.enforcement, 'flagged');
    assert.ok(r.reasons.some((x) => x.code === 'integrity_missing'));
  });

  it('coverageWithZeroOrdersWritesARecordThenEnforceIsClear', () => {
    const m = setup({ orders: null, plan: null });
    assert.equal(run(m, 'coverage').coverage, 'complete');
    assert.deepEqual(JSON.parse(m.read(INTEGRITY)).orders, { path: ORDERS, sha256: null });
    assert.equal(run(m, 'enforce').enforcement, 'clear');
  });

  it('deletingOrdersAndRecordAndEditingACheckIsFlagged', () => {
    const m = setup();
    run(m, 'coverage');
    remove(m, ORDERS);
    remove(m, INTEGRITY);
    edit(m, 'tests/a.test.cjs', '// edited\n');
    const r = run(m, 'enforce');
    assert.equal(r.enforcement, 'flagged');
    assert.equal(m.execCalls.length, 0);
  });
});

describe('F2: trace needs order_hash and integrity', () => {
  const document = parsed({ orders: [testOrder({ id: 'T-1', statement: 'Never A.' })] });
  const o = document.orders[0];
  const report = (extra, integrity) => ({ schema: 1, phase: PHASE, status: 'clear', results: [{ id: 'T-1', status: 'green', flagged: false, ...extra }], ...(integrity === undefined ? {} : { integrity }) });

  it('proofWithoutOrderHashOrIntegrityIsUnenforced', () => {
    const files = { files: {} };
    assert.equal(dispositionFor(o, report({ order_hash: orderHash(o) }, files), PHASE), 'proven');
    assert.equal(dispositionFor(o, report({}, files), PHASE), 'unenforced', 'no order_hash');
    assert.equal(dispositionFor(o, report({ order_hash: orderHash(o) }), PHASE), 'unenforced', 'no integrity');
    assert.equal(dispositionFor(o, report({ order_hash: orderHash(o) }, {}), PHASE), 'unenforced', 'no integrity.files');
  });

  it('legacyEnforcementReportTracesAsUnenforced', () => {
    const m = setup();
    run(m, 'coverage');
    run(m, 'enforce');
    run(m, 'trace');
    assert.equal(dispositionOf(m, 'T-A'), 'proven');
    const legacy = setup();
    run(legacy, 'coverage');
    run(legacy, 'enforce');
    const rep = JSON.parse(legacy.read(ENFORCEMENT));
    delete rep.integrity;
    edit(legacy, ENFORCEMENT, JSON.stringify(rep));
    run(legacy, 'trace');
    assert.equal(dispositionOf(legacy, 'T-A'), 'unenforced');
  });

  it('unreadableRecordedHashVoidsTheProof', () => {
    const m = setup();
    run(m, 'coverage');
    run(m, 'enforce');
    const rep = JSON.parse(m.read(ENFORCEMENT));
    rep.integrity.files['tests/a.test.cjs'] = 'unreadable:too_large';
    edit(m, ENFORCEMENT, JSON.stringify(rep));
    run(m, 'trace');
    assert.notEqual(dispositionOf(m, 'T-A'), 'proven');
  });
});

describe('F3: coverage will not re-baseline changed check files', () => {
  it('editedCheckThenCoverageIsIncompleteAndKeepsTheRecord', () => {
    const m = setup();
    run(m, 'coverage');
    const before = m.read(INTEGRITY);
    edit(m, 'tests/a.test.cjs', '// weakened\n');
    const again = run(m, 'coverage');
    assert.equal(again.coverage, 'incomplete');
    assert.ok(again.reasons.some((x) => x.code === 'check_file_changed' && x.message.includes('tests/a.test.cjs')), JSON.stringify(again.reasons));
    assert.equal(m.read(INTEGRITY), before, 'the old record is kept unchanged');
    const r = run(m, 'enforce');
    assert.equal(r.enforcement, 'flagged');
    assert.equal(m.execCalls.length, 0);
  });

  it('selectResetsAndThenCoverageIsComplete', () => {
    const m = setup();
    run(m, 'coverage');
    edit(m, 'tests/a.test.cjs', '// weakened\n');
    assert.equal(run(m, 'coverage').coverage, 'incomplete');
    run(m, 'select');
    assert.equal(run(m, 'coverage').coverage, 'complete');
  });

  it('coverageWithIdenticalHashesRewritesThePlanHashes', () => {
    const m = setup();
    run(m, 'coverage');
    edit(m, PLAN, planText().replace('body', 'body, reworded'));
    assert.equal(run(m, 'coverage').coverage, 'complete');
    const rec = JSON.parse(m.read(INTEGRITY));
    const sha = crypto.createHash('sha256').update(m.read(PLAN), 'utf8').digest('hex');
    assert.equal(rec.plans['03-01-PLAN.md'], sha);
  });
});

describe('F4: a file beyond the hash bound never compares equal', () => {
  it('oversizeCheckFileIsIncompleteAtCoverage', () => {
    const m = setup({ files: { 'tests/a.test.cjs': 'x'.repeat(1024 * 1024 + 1) } });
    const r = run(m, 'coverage');
    assert.equal(r.coverage, 'incomplete');
    assert.ok(r.reasons.some((x) => x.message.includes('check_file_too_large: tests/a.test.cjs')), JSON.stringify(r.reasons));
  });

  it('enforceTreatsAnUnreadableRecordValueAsChanged', () => {
    const m = setup();
    run(m, 'coverage');
    edit(m, 'tests/a.test.cjs', 'x'.repeat(1024 * 1024 + 1));
    const rec = JSON.parse(m.read(INTEGRITY));
    rec.files['tests/a.test.cjs'] = 'unreadable:too_large';
    edit(m, INTEGRITY, JSON.stringify(rec));
    const r = run(m, 'enforce');
    assert.equal(r.enforcement, 'flagged');
    assert.equal(m.execCalls.length, 0);
  });
});

describe('F5: brace expansion is bounded before it recurses', () => {
  const coverEdits = (entry) => evaluateCoverage({
    applicableIds: ['T-A'], applicable: [T_A], ordersTotal: 1, allOrders: [T_A], ordersPath: ORDERS, root: '/proj', probe: null,
    plans: [{ ok: true, file: 'p.md', must_haves: { prohibitions: [proj] }, files_modified: [entry] }],
  }).checkFileEdits;

  it('tenThousandGroupsDoNotOverflowAndCoverEverything', () => {
    const entry = 'src/' + '{a,b}'.repeat(10000) + '.js';
    let edits;
    assert.doesNotThrow(() => { edits = coverEdits(entry); });
    assert.ok(edits.some((e) => e.file === 'tests/a.test.cjs'), 'an over-bound entry covers every protected file');
  });

  it('deepNestingDoesNotOverflow', () => {
    const entry = '{'.repeat(10000) + 'a' + '}'.repeat(10000);
    assert.doesNotThrow(() => coverEdits(entry));
  });
});

describe('F6: directory spellings and bracket classes', () => {
  const cover = (entry) => run(setup({ plan: planText([entry]) }), 'coverage');

  it('globDirectoryAndDotEntriesCoverProtectedFiles', () => {
    for (const entry of ['tests/**/', './', '.', './tests/**/', 'tests/*/']) {
      assert.equal(cover(entry).coverage, 'incomplete', entry);
    }
  });

  it('bracketClassesOverMatch', () => {
    for (const entry of ['tests/[a].test.cjs', 'tests/[!b].test.cjs', 'tests/[x-z].test.cjs', 'tests/[ab]*.cjs']) {
      assert.equal(cover(entry).coverage, 'incomplete', entry);
    }
  });

  it('unrelatedGlobsStayComplete', () => {
    for (const entry of ['src/**/', 'src/[a].js', 'docs/']) assert.equal(cover(entry).coverage, 'complete', entry);
  });
});

describe('F7: operation keys use NFKC and drop zero-width characters', () => {
  const FULL_R = String.fromCharCode(0xff52);
  const ZW = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff].map((c) => String.fromCharCode(c));
  const pair = (a, b) => {
    const d = parsed({ contexts: { 'ctx-a': { description: 'a' } }, orders: [variant('V-A', 'op.one', ['ctx-a'], 'full'), variant('V-B', 'op.two', ['ctx-a'], 'prorated')] });
    d.orders[0].operation = a;
    d.orders[1].operation = b;
    return detectConflicts(d).conflicts;
  };

  it('compatibilityAndZeroWidthSpellingsAreOneOperation', () => {
    assert.equal(pair('r.amt', `${FULL_R}.amt`).length, 1, 'fullwidth');
    for (const z of ZW) {
      assert.equal(pair('r.amt', `r${z}.amt`).length, 1, `zero width ${z.charCodeAt(0).toString(16)}`);
      assert.equal(pair('r.amt', `${z}r.amt${z}`).length, 1, 'edges');
    }
  });

  it('distinctOperationsStayDistinct', () => {
    assert.deepEqual(pair('r.amt', 'r.amts'), []);
    assert.deepEqual(pair('r.amt', 'r_amt'), []);
  });
});
