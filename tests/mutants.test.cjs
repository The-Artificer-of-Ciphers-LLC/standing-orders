'use strict';

/*
 * Phase 6 (#7), ADR-0002: mutant enforcement, the content-keyed cache, and the shape of the `mutants` command.
 * Test names follow .gsd/phase/feat-7-mutation-hardening/50-test-matrix.md (rows 15-29 live here).
 *
 * THE API THE IMPLEMENTATION MUST PROVIDE (these tests are the contract; the other phase-6 suites rely on it too).
 *
 * lib/mutants.cjs exports
 *   MUTANTS_PATH           '.planning/standing-orders/MUTANTS.json'
 *   MAX_CACHE_BYTES        positive integer: a cache file larger than this (by `io.statSize`) is treated as empty
 *   MAX_CACHE_ENTRIES      2000
 *   MAX_MUTANT_BYTES       65536 (UTF-8 bytes of the content `mutants --add` accepts)
 *   MUTANT_CODES           frozen { ORDER_NOT_FOUND:'order_not_found', ORDER_NOT_TEST:'order_not_test',
 *                          PATH_INVALID:'path_invalid', PATH_OUTSIDE_PROJECT:'path_outside_project',
 *                          PATH_RESERVED:'path_reserved', MUTANT_IS_CHECK_FILE:'mutant_is_check_file',
 *                          MUTANT_EXISTS:'mutant_exists', CONTENT_INVALID:'content_invalid', MANUAL:'manual' }
 *   cacheKey({ check_kind, check_rule, target, clean, mutant }) -> string
 *        64 lowercase hex chars: sha256 of canonicalize({ check_kind, check_rule, target: H(target), clean: H(clean),
 *        mutant: H(mutant) }) where canonicalize is lib/trace.cjs canonicalize (keys sorted, null/empty omitted) and
 *        H(text) is the lowercase hex sha256 of the UTF-8 text. `target`, `clean` and `mutant` are the FILE TEXTS
 *        (`clean` and `check_rule` may be null/absent: they are then left out of the canonical JSON).
 *   parseCache(text) -> entries
 *        entries is a plain object { [key]: { outcome: 'killed'|'survived', ts: <string> } }. The file shape is
 *        { "schema": 1, "entries": { ... } }. NEVER throws: anything unparseable, not an object, or with `entries` that
 *        is not an object gives no entries; an individual entry that is not { outcome in (killed|survived), ts: string }
 *        is dropped and its siblings are kept.
 *   serializeCache(entries) -> text
 *        JSON.stringify({ schema: 1, entries }, null, 2) + '\n'; when there are more than MAX_CACHE_ENTRIES entries only
 *        the MAX_CACHE_ENTRIES with the newest `ts` are written.
 *   readCache({ root, io }) -> entries
 *        Reads MUTANTS_PATH under `root` through the router's io deps (isSymlink, exists, isFile, realpath, statSize,
 *        readFile). A missing file, a symbolic link, a path that resolves outside `root`, a directory, a file larger
 *        than MAX_CACHE_BYTES, or any dep that throws gives no entries. NEVER throws.
 *   applyMutants({ order, base, root, io, entries, useCache, ts }) -> { result, entries, changed }
 *        order: the normalized test order (check_mutants: string[], paths as written). base: the order's
 *        runEnforcement() result. root: absolute project root. io: the router's deps (see tests/helpers/memfs.cjs).
 *        entries: the cache map from readCache (default {}). useCache: default true; false ignores stored answers but
 *        still records fresh ones. ts: ISO string stamped on a new entry.
 *        - No check_mutants (missing or []), or `base` is not { status:'green', flagged:false }: returns
 *          { result: base (the same object), entries, changed:false } and touches no dep.
 *        - Otherwise mutants run in code-unit-sorted path order, one prover call each through lib/host.cjs
 *          runEnforcement with the order's check_violation_fixture replaced by the mutant path. Outcomes:
 *            killed   host answered status 'green' AND flagged false
 *            survived host answered anything else it could parse as an answer
 *            error    no usable answer (host unavailable / timeout / non-zero exit / unreadable output: the failure
 *                     reasons runEnforcement already returns, which start with host_) or the mutant file is unusable:
 *                     reason 'mutant_missing: ...' when it does not exist, 'mutant_unreadable: ...' for anything else
 *                     (a directory, a symbolic link, a path that resolves outside root, a read error). A bad mutant
 *                     file costs no prover call and its file is never read from outside `root`.
 *        - result = { ...base, flagged, reason, mutants: [{ path, outcome, cached, reason }] }. `flagged` is true iff
 *          any outcome is not killed; `status` stays the base status. `reason` is base.reason when nothing is flagged,
 *          else the parts that apply joined with '; ' in this order: 'mutant_survived: p1, p2' then
 *          'mutant_unverified: p3, p4' (error outcomes), each path list in sorted order. A mutant's `reason` is the
 *          host's reason (or the mutant_missing / mutant_unreadable / host_* reason); `cached` is true when the answer
 *          came from the cache (its `reason` is then any string).
 *        - killed and survived are cached under cacheKey (target = text of order.check_target, clean = text of
 *          order.check_clean_fixture when set, mutant = text of the mutant, check_kind, and check_rule for a lint-rule
 *          order); error is never cached. If the target or clean fixture or mutant text cannot be read, the mutant is
 *          still run but nothing is cached for it.
 *        - `entries` in the return is a NEW object (the input is never mutated): the old entries plus fresh answers.
 *          `changed` is true iff a key was added or replaced; a cache hit changes nothing.
 *
 * standing-orders-router.cjs
 *   SUBCOMMANDS gains 'mutants' as its LAST element; capability.json lists it in the same position.
 *   `enforce` accepts a bare `--no-cache`. For each applicable test order whose base result is green and unflagged it
 *   calls applyMutants and uses `result` in place of the base result (so ENFORCEMENT.json carries `mutants` for that
 *   order and the order is flagged by the existing gate). It reads MUTANTS.json only when some applicable test order has
 *   mutants and writes it (atomically, through `put`) only when `changed`.
 *   io gains `unlink(absPath)` (default fs.unlinkSync), used to remove a mutant file written by a failed `mutants --add`.
 *   `mutants` (authoring command; always `schema:1, subcommand:'mutants'`, failures `ok:false, errors:[{code,message}],
 *   written:[]` reported once through `error`, exit 1):
 *     --order <id>                        read-only list (works while disabled):
 *                                         { ok:true, disabled:false, mode:'list', order, mutants:[{path, exists, cached_outcome}], written:[] }
 *     --add '<json>'                      one {order, path, content}; disabled -> the standard disabled result BEFORE the
 *                                         JSON is parsed; success { ok:true, disabled:false, mode:'add', order, path, written:[<path>, <ORDERS.yaml>] }
 *     --run --order <id> [--no-cache]     disabled -> the standard disabled result; success
 *                                         { ok:true, disabled:false, mode:'run', order, base:{status,flagged,reason}, mutants:[...],
 *                                           verdict:'clear'|'flagged', written:[] or [MUTANTS_PATH] }
 *                                         exitCodeFor() is 1 when verdict is 'flagged' (base not proven, or any mutant
 *                                         survived or errored), else 0.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const { memfs } = require('./helpers/memfs.cjs');
const { HOST_CLI, GREEN, FLAGGED, verdict, fakeProver } = require('./helpers/prover.cjs');
const { testOrder } = require('./helpers/fixtures.cjs');
const { canonicalize } = require('../lib/trace.cjs');
const { enforcementRequest, ENFORCE_TIMEOUT_MS } = require('../lib/host.cjs');

// The module does not exist yet: load it lazily so each test fails on its own, not the whole file at require time.
const M = new Proxy({}, { get: (_, key) => require('../lib/mutants.cjs')[key] });

const CHECK = 'tests/a.test.cjs';
const BAD = 'tests/fixtures/bad.js';
const GOOD = 'tests/fixtures/good.js';
const DIR = 'tests/fixtures/mutants';
const M1 = `${DIR}/m1.js`;
const M2 = `${DIR}/m2.js`;
const M3 = `${DIR}/m3.js`;
const TS = '2026-11-08T00:00:00.000Z';
const TS2 = '2026-11-09T00:00:00.000Z';
const TEXT = { [CHECK]: 'check v1', [BAD]: 'bad v1', [GOOD]: 'clean v1', [M1]: 'mutant one', [M2]: 'mutant two', [M3]: 'mutant three' };
const CODE = 'a'.repeat(40); // the HEAD tree id the cache key covers (review finding F2)
const BASE = { id: 'T-A', status: 'green', flagged: false, reason: 'ok', located: true, kind: 'node-test', evidence: [] };

const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const abs = (p, rel) => path.resolve(p.m.cwd, rel);

/** A project with a fake host, the check files, and the default mutants M1 and M2 on disk. */
function project({ mutants = [M1, M2], files = {}, drop = [], dirs = [], links = {}, table = {}, overrides = {}, order = {}, host = true } = {}) {
  const prover = fakeProver(table);
  const all = { ...(host ? { [HOST_CLI]: '// host stub\n' } : {}), ...TEXT, ...files };
  for (const rel of drop) delete all[rel];
  const m = memfs({
    files: all,
    dirs,
    links,
    overrides: { execFile: prover.execFile, argv: ['node', HOST_CLI], ...overrides },
  });
  const o = testOrder({ id: 'T-A', statement: 'Never A.', check_target: CHECK, check_violation_fixture: BAD, check_clean_fixture: GOOD, check_mutants: mutants, ...order });
  return { m, prover, order: o };
}

function apply(p, extra = {}) {
  return M.applyMutants({ order: p.order, base: BASE, root: p.m.cwd, io: p.m.deps, entries: {}, useCache: true, ts: TS, code: CODE, ...extra });
}

const outcomes = (r) => r.result.mutants.map((x) => [x.path, x.outcome, x.cached]);
const cacheValues = (entries) => Object.values(entries).map((e) => e.outcome).sort();

describe('mutants: contract constants and cache key', () => {
  it('exportsTheContract', () => {
    assert.equal(M.MUTANTS_PATH, '.planning/standing-orders/MUTANTS.json');
    assert.equal(M.MAX_CACHE_ENTRIES, 2000);
    assert.equal(M.MAX_MUTANT_BYTES, 65536);
    assert.ok(Number.isInteger(M.MAX_CACHE_BYTES) && M.MAX_CACHE_BYTES > 0);
    assert.deepEqual({ ...M.MUTANT_CODES }, {
      ORDER_NOT_FOUND: 'order_not_found',
      ORDER_NOT_TEST: 'order_not_test',
      PATH_INVALID: 'path_invalid',
      PATH_OUTSIDE_PROJECT: 'path_outside_project',
      PATH_RESERVED: 'path_reserved',
      MUTANT_IS_CHECK_FILE: 'mutant_is_check_file',
      MUTANT_EXISTS: 'mutant_exists',
      MUTANT_MISSING: 'mutant_missing',
      CONTENT_INVALID: 'content_invalid',
      MANUAL: 'manual',
    });
    assert.ok(Object.isFrozen(M.MUTANT_CODES));
  });

  // The key is documented in ADR-0002 section 3: recomputed here without the module under test.
  it('cacheKeyFormat', () => {
    const node = M.cacheKey({ check_kind: 'node-test', check_rule: null, target: 'T', clean: 'C', mutant: 'X' });
    assert.match(node, /^[0-9a-f]{64}$/);
    assert.equal(node, sha(canonicalize({ check_kind: 'node-test', clean: sha('C'), mutant: sha('X'), target: sha('T') })));

    const lint = M.cacheKey({ check_kind: 'lint-rule', check_rule: 'local/no-x', target: 'T', clean: null, mutant: 'X' });
    assert.equal(lint, sha(canonicalize({ check_kind: 'lint-rule', check_rule: 'local/no-x', mutant: sha('X'), target: sha('T') })));
    assert.equal(M.cacheKey({ check_kind: 'lint-rule', check_rule: 'local/no-x', target: 'T', mutant: 'X' }), lint, 'an absent clean fixture and a null one are the same key');
  });

  it('cacheKeyDependsOnEveryInput', () => {
    const base = { check_kind: 'lint-rule', check_rule: 'r1', target: 'T', clean: 'C', mutant: 'X' };
    const key = M.cacheKey(base);
    assert.equal(M.cacheKey({ ...base }), key, 'deterministic');
    const changes = { check_kind: 'node-test', check_rule: 'r2', target: 'T2', clean: 'C2', mutant: 'X2' };
    for (const [field, value] of Object.entries(changes)) {
      assert.notEqual(M.cacheKey({ ...base, [field]: value }), key, `changing ${field} changes the key`);
    }
    assert.notEqual(M.cacheKey({ ...base, clean: null }), key, 'dropping the clean fixture changes the key');
  });
});

describe('mutants: applyMutants outcomes', () => {
  // E1
  it('noMutantsNoChange', () => {
    for (const mutants of [null, []]) {
      const p = project({ mutants });
      const before = JSON.stringify(BASE);
      const r = apply(p);
      assert.deepEqual(r.result, BASE, JSON.stringify(mutants));
      assert.equal('mutants' in r.result, false, 'no `mutants` key when there is nothing to run');
      assert.equal(r.changed, false);
      assert.deepEqual(Object.keys(r.entries), []);
      assert.equal(p.prover.calls.length, 0);
      assert.deepEqual(p.m.calls.readFile, [], 'nothing is read when there is nothing to run');
      assert.equal(JSON.stringify(BASE), before, 'the base result is not mutated');
    }
  });

  // E2
  it('baseFlaggedSkipsMutants', () => {
    const bases = [
      { ...BASE, status: 'unverified', flagged: true, reason: 'test-tier prohibition has no passing wired enforcement check' },
      { ...BASE, flagged: true },
      { ...BASE, status: 'red' },
    ];
    for (const base of bases) {
      const p = project();
      const r = apply(p, { base });
      assert.deepEqual(r.result, base, JSON.stringify(base));
      assert.equal('mutants' in r.result, false);
      assert.equal(r.changed, false);
      assert.equal(p.prover.calls.length, 0, 'no mutant is run against a check that is not proven');
    }
  });

  // E3
  it('allKilled', () => {
    const p = project();
    const r = apply(p);
    assert.equal(r.result.status, 'green');
    assert.equal(r.result.flagged, false);
    assert.equal(r.result.reason, 'ok');
    assert.equal(r.result.id, 'T-A');
    assert.equal(r.result.located, true);
    assert.equal(r.result.kind, 'node-test');
    assert.deepEqual(r.result.evidence, []);
    assert.deepEqual(r.result.mutants, [
      { path: M1, outcome: 'killed', cached: false, reason: 'ok' },
      { path: M2, outcome: 'killed', cached: false, reason: 'ok' },
    ]);
    assert.deepEqual(p.prover.calls.map((c) => c.fixture), [M1, M2]);
    assert.equal(r.changed, true);
    assert.deepEqual(cacheValues(r.entries), ['killed', 'killed']);
    for (const e of Object.values(r.entries)) assert.equal(e.ts, TS);
  });

  // E4
  it('survivorFlags', () => {
    const answers = [
      ['green but flagged', verdict({ status: 'green', flagged: true, reason: 'the check did not go red' })],
      ['red, not flagged (the clean control failed)', verdict({ status: 'red', flagged: false, reason: 'red on the clean fixture' })],
      ['unverified', FLAGGED],
    ];
    for (const [label, answer] of answers) {
      const p = project({ table: { [M1]: answer } });
      const r = apply(p);
      assert.equal(r.result.flagged, true, label);
      assert.equal(r.result.reason, `mutant_survived: ${M1}`, label);
      assert.equal(r.result.status, 'green', `${label}: the base status is kept; a survivor never turns the base red or unproven`);
      assert.deepEqual(outcomes(r), [[M1, 'survived', false], [M2, 'killed', false]], label);
      const parsed = JSON.parse(answer);
      assert.equal(r.result.mutants[0].reason, typeof parsed.reason === 'string' ? parsed.reason : '', label);
      assert.deepEqual(cacheValues(r.entries), ['killed', 'survived'], `${label}: a definitive survivor is cached`);
    }
    const both = project({ table: { [M1]: FLAGGED, [M2]: FLAGGED } });
    assert.equal(apply(both).result.reason, `mutant_survived: ${M1}, ${M2}`);
    // review finding F3: an answer that does not say the check was located is no evidence of a survivor
    const unlocated = apply(project({ table: { [M1]: JSON.stringify({ status: 'green' }) } }));
    assert.equal(unlocated.result.reason, `mutant_unverified: ${M1}`);
    assert.deepEqual(outcomes(unlocated), [[M1, 'error', false], [M2, 'killed', false]]);
  });

  // E5
  it('missingMutant', () => {
    const absent = `${DIR}/absent.js`;
    const p = project({ mutants: [M1, absent] });
    const r = apply(p);
    assert.deepEqual(outcomes(r), [[absent, 'error', false], [M1, 'killed', false]]);
    const bad = r.result.mutants.find((x) => x.path === absent);
    assert.ok(bad.reason.startsWith('mutant_missing'), bad.reason);
    assert.equal(r.result.flagged, true);
    assert.equal(r.result.reason, `mutant_unverified: ${absent}`);
    assert.deepEqual(p.prover.calls.map((c) => c.fixture), [M1], 'no prover call for a file that is not there');
    assert.deepEqual(cacheValues(r.entries), ['killed'], 'an error is never cached');
  });

  // E5 hostile
  it('mutantOutsideRoot', () => {
    const evil = `${DIR}/evil.js`;
    const secret = '/elsewhere/evil.js';
    const linked = project({ mutants: [M1, evil], drop: [], links: { [evil]: secret }, files: { [secret]: 'secret' } });
    const r1 = apply(linked);
    const e1 = r1.result.mutants.find((x) => x.path === evil);
    assert.equal(e1.outcome, 'error');
    assert.ok(e1.reason.startsWith('mutant_unreadable'), e1.reason);
    assert.ok(!linked.m.calls.readFile.includes(secret) && !linked.m.calls.readFile.includes(abs(linked, evil)), 'a link out of the project is never read');
    assert.deepEqual(linked.prover.calls.map((c) => c.fixture), [M1]);

    const escaping = '../outside.js';
    const up = project({ mutants: [M1, escaping], files: { [escaping]: 'outside' } });
    const r2 = apply(up);
    const e2 = r2.result.mutants.find((x) => x.path === escaping);
    assert.equal(e2.outcome, 'error');
    assert.ok(e2.reason.startsWith('mutant_unreadable'), e2.reason);
    assert.ok(!up.m.calls.readFile.includes(path.resolve(up.m.cwd, escaping)), 'a path that climbs out of the project is never read');
    assert.deepEqual(up.prover.calls.map((c) => c.fixture), [M1]);

    const dir = project({ mutants: [M1, M3], drop: [M3], dirs: [M3] });
    const r3 = apply(dir);
    const e3 = r3.result.mutants.find((x) => x.path === M3);
    assert.equal(e3.outcome, 'error');
    assert.ok(e3.reason.startsWith('mutant_unreadable'), e3.reason);
    assert.deepEqual(dir.prover.calls.map((c) => c.fixture), [M1]);
    for (const r of [r1, r2, r3]) assert.equal(r.result.flagged, true);
  });

  // E6
  it('hostErrorNotCached', () => {
    const failures = [
      ['spawn failure', new Error('spawn failed'), 'host_failed'],
      ['unreadable output', 'not json', 'host_output_invalid'],
      ['timeout', Object.assign(new Error('slow'), { code: 'ETIMEDOUT' }), 'host_timeout'],
    ];
    for (const [label, out, prefix] of failures) {
      const p = project({ mutants: [M1], table: { [M1]: out } });
      const r = apply(p);
      assert.equal(r.result.mutants[0].outcome, 'error', label);
      assert.ok(r.result.mutants[0].reason.startsWith(prefix), `${label}: ${r.result.mutants[0].reason}`);
      assert.equal(r.result.flagged, true, label);
      assert.equal(r.result.reason, `mutant_unverified: ${M1}`, label);
      assert.deepEqual(Object.keys(r.entries), [], `${label}: an error is cached as neither killed nor survived`);
      assert.equal(r.changed, false, label);
    }
    const absent = project({ mutants: [M1], overrides: { argv: ['node', '/not/the/host.cjs'] } });
    const r = apply(absent);
    assert.equal(r.result.mutants[0].outcome, 'error');
    assert.ok(r.result.mutants[0].reason.startsWith('host_unavailable'), r.result.mutants[0].reason);
    assert.equal(absent.prover.calls.length, 0);

    // the failure is not remembered: the next run asks the host again and gets a real answer
    const table = { [M1]: new Error('flake') };
    const flaky = project({ mutants: [M1], table });
    const first = apply(flaky);
    assert.equal(flaky.prover.calls.length, 1);
    table[M1] = GREEN;
    const second = apply(flaky, { entries: first.entries });
    assert.equal(flaky.prover.calls.length, 2, 'asked again');
    assert.deepEqual(outcomes(second), [[M1, 'killed', false]]);
  });

  // E7
  it('mixedReason', () => {
    const a = `${DIR}/a.js`;
    const b = `${DIR}/b.js`;
    const c = `${DIR}/c.js`;
    const d = `${DIR}/d.js`;
    const files = { [a]: 'A', [b]: 'B', [c]: 'C', [d]: 'D' };
    const p = project({ mutants: [d, b, c, a], files, table: { [a]: FLAGGED, [b]: new Error('boom'), [c]: FLAGGED } });
    const r = apply(p);
    assert.deepEqual(outcomes(r), [[a, 'survived', false], [b, 'error', false], [c, 'survived', false], [d, 'killed', false]]);
    assert.equal(r.result.reason, `mutant_survived: ${a}, ${c}; mutant_unverified: ${b}`);
    assert.equal(r.result.flagged, true);
    assert.deepEqual(p.prover.calls.map((x) => x.fixture), [a, b, c, d], 'mutants run in sorted path order whatever the list order');

    const onlyErrors = project({ mutants: [b], files, table: { [b]: new Error('boom') } });
    assert.equal(apply(onlyErrors).result.reason, `mutant_unverified: ${b}`);
  });
});

describe('mutants: the cache', () => {
  // E8
  it('cacheHit', () => {
    const p = project({ table: { [M2]: FLAGGED } });
    const first = apply(p);
    assert.equal(p.prover.calls.length, 2);
    const snapshot = JSON.stringify(first.entries);

    const second = apply(p, { entries: first.entries });
    assert.equal(p.prover.calls.length, 2, 'no prover call for a mutant whose answer is cached');
    assert.deepEqual(outcomes(second), [[M1, 'killed', true], [M2, 'survived', true]]);
    assert.equal(second.result.flagged, true, 'a cached survivor still flags the order');
    assert.equal(second.result.reason, `mutant_survived: ${M2}`);
    assert.equal(second.changed, false);
    assert.equal(JSON.stringify(first.entries), snapshot, 'the input entries are not mutated');
    assert.deepEqual(JSON.parse(JSON.stringify(second.entries)), JSON.parse(snapshot), 'a hit leaves the entries as they were (the old ts is kept)');
  });

  // E9
  it('contentChangeInvalidatesCache', () => {
    const cases = [
      [CHECK, 2, 4],
      [GOOD, 2, 4],
      [M1, 1, 3],
    ];
    for (const [file, rerun, keys] of cases) {
      const p = project();
      const first = apply(p);
      const callsBefore = p.prover.calls.length;
      p.m.deps.writeFile(abs(p, file), `${TEXT[file]} -- edited`);
      const second = apply(p, { entries: first.entries });
      assert.equal(p.prover.calls.length - callsBefore, rerun, `editing ${file} re-runs ${rerun} mutant(s)`);
      assert.equal(Object.keys(second.entries).length, keys, `${file}: the old answers stay, the new ones are added`);
      assert.equal(second.changed, true);
      const fresh = second.result.mutants.filter((x) => !x.cached).length;
      assert.equal(fresh, rerun, file);
    }
    // editing the violation fixture is not part of the key: the mutants' answers do not depend on it
    const p = project();
    const first = apply(p);
    const callsBefore = p.prover.calls.length;
    p.m.deps.writeFile(abs(p, BAD), 'bad v2');
    const second = apply(p, { entries: first.entries });
    assert.equal(p.prover.calls.length, callsBefore);
    assert.equal(second.result.mutants.every((x) => x.cached), true);
  });

  // E10
  it('noCacheReruns', () => {
    const table = {};
    const p = project({ table });
    const warm = apply(p);
    p.prover.calls.length = 0;
    // the host now says M1 survives; the stored answer says killed
    table[M1] = FLAGGED;
    const stale = apply(p, { entries: warm.entries, ts: TS2 });
    assert.equal(p.prover.calls.length, 0, 'with the cache on, the stored answer is served');
    assert.deepEqual(outcomes(stale), [[M1, 'killed', true], [M2, 'killed', true]]);

    const rerun = apply(p, { entries: warm.entries, useCache: false, ts: TS2 });
    assert.deepEqual(p.prover.calls.map((c) => c.fixture), [M1, M2], 'every mutant runs again');
    assert.deepEqual(outcomes(rerun), [[M1, 'survived', false], [M2, 'killed', false]]);
    assert.equal(rerun.result.flagged, true);
    assert.equal(rerun.changed, true);
    assert.equal(Object.keys(rerun.entries).length, 2, 'the fresh answers replace the stored ones under the same keys');
    assert.deepEqual(cacheValues(rerun.entries), ['killed', 'survived']);
    for (const e of Object.values(rerun.entries)) assert.equal(e.ts, TS2);
  });

  // E11
  it('badCacheIsEmpty', () => {
    const texts = [
      '',
      'not json',
      '0',
      '"s"',
      '[]',
      'null',
      'true',
      '{}',
      '{"schema":1}',
      '{"schema":1,"entries":[]}',
      '{"schema":1,"entries":null}',
      '{"schema":1,"entries":"x"}',
      '{"schema":1,"entries":5}',
      '{"schema":1,"entries":true}',
    ];
    for (const text of texts) {
      const entries = M.parseCache(text);
      assert.equal(typeof entries, 'object', JSON.stringify(text));
      assert.notEqual(entries, null, JSON.stringify(text));
      assert.deepEqual(Object.keys(entries), [], JSON.stringify(text));
    }
    const mixed = JSON.stringify({
      schema: 1,
      entries: {
        good: { outcome: 'killed', ts: TS },
        alsoGood: { outcome: 'survived', ts: TS },
        bogus: { outcome: 'bogus', ts: TS },
        error: { outcome: 'error', ts: TS },
        number: 5,
        nothing: null,
        list: [],
        noTs: { outcome: 'killed' },
        noOutcome: { ts: TS },
        numericTs: { outcome: 'killed', ts: 7 },
      },
    });
    assert.deepEqual(Object.keys(M.parseCache(mixed)).sort(), ['alsoGood', 'good'], 'a malformed entry is dropped on its own, its siblings stay');
    assert.deepEqual(M.parseCache(mixed).good, { outcome: 'killed', ts: TS });

    M.parseCache('{"schema":1,"entries":{"__proto__":{"outcome":"killed","ts":"x"}}}');
    assert.equal(Object.prototype.outcome, undefined, 'parsing never pollutes Object.prototype');
    assert.equal({}.outcome, undefined);
  });

  it('readCacheDegradesToEmpty', () => {
    const key = 'f'.repeat(64);
    const good = JSON.stringify({ schema: 1, entries: { [key]: { outcome: 'killed', ts: TS } } });
    const read = (p) => M.readCache({ root: p.m.cwd, io: p.m.deps });
    const keys = (e) => Object.keys(e);

    const control = project({ files: { [M.MUTANTS_PATH]: good } });
    assert.deepEqual(keys(read(control)), [key], 'a healthy cache is read');

    assert.deepEqual(keys(read(project())), [], 'missing');
    assert.deepEqual(keys(read(project({ links: { [M.MUTANTS_PATH]: '/elsewhere/MUTANTS.json' }, files: { '/elsewhere/MUTANTS.json': good } }))), [], 'a symbolic link, even to a readable file');
    assert.deepEqual(keys(read(project({ links: { [M.MUTANTS_PATH]: path.resolve('/proj', 'other.json') }, files: { 'other.json': good } }))), [], 'a symbolic link inside the project is still a link');
    assert.deepEqual(keys(read(project({ dirs: [M.MUTANTS_PATH] }))), [], 'a directory');
    assert.deepEqual(keys(read(project({ files: { [M.MUTANTS_PATH]: good }, overrides: { realpath: (p) => (p.endsWith('MUTANTS.json') ? '/elsewhere/MUTANTS.json' : p) } }))), [], 'resolves outside the project');

    const atLimit = project({ files: { [M.MUTANTS_PATH]: good }, overrides: { statSize: () => M.MAX_CACHE_BYTES } });
    assert.deepEqual(keys(read(atLimit)), [key], 'exactly at the limit is read');
    const overLimit = project({ files: { [M.MUTANTS_PATH]: good }, overrides: { statSize: () => M.MAX_CACHE_BYTES + 1 } });
    assert.deepEqual(keys(read(overLimit)), [], 'one byte over is not');
    assert.deepEqual(overLimit.m.calls.readFile.filter((p) => p.endsWith('MUTANTS.json')), [], 'an oversized cache is not even read');

    const throwing = (name) =>
      project({
        files: { [M.MUTANTS_PATH]: good },
        overrides: {
          [name]: () => {
            throw new Error('EIO');
          },
        },
      });
    for (const dep of ['readFile', 'statSize', 'realpath', 'isSymlink', 'exists', 'isFile']) {
      assert.deepEqual(keys(read(throwing(dep))), [], `${dep} throwing`);
    }
  });

  // E12
  it('unhashableNotCached', () => {
    for (const drop of [[CHECK], [GOOD]]) {
      const p = project({ mutants: [M1], drop });
      const r = apply(p);
      assert.deepEqual(outcomes(r), [[M1, 'killed', false]], `${drop} unreadable: the mutant still runs`);
      assert.equal(p.prover.calls.length, 1);
      assert.deepEqual(Object.keys(r.entries), [], 'but nothing is cached without a key');
      assert.equal(r.changed, false);
    }
    const unreadable = project({
      mutants: [M1],
      overrides: {
        readFile: (p) => {
          if (p.endsWith(CHECK)) throw new Error('EIO');
          return 'text';
        },
      },
    });
    const r = apply(unreadable);
    assert.deepEqual(outcomes(r), [[M1, 'killed', false]]);
    assert.deepEqual(Object.keys(r.entries), []);

    // a lint-rule order with no clean fixture still has a key: the clean fixture is only part of it when set
    const lint = project({ mutants: [M1], order: { check_kind: 'lint-rule', check_rule: 'local/no-x', check_clean_fixture: null } });
    const l = apply(lint);
    assert.deepEqual(cacheValues(l.entries), ['killed']);
  });

  // E13
  it('requestShape', () => {
    const p = project({ mutants: [M2, M1] });
    apply(p);
    const base = enforcementRequest(p.order);
    assert.deepEqual(p.prover.calls.map((c) => c.fixture), [M1, M2]);
    for (const call of p.prover.calls) {
      assert.deepEqual(call.req, { ...base, check: { ...base.check, violationFixture: call.fixture } }, 'only the violation fixture differs from the base request');
      assert.equal(call.file, '/usr/bin/node');
      assert.deepEqual(call.args.slice(0, 4), [HOST_CLI, 'check', 'prohibition-enforcement', '--json']);
      assert.equal(call.args.length, 5);
      assert.equal(call.opts.cwd, p.m.cwd);
      assert.equal(call.opts.timeout, ENFORCE_TIMEOUT_MS);
      assert.ok(!call.opts.shell);
    }
    assert.equal(base.check.violationFixture, BAD, 'the base request is unchanged by the mutant calls');

    const lint = project({ mutants: [M1], order: { check_kind: 'lint-rule', check_rule: 'local/no-x', check_violation_fixture: null } });
    apply(lint);
    const lintBase = enforcementRequest(lint.order);
    assert.equal(lintBase.check.violationFixture, undefined);
    assert.deepEqual(lint.prover.calls[0].req, { ...lintBase, check: { ...lintBase.check, violationFixture: M1 } });
    assert.equal(lint.prover.calls[0].req.check.rule, 'local/no-x');
  });

  // E14
  it('cacheCapped', () => {
    const make = (n) => {
      const entries = {};
      for (let i = n - 1; i >= 0; i -= 1) {
        entries[`k${String(i).padStart(5, '0')}`] = { outcome: i % 2 === 0 ? 'killed' : 'survived', ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() };
      }
      return entries;
    };
    for (const n of [1999, 2000, 2001, 2600]) {
      const text = M.serializeCache(make(n));
      const written = JSON.parse(text);
      assert.equal(written.schema, 1);
      const keys = Object.keys(written.entries).sort();
      assert.equal(keys.length, Math.min(n, M.MAX_CACHE_ENTRIES), `${n} entries in, at most the cap out`);
      assert.equal(keys[keys.length - 1], `k${String(n - 1).padStart(5, '0')}`, `${n}: the newest entry is kept`);
      assert.equal(keys[0], `k${String(Math.max(0, n - M.MAX_CACHE_ENTRIES)).padStart(5, '0')}`, `${n}: the oldest ${Math.max(0, n - M.MAX_CACHE_ENTRIES)} are dropped`);
      assert.ok(text.endsWith('\n'));
      assert.equal(Object.keys(M.parseCache(text)).length, keys.length, 'what is written reads back');
    }
    const small = make(3);
    assert.deepEqual(JSON.parse(M.serializeCache(small)).entries, JSON.parse(JSON.stringify(small)));
  });
});
