'use strict';

// Phase 7 (#15): integrity of check files and gate inputs, end to end through the router over an in-memory filesystem.
// Matrix rows 2, 4, 5, 6, 8, 9, 11-17 and 19.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');

const { routeStandingOrdersCommand } = require('../standing-orders-router.cjs');
const { TRACE_PATH, orderHash } = require('../lib/trace.cjs');
const { doc, testOrder, yamlOf, parsed } = require('./helpers/fixtures.cjs');
const { memfs } = require('./helpers/memfs.cjs');

const CONFIG = '.planning/config.json';
const ORDERS = '.planning/standing-orders/ORDERS.yaml';
const MUTANTS_JSON = '.planning/standing-orders/MUTANTS.json';
const ENFORCEMENT = '.planning/standing-orders/ENFORCEMENT.json';
const PHASE = '.planning/phases/03-billing';
const VERDICT = `${PHASE}/STANDING-ORDERS.md`;
const INTEGRITY = `${PHASE}/STANDING-ORDERS-INTEGRITY.json`;
const PLAN = `${PHASE}/03-01-PLAN.md`;
const PHASE_FLAG = ['--phase-dir', PHASE];
const HOST_CLI = '/opt/gsd/bin/gsd-tools.cjs';
const SHA_1 = 'a1'.repeat(20);
const COMMITTED = JSON.stringify({ committed: true, hash: 'abc1234', skipped: false, reason: null });
const GREEN = JSON.stringify({ status: 'green', flagged: false, tier: 'test', reason: 'ok', located: true, kind: 'node-test', evidence: [] });

const enabledConfig = () => JSON.stringify({ 'standing-orders': { enabled: true } });
const SCOPE_BILLING = { paths: ['src/billing/**'] };
const SCOPE_UI = { paths: ['src/ui/**'] };

const T_A = testOrder({ id: 'T-A', statement: 'Never A.', scope: SCOPE_BILLING, check_target: 'tests/a.test.cjs' });
// not applicable in the billing phase, but its check files are check files all the same
const T_N = testOrder({ id: 'T-N', statement: 'Never N.', scope: SCOPE_UI, check_target: 'tests/n.test.cjs', check_violation_fixture: 'tests/fixtures/n-bad.js', check_clean_fixture: 'tests/fixtures/n-good.js' });
const M1 = 'tests/fixtures/mutants/m1.js';
const T_M = testOrder({ id: 'T-M', statement: 'Never M.', scope: SCOPE_BILLING, check_target: 'tests/m.test.cjs', check_violation_fixture: 'tests/fixtures/m-bad.js', check_clean_fixture: 'tests/fixtures/m-good.js', check_mutants: [M1] });

const PROJECT_FILES = {
  'tests/a.test.cjs': '// a\n',
  'tests/fixtures/bad.js': 'bad\n',
  'tests/fixtures/good.js': 'good\n',
  'tests/n.test.cjs': '// n\n',
  'tests/fixtures/n-bad.js': 'nbad\n',
  'tests/fixtures/n-good.js': 'ngood\n',
  'tests/m.test.cjs': '// m\n',
  'tests/fixtures/m-bad.js': 'mbad\n',
  'tests/fixtures/m-good.js': 'mgood\n',
  [M1]: 'mutant one\n',
  'src/billing/refund.js': 'refund\n',
};

const testProjection = (id, target, bad = 'tests/fixtures/bad.js', good = 'tests/fixtures/good.js') => ({ statement: `${id}: rule`, status: 'resolved', verification: 'test', check_kind: 'node-test', check_target: target, check_violation_fixture: bad, check_clean_fixture: good });

function planText({ files = [], prohibitions }) {
  const data = { requirements: ['X-1'], must_haves: { truths: [], prohibitions } };
  if (files.length > 0) data.files_modified = files;
  return '---\n' + yamlOf(data) + '---\nbody\n';
}

const PLAN_A = (files = []) => planText({ files, prohibitions: [testProjection('T-A', 'tests/a.test.cjs')] });

const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** Router project over an in-memory filesystem with a fake host prover; `execCalls` records prover calls only. */
function setupI({ orders = doc({ orders: [T_A, T_N] }), plan = PLAN_A(), files = {}, links = {}, overrides = {}, project = true } = {}) {
  const execCalls = [];
  const execFile = (file, args) => {
    if (file === 'git') return SHA_1 + '\n';
    if (args.includes('prohibition-enforcement')) {
      execCalls.push({ id: JSON.parse(args[4]).prohibition.id });
      return GREEN;
    }
    return COMMITTED;
  };
  const all = { [HOST_CLI]: '// host stub\n', [CONFIG]: enabledConfig(), [`${PHASE}/03-CONTEXT.md`]: 'The change touches `src/billing/refund.js`.\n', ...(project ? PROJECT_FILES : {}), ...files };
  if (orders !== null) all[ORDERS] = orders;
  if (plan !== null) all[PLAN] = plan;
  const m = memfs({ files: all, links, overrides: { execFile, argv: ['node', HOST_CLI], ...overrides } });
  m.execCalls = execCalls;
  return m;
}

function run(m, sub, extra = PHASE_FLAG) {
  return routeStandingOrdersCommand({ args: ['standing-orders', sub, ...extra], cwd: m.cwd, raw: true, error: m.error, deps: m.deps });
}

const abs = (m, rel) => path.resolve(m.cwd, rel);
const edit = (m, rel, text) => m.deps.writeFile(abs(m, rel), text);
const remove = (m, rel) => m.deps.unlink(abs(m, rel));
const lineSet = (m, rel) => new Set(m.read(rel).split('\n'));
const editedFiles = (r) => r.checkFileEdits.map((e) => e.file).sort();

function coverWith(entries, opts = {}) {
  const m = setupI({ ...opts, plan: PLAN_A(entries) });
  return { m, r: run(m, 'coverage') };
}

describe('coverage: files_modified entries that cover a check file', () => {
  // matrix row 2
  it('coverageCatchesDirectoryEntries', () => {
    for (const entry of ['tests', 'tests/', 'tests/fixtures', 'tests/fixtures/', './tests/', 'Tests/', '.']) {
      const { r } = coverWith([entry]);
      assert.equal(r.coverage, 'incomplete', entry);
      assert.ok(r.checkFileEdits.length > 0, entry);
      assert.ok(r.reasons.some((x) => x.code === 'check_file_modified' && x.message.includes('tests/')), entry);
    }
    const { r } = coverWith(['tests']);
    assert.ok(editedFiles(r).includes('tests/a.test.cjs'), 'the reason names the protected file the directory covers');
    assert.ok(editedFiles(r).includes('tests/n.test.cjs'), 'including the files of orders that are not applicable');

    // a trailing slash alone makes a directory, even when nothing is on disk
    const bare = coverWith(['tests/'], { project: false });
    assert.equal(bare.r.coverage, 'incomplete');
    // negative space: no slash and not a directory on disk is a file path, never a prefix
    const asFile = coverWith(['tests'], { project: false });
    assert.equal(asFile.r.coverage, 'complete');
    // a directory that holds no check file
    const unrelated = coverWith(['src/billing/']);
    assert.equal(unrelated.r.coverage, 'complete');
    const srcDir = coverWith(['src']);
    assert.equal(srcDir.r.coverage, 'complete');
  });

  // matrix row 4
  it('coverageCatchesAbsoluteEntry', () => {
    const inside = coverWith(['/proj/tests/a.test.cjs']);
    assert.equal(inside.r.coverage, 'incomplete');
    assert.deepEqual(inside.r.checkFileEdits, [{ plan: '03-01-PLAN.md', file: 'tests/a.test.cjs', id: 'T-A' }]);
    assert.equal(coverWith(['/proj/tests/']).r.coverage, 'incomplete');
    assert.equal(coverWith(['/proj/tests/**']).r.coverage, 'incomplete');
    assert.equal(coverWith(['/proj/./tests/../tests/a.test.cjs']).r.coverage, 'incomplete');
    // a Windows drive path on a posix root names no file of this project
    assert.equal(coverWith(['C:\\proj\\tests\\a.test.cjs']).r.coverage, 'complete');
  });

  // matrix row 5
  it('absoluteOutsideRootIgnored', () => {
    for (const entry of ['/etc/tests/a.test.cjs', '/other/proj/tests/a.test.cjs', '/projx/tests/a.test.cjs', '/tests/a.test.cjs']) {
      const { r } = coverWith([entry]);
      assert.equal(r.coverage, 'complete', entry);
      assert.deepEqual(r.checkFileEdits, [], entry);
    }
  });

  // matrix row 6
  it('coverageCatchesSymlinkEntry', () => {
    // a file that is a link to a protected file
    const link = coverWith(['docs/alias.cjs'], { links: { 'docs/alias.cjs': '/proj/tests/a.test.cjs' } });
    assert.equal(link.r.coverage, 'incomplete');
    assert.ok(editedFiles(link.r).includes('tests/a.test.cjs'));

    // a file under a symlinked directory
    const dirLink = setupI({ plan: PLAN_A(['linked/a.test.cjs']) });
    const real = dirLink.deps.realpath;
    const known = dirLink.deps.exists;
    const isFile = dirLink.deps.isFile;
    const through = (p) => (p.startsWith('/proj/linked/') ? '/proj/tests/' + p.slice('/proj/linked/'.length) : p);
    dirLink.deps.realpath = (p) => real(through(p));
    dirLink.deps.exists = (p) => known(through(p));
    dirLink.deps.isFile = (p) => isFile(through(p));
    const r = run(dirLink, 'coverage');
    assert.equal(r.coverage, 'incomplete');
    assert.ok(editedFiles(r).includes('tests/a.test.cjs'));

    // negative space: a link to a file that is not protected
    const harmless = coverWith(['docs/alias.cjs'], { links: { 'docs/alias.cjs': '/proj/src/billing/refund.js' } });
    assert.equal(harmless.r.coverage, 'complete');
    // a dangling link does not throw
    const dangling = coverWith(['docs/dangling.cjs'], { links: { 'docs/dangling.cjs': '/proj/nowhere.cjs' } });
    assert.equal(dangling.r.ok, true);
  });

  // matrix row 8
  it('ordersFileProtected', () => {
    for (const entry of ['.planning/standing-orders/ORDERS.yaml', '.\\.planning\\standing-orders\\ORDERS.yaml', '.PLANNING/standing-orders/orders.yaml', '.planning/standing-orders/', '.planning/**', '/proj/.planning/standing-orders/ORDERS.yaml']) {
      const { r } = coverWith([entry]);
      assert.equal(r.coverage, 'incomplete', entry);
      assert.ok(editedFiles(r).includes(ORDERS), entry);
      assert.ok(r.reasons.some((x) => x.code === 'check_file_modified' && x.message.includes('ORDERS.yaml')), entry);
    }
    // a sibling is not the rules file
    assert.equal(coverWith(['.planning/standing-orders/ORDERS.yaml.bak']).r.coverage, 'complete');
  });

  // matrix row 9
  it('nonApplicableCheckFilesProtected', () => {
    for (const entry of ['tests/n.test.cjs', 'tests/fixtures/n-bad.js', 'tests/fixtures/n-good.js']) {
      const { r } = coverWith([entry]);
      assert.equal(r.coverage, 'incomplete', entry);
      assert.deepEqual(r.checkFileEdits, [{ plan: '03-01-PLAN.md', file: entry, id: 'T-N' }], entry);
    }
    // the same file with the order absent from ORDERS.yaml is not protected
    const absent = coverWith(['tests/n.test.cjs'], { orders: doc({ orders: [T_A] }) });
    assert.equal(absent.r.coverage, 'complete');
  });
});

describe('the integrity record', () => {
  // matrix row 11
  it('coverageWritesIntegrityRecord', () => {
    const m = setupI();
    const log = [];
    const realWrite = m.deps.writeFile;
    m.deps.writeFile = (p, text) => {
      log.push(path.basename(p).split('.tmp-')[0]);
      return realWrite(p, text);
    };
    const r = run(m, 'coverage');
    assert.equal(r.ok, true);
    assert.ok(m.has(INTEGRITY), 'record written next to the verdict');
    assert.ok(log.indexOf('STANDING-ORDERS-INTEGRITY.json') >= 0 && log.indexOf('STANDING-ORDERS-INTEGRITY.json') < log.indexOf('STANDING-ORDERS.md'), `record before verdict: ${log.join(',')}`);
    assert.ok(r.written.includes(INTEGRITY));

    const rec = JSON.parse(m.read(INTEGRITY));
    assert.equal(rec.schema, 1);
    assert.equal(rec.phase, PHASE);
    assert.deepEqual(rec.orders, { path: ORDERS, sha256: sha(m.read(ORDERS)) });
    assert.deepEqual(Object.keys(rec.files).sort(), ['tests/a.test.cjs', 'tests/fixtures/bad.js', 'tests/fixtures/good.js', 'tests/fixtures/n-bad.js', 'tests/fixtures/n-good.js', 'tests/n.test.cjs'].sort());
    assert.equal(rec.files['tests/a.test.cjs'], sha('// a\n'));
    assert.deepEqual(rec.plans, { '03-01-PLAN.md': sha(m.read(PLAN)) });

    // a protected file that is missing is recorded as null
    const gone = setupI({ project: false });
    run(gone, 'coverage');
    assert.equal(JSON.parse(gone.read(INTEGRITY)).files['tests/a.test.cjs'], null);

    // a mutant adds MUTANTS.json (null while it does not exist) and the mutant file
    const withMutants = setupI({ orders: doc({ orders: [T_M] }) });
    run(withMutants, 'coverage');
    const mrec = JSON.parse(withMutants.read(INTEGRITY));
    assert.equal(mrec.files[MUTANTS_JSON], null);
    assert.equal(mrec.files[M1], sha('mutant one\n'));
  });

  it('selectResetsTheIntegrityRecord', () => {
    const m = setupI();
    run(m, 'coverage');
    assert.ok(m.has(INTEGRITY));
    run(m, 'select');
    assert.equal(m.has(INTEGRITY), false, 'a stale record never survives a select');
    const enforced = run(m, 'enforce');
    assert.equal(enforced.enforcement, 'flagged');
  });

  it('disabledWritesNoRecord', () => {
    const m = setupI({ files: { [CONFIG]: JSON.stringify({ 'standing-orders': { enabled: 'true' } }) } });
    const r = run(m, 'coverage');
    assert.equal(r.disabled, true);
    assert.equal(m.has(INTEGRITY), false);
    assert.deepEqual(m.calls.writeFile, []);
  });
});

describe('enforce: the integrity record is checked before any check runs', () => {
  const afterCoverage = (mutate, opts) => {
    const m = setupI(opts);
    run(m, 'coverage');
    mutate(m);
    return { m, r: run(m, 'enforce') };
  };
  const assertFlaggedUnrun = (m, r, needle) => {
    assert.equal(r.enforcement, 'flagged');
    assert.equal(m.execCalls.length, 0, 'an edited check is never executed');
    assert.ok(r.reasons.some((x) => x.code === 'check_file_changed' && x.message.includes(needle)), JSON.stringify(r.reasons));
    assert.ok(lineSet(m, VERDICT).has('enforcement: flagged'));
    assert.ok(r.results.every((x) => x.flagged === true && x.reason.includes('check_file_changed')), JSON.stringify(r.results));
  };

  // matrix row 12
  it('enforceWithIntactIntegrity', () => {
    const m = setupI();
    run(m, 'coverage');
    const r = run(m, 'enforce');
    assert.equal(r.enforcement, 'clear');
    assert.deepEqual(m.execCalls.map((c) => c.id), ['T-A']);
    assert.ok(!r.reasons.some((x) => x.code === 'check_file_changed' || x.code === 'integrity_missing'));
  });

  it('enforceRecordsOrderHashAndIntegrity', () => {
    const m = setupI();
    run(m, 'coverage');
    run(m, 'enforce');
    const report = JSON.parse(m.read(ENFORCEMENT));
    const document = parsed({ orders: [T_A, T_N] });
    assert.equal(report.results[0].order_hash, orderHash(document.orders.find((o) => o.id === 'T-A')));
    assert.equal(report.integrity.files['tests/a.test.cjs'], sha('// a\n'));
  });

  // matrix row 13
  it('enforceFlagsChangedCheckFiles', () => {
    const edited = afterCoverage((m) => edit(m, 'tests/a.test.cjs', '// a, now always green\n'));
    assertFlaggedUnrun(edited.m, edited.r, 'tests/a.test.cjs');

    const fixture = afterCoverage((m) => remove(m, 'tests/fixtures/bad.js'));
    assertFlaggedUnrun(fixture.m, fixture.r, 'tests/fixtures/bad.js');

    // a file of an order that is not applicable still changes the verdict
    const other = afterCoverage((m) => edit(m, 'tests/n.test.cjs', '// n changed\n'));
    assertFlaggedUnrun(other.m, other.r, 'tests/n.test.cjs');

    const mutant = afterCoverage((m) => edit(m, M1, 'a mutant that no longer mutates\n'), { orders: doc({ orders: [T_M] }) });
    assertFlaggedUnrun(mutant.m, mutant.r, M1);

    // a file that appears where none was recorded (the mutant cache)
    const cache = afterCoverage((m) => edit(m, MUTANTS_JSON, '{"schema":1,"entries":{}}\n'), { orders: doc({ orders: [T_M] }) });
    assertFlaggedUnrun(cache.m, cache.r, MUTANTS_JSON);
  });

  // matrix row 14
  it('enforceFlagsDeletedOrders', () => {
    const deleted = afterCoverage((m) => remove(m, ORDERS));
    assert.equal(deleted.r.enforcement, 'flagged');
    assert.ok(deleted.r.reasons.some((x) => x.code === 'check_file_changed' && x.message.includes(ORDERS)), JSON.stringify(deleted.r.reasons));
    assert.equal(deleted.m.execCalls.length, 0);
    assert.ok(lineSet(deleted.m, VERDICT).has('enforcement: flagged'));

    const changed = afterCoverage((m) => edit(m, ORDERS, doc({ orders: [] })));
    assert.equal(changed.r.enforcement, 'flagged');
    assert.ok(changed.r.reasons.some((x) => x.code === 'check_file_changed' && x.message.includes(ORDERS)));
    assert.equal(changed.m.execCalls.length, 0);
  });

  // matrix row 15
  it('enforceFailsClosedWithoutRecord', () => {
    const cases = {
      'no record at all': () => {},
      'a symbolic link': (m) => {
        remove(m, INTEGRITY);
        m.deps.isSymlink = (p) => p === abs(m, INTEGRITY);
      },
      'invalid JSON': (m) => edit(m, INTEGRITY, '{ not json'),
      'the number 0': (m) => edit(m, INTEGRITY, '0'),
      'an array': (m) => edit(m, INTEGRITY, '[]'),
      'null': (m) => edit(m, INTEGRITY, 'null'),
      'another phase': (m) => edit(m, INTEGRITY, JSON.stringify({ ...JSON.parse(m.read(INTEGRITY)), phase: '.planning/phases/99-other' })),
      'files not an object': (m) => edit(m, INTEGRITY, JSON.stringify({ ...JSON.parse(m.read(INTEGRITY)), files: [] })),
    };
    for (const [label, mutate] of Object.entries(cases)) {
      const m = setupI();
      if (label !== 'no record at all') run(m, 'coverage');
      else assert.equal(m.has(INTEGRITY), false);
      mutate(m);
      const r = run(m, 'enforce');
      assert.equal(r.enforcement, 'flagged', label);
      assert.equal(m.execCalls.length, 0, label);
      assert.ok(r.reasons.some((x) => x.code === 'integrity_missing'), `${label}: ${JSON.stringify(r.reasons)}`);
      assert.ok(r.results.every((x) => x.flagged === true && x.reason.includes('integrity_missing')), label);
      assert.ok(lineSet(m, VERDICT).has('enforcement: flagged'), label);
    }
  });

  // matrix row 16
  it('planChangeOnlyWarns', () => {
    const { m, r } = afterCoverage((m2) => edit(m2, PLAN, m2.read(PLAN) + '\nAn executor note.\n'));
    assert.equal(r.enforcement, 'clear');
    assert.deepEqual(m.execCalls.map((c) => c.id), ['T-A']);
    assert.ok(r.warnings.some((w) => w.code === 'plan_changed' && w.message.includes('03-01-PLAN.md')), JSON.stringify(r.warnings));
    assert.ok(!r.reasons.some((x) => x.code === 'check_file_changed'));
  });

  // matrix row 17
  it('ordersAppearingIsFlagged', () => {
    const m = setupI({ orders: null, plan: null });
    const first = run(m, 'coverage');
    assert.equal(first.coverage, 'complete');
    const rec = JSON.parse(m.read(INTEGRITY));
    assert.deepEqual(rec.orders, { path: ORDERS, sha256: null });
    edit(m, ORDERS, doc({ orders: [T_A] }));
    const r = run(m, 'enforce');
    assert.equal(r.enforcement, 'flagged');
    assert.ok(r.reasons.some((x) => x.code === 'check_file_changed' && x.message.includes(ORDERS)));
    assert.equal(m.execCalls.length, 0);
  });
});

describe('trace: a check file changed since enforce', () => {
  const dispositionOf = (m, id) => m.read(TRACE_PATH).split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)).find((x) => x.order_id === id).disposition;

  // matrix row 19
  it('traceFlagsChangedCheckFile', () => {
    const control = setupI({ orders: doc({ orders: [T_A] }) });
    run(control, 'coverage');
    assert.equal(run(control, 'enforce').enforcement, 'clear');
    assert.equal(run(control, 'trace').ok, true);
    assert.equal(dispositionOf(control, 'T-A'), 'proven');

    const m = setupI({ orders: doc({ orders: [T_A] }) });
    run(m, 'coverage');
    assert.equal(run(m, 'enforce').enforcement, 'clear');
    edit(m, 'tests/fixtures/good.js', 'good, quietly weakened\n');
    assert.equal(run(m, 'trace').ok, true);
    assert.equal(dispositionOf(m, 'T-A'), 'flagged');
  });

  it('traceOfAnEditedOrderIsUnenforced', () => {
    const m = setupI({ orders: doc({ orders: [T_A] }) });
    run(m, 'coverage');
    run(m, 'enforce');
    const edited = doc({ orders: [{ ...T_A, statement: 'Never A, except on Tuesdays.' }] });
    edit(m, ORDERS, edited);
    run(m, 'trace');
    assert.equal(dispositionOf(m, 'T-A'), 'unenforced');
  });
});

describe('router unchanged where no check file is touched', () => {
  it('orderlessProjectsStayClear', () => {
    const m = setupI({ orders: null, plan: null });
    const r = run(m, 'enforce');
    assert.equal(r.enforcement, 'clear');
    assert.equal(m.has(INTEGRITY), false, 'enforce never writes the coverage record');
  });
});
