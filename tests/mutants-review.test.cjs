'use strict';

// Phase 6 (#7) review findings F1-F6 at the library level: the canonical mutant path, the cache key that covers the
// code tree, fail-closed outcomes, contained reads, and the pure ORDERS.yaml add plan. All I/O is injected.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fc = require('fast-check');

const { memfs } = require('./helpers/memfs.cjs');
const { HOST_CLI, GREEN, TREE, verdict, fakeProver } = require('./helpers/prover.cjs');
const { testOrder, SEED } = require('./helpers/fixtures.cjs');
const { parseOrders, ERROR_CODES } = require('../lib/orders.cjs');

const M = new Proxy({}, { get: (_, key) => require('../lib/mutants.cjs')[key] });

const CHECK = 'tests/a.test.cjs';
const BAD = 'tests/fixtures/bad.js';
const GOOD = 'tests/fixtures/good.js';
const M1 = 'tests/fixtures/mutants/m1.js';
const M2 = 'tests/fixtures/mutants/m2.js';
const TS = '2026-11-08T00:00:00.000Z';
const TEXT = { [CHECK]: 'check v1', [BAD]: 'bad v1', [GOOD]: 'clean v1', [M1]: 'mutant one', [M2]: 'mutant two' };
const BASE = { id: 'T-A', status: 'green', flagged: false, reason: 'ok', located: true, kind: 'node-test', evidence: [] };
const CODE_A = 'a'.repeat(40);
const CODE_B = 'b'.repeat(40);

function project({ table = {}, overrides = {}, links = {}, dirs = [], files = {} } = {}) {
  const prover = fakeProver(table);
  const m = memfs({ files: { [HOST_CLI]: '// host stub\n', ...TEXT, ...files }, links, dirs, overrides: { execFile: prover.execFile, argv: ['node', HOST_CLI], ...overrides } });
  const order = testOrder({ id: 'T-A', statement: 'Never A.', check_target: CHECK, check_violation_fixture: BAD, check_clean_fixture: GOOD, check_mutants: [M1, M2] });
  return { m, prover, order };
}
const apply = (p, extra = {}) => M.applyMutants({ order: p.order, base: BASE, root: p.m.cwd, io: p.m.deps, entries: {}, useCache: true, ts: TS, code: CODE_A, ...extra });
const outcomes = (r) => r.result.mutants.map((x) => [x.path, x.outcome, x.cached]);

describe('F1: one canonical mutant path', () => {
  it('canonicalMutantPathNormalizes', () => {
    const cases = [
      ['.//.planning/x', '.planning/x'],
      ['.///.planning/x', '.planning/x'],
      ['./a//b/./c.js', 'a/b/c.js'],
      ['a\\b\\c.js', 'a/b/c.js'],
      ['a/b/', 'a/b'],
      ['.hidden/m.js', '.hidden/m.js'],
      ['a..b/c', 'a..b/c'],
    ];
    for (const [input, expected] of cases) assert.equal(M.canonicalMutantPath(input), expected, input);
  });

  it('canonicalMutantPathRefuses', () => {
    const bad = ['', '.', './', '..', '../x', 'a/../..', 'a/../b', '/abs', '//srv/x', '\\\\srv\\x\\m.js', 'C:\\x', 'c:/x', 'C:x', './../x', 42, null, undefined];
    for (const input of bad) assert.equal(M.canonicalMutantPath(input), null, String(input));
  });

  it('reservedPathsAreRecognised', () => {
    for (const p of ['.planning', '.planning/x', '.PLANNING/x', '.planning/standing-orders/MUTANTS.json']) assert.equal(M.isReservedMutantPath(p), true, p);
    for (const p of ['.planning-notes/x', 'src/.planning/x', 'planning/x', 'a/b']) assert.equal(M.isReservedMutantPath(p), false, p);
  });

  it('noDecorationOfAReservedPathEscapesTheReservation', () => {
    const decoration = fc.constantFrom('', './', './/', './//', './//');
    const casing = fc.constantFrom('.planning', '.PLANNING', '.Planning');
    const segment = fc.stringMatching(/^[a-z0-9_.-]{1,8}$/).filter((s) => s !== '.' && s !== '..');
    const sep = fc.constantFrom('/', '//', '\\');
    fc.assert(
      fc.property(decoration, casing, sep, fc.array(segment, { minLength: 1, maxLength: 3 }), (pre, dir, s, tail) => {
        const canon = M.canonicalMutantPath(pre + dir + s + tail.join('/'));
        assert.notEqual(canon, null);
        assert.equal(M.isReservedMutantPath(canon), true);
        assert.equal(M.canonicalMutantPath(canon), canon, 'canonical form is a fixed point');
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  it('sharesTheCodeStringsAndThePath', () => {
    assert.equal(ERROR_CODES.PATH_RESERVED, M.MUTANT_CODES.PATH_RESERVED);
    assert.equal(M.MUTANT_CODES.PATH_RESERVED, 'path_reserved');
    assert.equal(M.MUTANT_CODES.MUTANT_MISSING, 'mutant_missing');
    assert.equal(M.MUTANTS_PATH, '.planning/standing-orders/MUTANTS.json');
  });
});

describe('F1: validation of check_mutants uses the canonical path', () => {
  const P0 = '$.orders[0]';
  const at = (i) => `${P0}.check_mutants[${i}]`;
  const pairs = (list) => list.map((x) => [x.code, x.path]);
  const doc = (mutants) =>
    [
      'version: "1"',
      'orders:',
      '  - id: T-1',
      '    kind: prohibition',
      '    statement: s',
      '    verification: test',
      '    check_kind: node-test',
      '    check_target: tests/x.test.cjs',
      '    check_violation_fixture: tests/fixtures/bad.js',
      '    check_clean_fixture: tests/fixtures/good.js',
      '    check_mutants:',
      ...mutants.map((m) => `      - ${JSON.stringify(m)}`),
      '',
    ].join('\n');

  it('reservedPathsAreRefused', () => {
    for (const p of ['.planning/x.js', './.planning/x.js', './/.planning/standing-orders/MUTANTS.json', './//.planning/x', '.PLANNING/x.js', '.planning']) {
      const r = parseOrders(doc(['fine.js', p]));
      assert.equal(r.ok, false, p);
      assert.deepEqual(pairs(r.errors), [['path_reserved', at(1)]], p);
    }
    assert.equal(parseOrders(doc(['.planning-notes/x.js', 'src/.planning/x.js'])).ok, true);
  });

  it('duplicatesAndCheckFilesAreFoundAfterCanonicalisation', () => {
    const dup = parseOrders(doc(['a/b.js', './/a//b.js']));
    assert.deepEqual(pairs(dup.errors), [['duplicate_mutant', at(1)]]);
    const check = parseOrders(doc(['.//tests//x.test.cjs']));
    assert.deepEqual(pairs(check.errors), [['mutant_is_check_file', at(0)]]);
  });
});

describe('F2: the cache key covers the code', () => {
  it('cacheKeyForMatchesCacheKeyWithTheCode', () => {
    const { order } = project();
    const texts = { target: 'T', clean: 'C', mutant: 'X' };
    const key = M.cacheKeyFor(order, texts, CODE_A);
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.equal(key, M.cacheKey({ check_kind: order.check_kind, check_rule: null, target: 'T', clean: 'C', mutant: 'X', code: CODE_A }));
    assert.notEqual(M.cacheKeyFor(order, texts, CODE_B), key, 'another tree is another key');
    assert.notEqual(M.cacheKeyFor(order, { ...texts, mutant: 'Y' }, CODE_A), key);
  });

  it('anotherTreeIsACacheMiss', () => {
    const p = project();
    const first = apply(p);
    assert.equal(p.prover.calls.length, 2);
    assert.equal(first.changed, true);
    p.prover.calls.length = 0;
    const same = apply(p, { entries: first.entries });
    assert.deepEqual(outcomes(same), [[M1, 'killed', true], [M2, 'killed', true]]);
    assert.equal(p.prover.calls.length, 0);
    const other = apply(p, { entries: first.entries, code: CODE_B });
    assert.deepEqual(outcomes(other), [[M1, 'killed', false], [M2, 'killed', false]]);
    assert.equal(Object.keys(other.entries).length, 4, 'both trees are remembered');
  });

  it('noCodeMeansNoCache', () => {
    for (const code of [null, undefined, '', 'not-a-tree-id']) {
      const p = project();
      const primed = apply(p).entries;
      p.prover.calls.length = 0;
      const r = apply(p, { entries: primed, code });
      assert.deepEqual(outcomes(r), [[M1, 'killed', false], [M2, 'killed', false]], String(code));
      assert.equal(r.changed, false, 'nothing is written');
      assert.deepEqual(r.entries, primed, 'the entries are as they came');
    }
  });
});

describe('F2: resolveCodeId', () => {
  const calls = (answers) => {
    const log = [];
    const io = {
      execFile: (file, args, opts) => {
        log.push({ file, args, opts });
        const a = answers[args[0]];
        const out = typeof a === 'function' ? a() : a;
        if (out instanceof Error) throw out;
        return out;
      },
    };
    return { log, io };
  };
  const resolve = (answers) => {
    const c = calls(answers);
    return { id: M.resolveCodeId({ root: '/proj', io: c.io, timeoutMs: 1234 }), log: c.log };
  };

  it('cleanTreeGivesItsId', () => {
    const { id, log } = resolve({ 'rev-parse': TREE + '\n', status: '' });
    assert.equal(id, TREE);
    assert.deepEqual(log.map((c) => [c.file, c.args]), [
      ['git', ['rev-parse', 'HEAD^{tree}']],
      ['git', ['status', '--porcelain', '--', '.', ':(exclude).planning']],
    ]);
    for (const c of log) {
      assert.equal(c.opts.cwd, '/proj');
      assert.equal(c.opts.timeout, 1234);
      assert.equal(c.opts.encoding, 'utf8');
      assert.ok(Number.isInteger(c.opts.maxBuffer) && c.opts.maxBuffer > 0);
    }
    assert.equal(resolve({ 'rev-parse': 'f'.repeat(64), status: '\n' }).id, 'f'.repeat(64), 'a sha256 object id');
  });

  it('anyProblemGivesNull', () => {
    const cases = [
      ['dirty', { 'rev-parse': TREE, status: ' M src/a.js\n' }],
      ['untracked', { 'rev-parse': TREE, status: '?? new.js\n' }],
      ['not a tree id', { 'rev-parse': 'fatal: not a git repository', status: '' }],
      ['upper case', { 'rev-parse': TREE.toUpperCase().replace(/A/g, 'A'), status: '' }],
      ['too short', { 'rev-parse': 'abc123', status: '' }],
      ['rev-parse fails', { 'rev-parse': new Error('git not found'), status: '' }],
      ['status fails', { 'rev-parse': TREE, status: new Error('timed out') }],
      ['nothing', { 'rev-parse': undefined, status: '' }],
    ];
    for (const [label, answers] of cases) assert.equal(resolve(answers).id, null, label);
    assert.equal(M.resolveCodeId({ root: '/proj', io: {}, timeoutMs: 5 }), null, 'no execFile at all');
  });
});

describe('F3: fail-closed outcomes', () => {
  it('exportsFrozenVocabularies', () => {
    assert.deepEqual({ ...M.OUTCOMES }, { KILLED: 'killed', SURVIVED: 'survived', ERROR: 'error' });
    assert.ok(Object.isFrozen(M.OUTCOMES));
    assert.ok(Object.isFrozen(M.REASONS));
    assert.equal(M.REASONS.SURVIVED, 'mutant_survived');
    assert.equal(M.REASONS.UNVERIFIED, 'mutant_unverified');
    assert.equal(M.REASONS.MISSING, 'mutant_missing');
    assert.equal(M.REASONS.UNREADABLE, 'mutant_unreadable');
  });

  it('survivedNeedsALocatedCheck', () => {
    const cases = [
      ['green and unflagged', verdict({ status: 'green', flagged: false, reason: 'ok' }), 'killed', true],
      ['located and flagged', verdict({ status: 'unverified', flagged: true, located: true, reason: 'the check passed on the mutant' }), 'survived', true],
      ['located, odd reason that starts like a host failure', verdict({ status: 'unverified', flagged: true, located: true, reason: 'host_ the mutant slipped through' }), 'survived', true],
      ['located, red', verdict({ status: 'red', flagged: true, located: true, reason: 'x' }), 'survived', true],
      ['not located, any reason', verdict({ status: 'unverified', flagged: true, located: false, reason: 'some new wording' }), 'error', false],
      ['not located, no reason', verdict({ status: 'unverified', flagged: true, located: false, reason: '' }), 'error', false],
      ['green but flagged, not located', verdict({ status: 'green', flagged: true, located: false, reason: 'x' }), 'error', false],
    ];
    for (const [label, answer, outcome, cached] of cases) {
      const p = project({ table: { [M1]: answer } });
      const r = apply(p);
      assert.equal(r.result.mutants[0].outcome, outcome, label);
      assert.equal(Object.keys(r.entries).length, cached ? 2 : 1, `${label}: only a killed or survived answer is remembered`);
    }
  });

  it('hostFailuresAreErrors', () => {
    const p = project({ table: { [M1]: new Error('spawn failed') } });
    assert.equal(apply(p).result.mutants[0].outcome, 'error');
  });
});

describe('F4: readContained', () => {
  const read = (p, rel, max = 100) => M.readContained(p.m.cwd, rel, p.m.deps, max);

  it('readsAContainedRegularFile', () => {
    const p = project();
    assert.deepEqual(read(p, M1), { text: 'mutant one' });
  });

  it('refusesEverythingElseWithoutThrowing', () => {
    const outside = path.resolve('/elsewhere/file.js');
    const cases = [
      ['missing', project(), 'tests/none.js'],
      ['directory', project({ dirs: ['tests/dir'] }), 'tests/dir'],
      ['symlink', project({ links: { 'tests/link.js': path.resolve('/proj/tests/fixtures/bad.js') } }), 'tests/link.js'],
      ['symlink outside', project({ links: { 'tests/link.js': outside }, files: { [outside]: 'x' } }), 'tests/link.js'],
      ['escaping path', project(), '../x.js'],
      ['realpath outside', project({ overrides: { realpath: (q) => (q.endsWith('m1.js') ? outside : q) } }), M1],
      ['throwing dep', project({ overrides: { readFile: () => { throw new Error('EIO'); } } }), M1],
    ];
    for (const [label, p, rel] of cases) {
      const r = read(p, rel);
      assert.equal(typeof r.error, 'string', label);
      assert.equal('text' in r, false, label);
    }
  });

  it('boundsTheSize', () => {
    const p = project();
    assert.equal(read(p, M1, 10).text, 'mutant one', 'exactly at the limit');
    assert.equal(typeof read(p, M1, 9).error, 'string', 'one byte over');
    const bad = project({ overrides: { statSize: () => undefined } });
    assert.equal(typeof read(bad, M1).error, 'string', 'no size is no read');
  });

  it('anOversizedTargetRunsTheMutantsButCachesNothing', () => {
    const p = project({ overrides: { statSize: (q) => (q.endsWith('a.test.cjs') ? 1048577 : 10) } });
    const r = apply(p);
    assert.deepEqual(outcomes(r), [[M1, 'killed', false], [M2, 'killed', false]]);
    assert.equal(r.changed, false);
    assert.deepEqual(r.entries, {});
    const atLimit = project({ overrides: { statSize: (q) => (q.endsWith('a.test.cjs') ? 1048576 : 10) } });
    assert.equal(apply(atLimit).changed, true, 'a 1 MiB target is still hashed');
  });

  it('aTargetThatIsALinkIsNeverHashed', () => {
    const p = project({ links: { [CHECK]: path.resolve('/proj/tests/fixtures/bad.js') } });
    const r = apply(p);
    assert.equal(r.changed, false);
    assert.deepEqual(r.entries, {});
  });
});

describe('F6: planMutantAdd is pure', () => {
  const ORDERS = [
    'version: "1"',
    'orders:',
    '  - id: T-A',
    '    kind: prohibition',
    '    statement: "Never A."',
    '    verification: test',
    '    check_kind: node-test',
    `    check_target: ${CHECK}`,
    `    check_violation_fixture: ${BAD}`,
    `    check_clean_fixture: ${GOOD}`,
    '  - id: B-1',
    '    kind: invariant',
    '    statement: "Be fair."',
    '    verification: backstop',
    '',
  ].join('\n');
  const plan = (text, p = M1, id = 'T-A') => M.planMutantAdd({ text, parsed: parseOrders(text), id, mutantPath: p, maxBytes: 100000 });

  it('insertsOneKeyAndKeepsEveryOtherOrder', () => {
    const r = plan(ORDERS);
    assert.equal(typeof r.plan.text, 'string', JSON.stringify(r));
    const after = parseOrders(r.plan.text);
    assert.equal(after.ok, true);
    assert.deepEqual(after.document.orders[0].check_mutants, [M1]);
    assert.deepEqual(after.document.orders[1], parseOrders(ORDERS).document.orders[1]);
    assert.equal(r.plan.text.split('\n').length, ORDERS.split('\n').length + 2);
  });

  it('refusesWhenTheLayoutCannotTakeIt', () => {
    const flow = ORDERS.replace(`    check_clean_fixture: ${GOOD}\n`, `    check_clean_fixture: ${GOOD}\n    check_mutants: [a.js]\n`);
    const r = plan(flow);
    assert.equal(r.failure.code, 'manual');
    assert.equal(r.failure.extra.paste, `check_mutants:\n  - ${M1}`);
  });

  it('refusesTooLargeAResult', () => {
    const r = M.planMutantAdd({ text: ORDERS, parsed: parseOrders(ORDERS), id: 'T-A', mutantPath: M1, maxBytes: 10 });
    assert.equal(r.failure.code, ERROR_CODES.FILE_TOO_LARGE);
  });

  it('validatesTheOrderAndThePathWithoutAnIo', () => {
    const none = M.validateMutantAdd({ parsed: parseOrders(ORDERS), id: 'NOPE', path: M1 });
    assert.equal(none.failure.code, 'order_not_found');
    assert.equal(M.validateMutantAdd({ parsed: parseOrders(ORDERS), id: 'B-1', path: M1 }).failure.code, 'order_not_test');
    assert.equal(M.validateMutantAdd({ parsed: parseOrders(ORDERS), id: 'T-A', path: '../x' }).failure.code, 'path_invalid');
    assert.equal(M.validateMutantAdd({ parsed: parseOrders(ORDERS), id: 'T-A', path: './/.planning/x' }).failure.code, 'path_reserved');
    assert.equal(M.validateMutantAdd({ parsed: parseOrders(ORDERS), id: 'T-A', path: `.//${BAD}` }).failure.code, 'mutant_is_check_file');
    const ok = M.validateMutantAdd({ parsed: parseOrders(ORDERS), id: 'T-A', path: `.//tests//fixtures/new.js` });
    assert.equal(ok.path, 'tests/fixtures/new.js');
    assert.equal(ok.order.id, 'T-A');
  });
});

void GREEN;
