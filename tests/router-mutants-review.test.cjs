'use strict';

// Phase 6 (#7) review findings through the router: F1 (reserved-path bypass), F2 (cache keyed on the HEAD tree),
// F5 (register an existing mutant without content in argv), F7 (validation errors on an unusable ORDERS.yaml).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { routeStandingOrdersCommand, exitCodeFor, GIT_TIMEOUT_MS } = require('../standing-orders-router.cjs');
const { memfs } = require('./helpers/memfs.cjs');
const { HOST_CLI, TREE, fakeProver } = require('./helpers/prover.cjs');

const CONFIG = '.planning/config.json';
const ORDERS = '.planning/standing-orders/ORDERS.yaml';
const MUTANTS = '.planning/standing-orders/MUTANTS.json';
const PHASE = '.planning/phases/03-billing';
const CHECK = 'tests/a.test.cjs';
const BAD = 'tests/fixtures/bad.js';
const GOOD = 'tests/fixtures/good.js';
const DIR = 'tests/fixtures/mutants';
const M1 = `${DIR}/m1.js`;
const M2 = `${DIR}/m2.js`;
const NEW = `${DIR}/new.js`;
const CONTENT = 'module.exports = 1;\n';
const FILES = { [CHECK]: 'check a', [BAD]: 'bad', [GOOD]: 'good', [M1]: 'mutant one', [M2]: 'mutant two' };

const testBlock = (id, mutants) => [
  `  - id: ${id}`,
  '    kind: prohibition',
  '    statement: "Never A."',
  '    verification: test',
  '    check_kind: node-test',
  `    check_target: ${CHECK}`,
  `    check_violation_fixture: ${BAD}`,
  `    check_clean_fixture: ${GOOD}`,
  '    scope:',
  '      paths: ["src/billing/**"]',
  ...(mutants.length > 0 ? ['    check_mutants:', ...mutants.map((p) => `      - ${p}`)] : []),
];
const BACKSTOP = ['  - id: B-1', '    kind: invariant', '    statement: "Be fair."', '    verification: backstop'];
const orders = (mutants) => ['version: "1"', 'orders:', ...testBlock('T-A', mutants), ...BACKSTOP, ''].join('\n');
const PLAIN = orders([]);
const HARDENED = orders([M1, M2]);

function planText() {
  const item = { statement: 'T-A: Never A.', status: 'resolved', verification: 'test', check_kind: 'node-test', check_target: CHECK, check_violation_fixture: BAD, check_clean_fixture: GOOD };
  return '---\nrequirements: [X-1]\nmust_haves:\n  prohibitions:\n    - ' + JSON.stringify(item) + '\n---\nbody\n';
}

function setup({ orders: ordersText = PLAIN, files = {}, drop = [], links = {}, table = {}, git, overrides = {}, phase = false } = {}) {
  const prover = fakeProver(table, git ? { git } : {});
  const all = { [HOST_CLI]: '// host stub\n', ...FILES, ...files, [CONFIG]: JSON.stringify({ 'standing-orders': { enabled: true } }) };
  if (ordersText !== null) all[ORDERS] = ordersText;
  if (phase) {
    all[`${PHASE}/03-CONTEXT.md`] = 'The refund change touches `src/billing/refund.js`.\n';
    all[`${PHASE}/03-01-PLAN.md`] = planText();
  }
  for (const rel of drop) delete all[rel];
  const m = memfs({ files: all, links, overrides: { execFile: prover.execFile, argv: ['node', HOST_CLI], ...overrides } });
  return { m, prover };
}
const run = (m, args) => routeStandingOrdersCommand({ args: ['standing-orders', ...args], cwd: m.cwd, raw: true, error: m.error, deps: m.deps });
const add = (m, body) => run(m, ['mutants', '--add', JSON.stringify(body)]);
const codeOf = (r) => (Array.isArray(r.errors) && r.errors.length > 0 ? r.errors[0].code : undefined);
const noWrites = (m) => {
  for (const k of ['writeFile', 'appendFile', 'rename', 'mkdir', 'unlink']) assert.deepEqual(m.calls[k], [], k);
};
const RUN = ['mutants', '--run', '--order', 'T-A'];
const fixtures = (prover) => prover.calls.map((c) => c.fixture);

describe('F1: --add canonicalises the path before every check', () => {
  it('noSpellingOfAReservedPathGetsThrough', () => {
    const spellings = [
      './/.planning/standing-orders/MUTANTS.json',
      './/.planning/evil.txt',
      './//.planning/x',
      './//.planning/x',
      './.planning/x',
      '.PLANNING/x',
      '.planning/./z',
      '.planning//z',
      '.planning\\z',
      './/.planning',
    ];
    for (const p of spellings) {
      const { m } = setup();
      const r = add(m, { order: 'T-A', path: p, content: CONTENT });
      assert.equal(r.ok, false, p);
      assert.equal(codeOf(r), 'path_reserved', `${p}: ${JSON.stringify(r.errors)}`);
      noWrites(m);
      assert.equal(m.read(ORDERS), PLAIN, p);
      assert.equal(m.has('.planning/evil.txt'), false, p);
    }
  });

  it('aDecoratedCheckFileOrDuplicateIsStillFound', () => {
    const check = setup();
    assert.equal(codeOf(add(check.m, { order: 'T-A', path: `.//${BAD}`, content: CONTENT })), 'mutant_is_check_file');
    noWrites(check.m);
    const dup = setup({ orders: HARDENED });
    assert.equal(codeOf(add(dup.m, { order: 'T-A', path: `.//${DIR}//m1.js`, content: CONTENT })), 'mutant_exists');
    noWrites(dup.m);
  });

  it('theNormalizedPathIsWrittenAndRegistered', () => {
    const { m } = setup();
    const r = add(m, { order: 'T-A', path: `.//${DIR}//new.js`, content: CONTENT });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.path, NEW);
    assert.equal(m.read(NEW), CONTENT);
    assert.deepEqual(r.written, [NEW, ORDERS]);
    assert.ok(m.read(ORDERS).includes(`- ${NEW}`), m.read(ORDERS));
    assert.equal(m.read(ORDERS).includes('//'), false, 'no decorated spelling reaches ORDERS.yaml');
  });
});

describe('F2: the cache is keyed on the HEAD tree', () => {
  const hardened = (opts = {}) => setup({ orders: HARDENED, ...opts });

  it('oneTreeLookupPerRunWithTheRoutersBounds', () => {
    const { m, prover } = hardened();
    run(m, RUN);
    assert.deepEqual(prover.gitCalls.map((c) => c.args), [['rev-parse', 'HEAD^{tree}'], ['status', '--porcelain', '--', '.', ':(exclude).planning']]);
    for (const c of prover.gitCalls) {
      assert.equal(c.opts.cwd, m.cwd);
      assert.equal(c.opts.timeout, GIT_TIMEOUT_MS);
      assert.equal(c.opts.encoding, 'utf8');
    }
  });

  it('anotherTreeIsACacheMissInRunAndEnforce', () => {
    let tree = TREE;
    const git = (args) => (args[0] === 'rev-parse' ? tree + '\n' : '');
    const { m, prover } = hardened({ git, phase: true });
    run(m, RUN);
    assert.equal(prover.calls.length, 3);
    prover.calls.length = 0;
    assert.deepEqual(run(m, RUN).mutants.map((x) => x.cached), [true, true]);
    assert.equal(prover.calls.length, 1);
    prover.calls.length = 0;
    tree = 'b'.repeat(40);
    const again = run(m, RUN);
    assert.deepEqual(again.mutants.map((x) => x.cached), [false, false], 'the code changed: nothing vouches for the old answers');
    assert.deepEqual(fixtures(prover), [BAD, M1, M2]);
    assert.equal(Object.keys(JSON.parse(m.read(MUTANTS)).entries).length, 4);
    prover.calls.length = 0;
    tree = 'c'.repeat(40);
    const enforced = run(m, ['enforce', '--phase-dir', PHASE]);
    assert.deepEqual(enforced.results[0].mutants.map((x) => x.cached), [false, false]);
    assert.deepEqual(fixtures(prover), [BAD, M1, M2]);
  });

  it('noTreeNoCacheAndNoBlock', () => {
    const cases = [
      ['git is missing', () => new Error('spawn git ENOENT')],
      ['git times out', () => Object.assign(new Error('timed out'), { code: 'ETIMEDOUT', killed: true })],
      ['git prints rubbish', (args) => (args[0] === 'rev-parse' ? 'fatal: not a git repository\n' : '')],
      ['the tree is dirty outside .planning', (args) => (args[0] === 'rev-parse' ? TREE : ' M src/a.js\n')],
    ];
    for (const [label, git] of cases) {
      const { m, prover } = hardened({ git, phase: true });
      const first = run(m, RUN);
      assert.equal(first.ok, true, label);
      assert.equal(first.verdict, 'clear', label);
      assert.deepEqual(first.mutants.map((x) => [x.outcome, x.cached]), [['killed', false], ['killed', false]], label);
      assert.deepEqual(first.written, [], `${label}: no cache is written`);
      assert.equal(m.has(MUTANTS), false, label);
      prover.calls.length = 0;
      const second = run(m, RUN);
      assert.deepEqual(fixtures(prover), [BAD, M1, M2], `${label}: every mutant runs again`);
      assert.deepEqual(second.mutants.map((x) => x.cached), [false, false], label);
      prover.calls.length = 0;
      const enforced = run(m, ['enforce', '--phase-dir', PHASE]);
      assert.equal(enforced.enforcement, 'clear', `${label}: ${JSON.stringify(enforced.reasons)}`);
      assert.deepEqual(fixtures(prover), [BAD, M1, M2], label);
      assert.equal(m.has(MUTANTS), false, label);
    }
  });

  it('aPrimedCacheIsNotReadWhenTheTreeIsUnknown', () => {
    const good = hardened();
    run(good.m, RUN);
    const cache = good.m.read(MUTANTS);
    const { m, prover } = hardened({ git: () => new Error('no git'), files: { [MUTANTS]: cache } });
    const r = run(m, RUN);
    assert.deepEqual(r.mutants.map((x) => x.cached), [false, false]);
    assert.deepEqual(fixtures(prover), [BAD, M1, M2]);
    assert.equal(m.read(MUTANTS), cache, 'and the stored cache is left alone');
  });

  it('noMutantsNoGitCall', () => {
    const { m, prover } = setup({ phase: true });
    run(m, ['enforce', '--phase-dir', PHASE]);
    assert.deepEqual(prover.gitCalls, []);
    const plain = setup();
    run(plain.m, RUN);
    assert.deepEqual(plain.prover.gitCalls, []);
  });

  it('listReportsOnlyWhatTheTreeVouchesFor', () => {
    let tree = TREE;
    const git = (args) => (args[0] === 'rev-parse' ? tree + '\n' : '');
    const { m } = hardened({ git });
    run(m, RUN);
    assert.deepEqual(run(m, ['mutants', '--order', 'T-A']).mutants.map((x) => x.cached_outcome), ['killed', 'killed']);
    tree = 'd'.repeat(40);
    assert.deepEqual(run(m, ['mutants', '--order', 'T-A']).mutants.map((x) => x.cached_outcome), [null, null]);
  });
});

describe('F5: --add can register a mutant that already exists', () => {
  it('contentGivenCreatesTheFile', () => {
    const { m } = setup();
    const r = add(m, { order: 'T-A', path: NEW, content: CONTENT });
    assert.equal(r.created, true);
    assert.deepEqual(r.written, [NEW, ORDERS]);
  });

  it('contentOmittedRegistersTheExistingFile', () => {
    const { m } = setup({ files: { [NEW]: CONTENT } });
    const r = add(m, { order: 'T-A', path: NEW });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.created, false);
    assert.deepEqual(r.written, [ORDERS]);
    assert.equal(m.read(NEW), CONTENT, 'the file is untouched');
    assert.deepEqual(m.calls.writeFile.filter((p) => p.endsWith('new.js')), []);
    assert.ok(m.read(ORDERS).includes(`- ${NEW}`));
  });

  it('aBigExistingFileNeedsNoArgv', () => {
    const big = 'x'.repeat(65536);
    const { m } = setup({ files: { [NEW]: big } });
    const arg = JSON.stringify({ order: 'T-A', path: NEW });
    assert.ok(arg.length < 200);
    assert.equal(run(m, ['mutants', '--add', arg]).ok, true);
  });

  it('aFailedOrdersWriteNeverDeletesAnExistingFile', () => {
    const { m } = setup({ files: { [NEW]: CONTENT }, overrides: { rename: () => { throw new Error('EIO'); } } });
    const r = add(m, { order: 'T-A', path: NEW });
    assert.equal(r.ok, false);
    assert.equal(codeOf(r), 'write_failed');
    assert.deepEqual(m.calls.unlink.filter((p) => p.endsWith('new.js')), []);
    assert.equal(m.read(NEW), CONTENT);
  });

  it('missingWithoutContentIsMutantMissing', () => {
    const { m } = setup();
    const r = add(m, { order: 'T-A', path: NEW });
    assert.equal(r.ok, false);
    assert.equal(codeOf(r), 'mutant_missing');
    noWrites(m);
    assert.equal(m.read(ORDERS), PLAIN);
  });

  it('existingWithContentIsStillMutantExists', () => {
    const { m } = setup({ files: { [NEW]: 'already here' } });
    assert.equal(codeOf(add(m, { order: 'T-A', path: NEW, content: CONTENT })), 'mutant_exists');
    assert.equal(m.read(NEW), 'already here');
    noWrites(m);
  });

  it('theExistingFileMustBeContained', () => {
    const outside = path.resolve('/elsewhere/m.js');
    const cases = [
      ['symbolic link', { links: { [NEW]: outside }, files: { [outside]: CONTENT } }],
      ['empty', { files: { [NEW]: '' } }],
      ['over the limit', { files: { [NEW]: 'x'.repeat(65537) } }],
    ];
    for (const [label, opts] of cases) {
      const { m } = setup(opts);
      const r = add(m, { order: 'T-A', path: NEW });
      assert.equal(r.ok, false, label);
      assert.notEqual(codeOf(r), undefined, label);
      noWrites(m);
      assert.equal(m.read(ORDERS), PLAIN, label);
    }
  });

  it('contentMustBeTextWhenGiven', () => {
    const { m } = setup({ files: { [NEW]: CONTENT } });
    assert.equal(codeOf(add(m, { order: 'T-A', path: NEW, content: 5 })), 'usage');
    assert.equal(codeOf(add(m, { order: 'T-A', path: NEW, content: null })), 'usage');
    noWrites(m);
  });
});

describe('F7: an unusable ORDERS.yaml says why', () => {
  const twelveBad = orders(Array.from({ length: 12 }, (_, i) => `../escape${i}.js`));
  const brokenAt = (id) => `$.orders[0].check_mutants[${id}]`;

  it('listRunAndAddCarryTheValidationErrors', () => {
    const attempts = [
      ['list', (m) => run(m, ['mutants', '--order', 'T-A'])],
      ['run', (m) => run(m, RUN)],
      ['add', (m) => add(m, { order: 'T-A', path: NEW, content: CONTENT })],
    ];
    for (const [label, go] of attempts) {
      const { m } = setup({ orders: orders(['fine.js', '../escape.js']) });
      const r = go(m);
      assert.equal(r.ok, false, label);
      assert.equal(codeOf(r), 'orders_unusable', label);
      assert.deepEqual(r.errors.slice(1).map((e) => [e.code, e.path]), [['path_invalid', brokenAt(1)]], label);
      assert.equal(typeof r.errors[1].message, 'string', label);
      assert.ok(m.calls.error[0].includes('path_invalid') && m.calls.error[0].includes(brokenAt(1)), `${label}: ${m.calls.error[0]}`);
      assert.equal(exitCodeFor(r), 1, label);
    }
  });

  it('atMostTenAreReported', () => {
    const { m } = setup({ orders: twelveBad });
    const r = run(m, ['mutants', '--order', 'T-A']);
    assert.equal(codeOf(r), 'orders_unusable');
    assert.equal(r.errors.length, 11, 'orders_unusable plus the first ten');
    assert.deepEqual(r.errors.slice(1).map((e) => e.path), Array.from({ length: 10 }, (_, i) => brokenAt(i)));
  });
});
