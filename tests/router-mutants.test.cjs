'use strict';

// Phase 6 (#7), ADR-0002 section 4: the `mutants` router subcommand (list, --add, --run), driven through
// routeStandingOrdersCommand over an injected in-memory filesystem and a fake host prover.
// Test names follow .gsd/phase/feat-7-mutation-hardening/50-test-matrix.md (rows 35-52). The result shapes this suite
// pins are written at the top of tests/mutants.test.cjs.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const router = require('../standing-orders-router.cjs');
const { routeStandingOrdersCommand, exitCodeFor } = router;
const { parseOrders } = require('../lib/orders.cjs');
const { orderHash } = require('../lib/trace.cjs');
const { yamlOf } = require('./helpers/fixtures.cjs');
const { memfs } = require('./helpers/memfs.cjs');
const { HOST_CLI, FLAGGED, fakeProver } = require('./helpers/prover.cjs');

const M = new Proxy({}, { get: (_, key) => require('../lib/mutants.cjs')[key] });

const CONFIG = '.planning/config.json';
const ORDERS = '.planning/standing-orders/ORDERS.yaml';
const MUTANTS = '.planning/standing-orders/MUTANTS.json';
const ENFORCEMENT = '.planning/standing-orders/ENFORCEMENT.json';
const PHASE = '.planning/phases/03-billing';
const DISABLED = 'standing-orders is not enabled; set standing-orders.enabled to true';
const TS = '2026-11-08T00:00:00.000Z';

const CHECK = 'tests/a.test.cjs';
const BAD = 'tests/fixtures/bad.js';
const GOOD = 'tests/fixtures/good.js';
const DIR = 'tests/fixtures/mutants';
const M1 = `${DIR}/m1.js`;
const M2 = `${DIR}/m2.js`;
const M3 = `${DIR}/m3.js`;
const NEW = `${DIR}/new.js`;
const FILES = { [CHECK]: 'check a', [BAD]: 'bad', [GOOD]: 'good' };
const CONTENT = 'module.exports = function refund() { return "twice"; };\n';

const enabled = () => JSON.stringify({ 'standing-orders': { enabled: true } });
const disabled = () => JSON.stringify({ 'standing-orders': { enabled: false } });

// ORDERS.yaml written by hand, so the layout (comments, quoting, indentation) is under the test's control.
const HEAD = ['# Standing orders for billing', 'version: "1"', 'orders:'];
const testBlock = (idText, extra = [], { statement = '"Never A."   # inline note' } = {}) => [
  `  - id: ${idText}`,
  '    kind: prohibition',
  `    statement: ${statement}`,
  '    # which tests prove this',
  '    verification: test',
  '    check_kind: node-test',
  `    check_target: ${CHECK}`,
  `    check_violation_fixture: ${BAD}`,
  `    check_clean_fixture: ${GOOD}`,
  '    scope:',
  '      paths: ["src/billing/**"]',
  ...extra,
];
const BACKSTOP = ['  - id: B-1', '    kind: invariant', '    statement: "Be fair."', '    verification: backstop'];
const listBlock = (paths, { keyIndent = '    ', itemIndent = '      ' } = {}) => [`${keyIndent}check_mutants:`, ...paths.map((p) => `${itemIndent}- ${p}`)];
const join = (...blocks) => [...HEAD, ...blocks.flat(), ''].join('\n');

const PLAIN = join(testBlock('T-A'), BACKSTOP);
const HARDENED = join(testBlock('T-A', listBlock([M1, M2])), BACKSTOP);

function planText(id = 'T-A', statement = 'Never A.') {
  const item = { statement: `${id}: ${statement}`, status: 'resolved', verification: 'test', check_kind: 'node-test', check_target: CHECK, check_violation_fixture: BAD, check_clean_fixture: GOOD };
  return '---\n' + yamlOf({ requirements: ['X-1'], must_haves: { prohibitions: [item] } }) + '---\nbody\n';
}

function setup({ config = enabled(), orders = PLAIN, files = {}, drop = [], links = {}, dirs = [], overrides = {}, table = {}, phase = false } = {}) {
  const prover = fakeProver(table);
  const all = { [HOST_CLI]: '// host stub\n', ...FILES, ...files };
  if (config !== null) all[CONFIG] = config;
  if (orders !== null) all[ORDERS] = orders;
  if (phase) {
    all[`${PHASE}/03-CONTEXT.md`] = 'The refund change touches `src/billing/refund.js`.\n';
    all[`${PHASE}/03-01-PLAN.md`] = planText();
  }
  for (const rel of drop) delete all[rel];
  const m = memfs({ files: all, dirs, links, overrides: { execFile: prover.execFile, argv: ['node', HOST_CLI], ...overrides } });
  return { m, prover };
}

function run(m, args, { raw = true } = {}) {
  const result = routeStandingOrdersCommand({ args: ['standing-orders', ...args], cwd: m.cwd, raw, error: m.error, deps: m.deps });
  assert.equal(typeof result.then, 'undefined', 'the router never returns a Promise');
  return result;
}
const add = (m, body, extra = []) => run(m, ['mutants', '--add', typeof body === 'string' ? body : JSON.stringify(body), ...extra]);
const addMutant = (m, p, content = CONTENT, order = 'T-A') => add(m, { order, path: p, content });

const abs = (m, rel) => path.resolve(m.cwd, rel);
const esc = (s) => s.replace(/[.*+?^$()|[\]\\/{}]/g, '\\$&');
const lastJson = (m) => JSON.parse(m.calls.log[m.calls.log.length - 1]);
const codeOf = (r) => (Array.isArray(r.errors) && r.errors.length > 0 ? r.errors[0].code : undefined);
const noWrites = (m) => {
  assert.deepEqual(m.calls.writeFile, []);
  assert.deepEqual(m.calls.appendFile, []);
  assert.deepEqual(m.calls.rename, []);
  assert.deepEqual(m.calls.mkdir, []);
  assert.deepEqual(m.calls.unlink, []);
};
function assertRefused(m, r, code, label, ordersBefore) {
  assert.equal(r.ok, false, `${label}: ${JSON.stringify(r)}`);
  assert.equal(r.subcommand, 'mutants', label);
  assert.equal(codeOf(r), code, `${label}: ${JSON.stringify(r.errors)}`);
  assert.deepEqual(r.written, [], label);
  assert.equal(m.calls.error.length, 1, `${label}: the message is reported once`);
  noWrites(m);
  assert.equal(m.read(ORDERS), ordersBefore, `${label}: ORDERS.yaml is byte-identical`);
  assert.equal(exitCodeFor(r), 1, label);
}

function hashesOf(text) {
  const parsed = parseOrders(text);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
  return Object.fromEntries(parsed.document.orders.map((o) => [o.id, o]));
}
/** Every order except `id` hashes as before, and `id` differs from before only by its check_mutants. */
function assertOnlyMutantsChanged(before, after, id, expected) {
  const b = hashesOf(before);
  const a = hashesOf(after);
  assert.deepEqual(Object.keys(a), Object.keys(b), 'the same orders in the same order');
  for (const key of Object.keys(b)) {
    if (key === id) continue;
    assert.equal(orderHash(a[key]), orderHash(b[key]), `order ${key} is unchanged`);
  }
  assert.deepEqual(a[id].check_mutants, expected, `${id}'s mutants`);
  assert.equal(orderHash({ ...a[id], check_mutants: b[id].check_mutants }), orderHash(b[id]), `${id} differs only by its mutants`);
}
/** `after` is `before` plus exactly `k` new lines in one place: returns where and what. */
function insertion(before, after, k) {
  const b = before.split('\n');
  const a = after.split('\n');
  assert.equal(a.length, b.length + k, `exactly ${k} line(s) were added`);
  let p = 0;
  while (p < b.length && a[p] === b[p]) p += 1;
  assert.deepEqual([...a.slice(0, p), ...a.slice(p + k)], b, 'every original line is untouched');
  return { at: p, added: a.slice(p, p + k), prev: b[p - 1], next: b[p] };
}

describe('router mutants: list', () => {
  // row 35
  it('listMutants', () => {
    const key = (mutant) => M.cacheKey({ check_kind: 'node-test', check_rule: null, target: 'check a', clean: 'good', mutant });
    const cache = M.serializeCache({ [key('mutant one')]: { outcome: 'killed', ts: TS }, [key('an older mutant two')]: { outcome: 'survived', ts: TS } });
    for (const config of [enabled(), disabled(), null]) {
      const { m, prover } = setup({ config, orders: HARDENED, files: { [M1]: 'mutant one', [M2]: 'mutant two', [MUTANTS]: cache } });
      const r = run(m, ['mutants', '--order', 'T-A']);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.schema, 1);
      assert.equal(r.subcommand, 'mutants');
      assert.equal(r.disabled, false, 'a read-only list works whether or not the capability is enabled');
      assert.equal(r.mode, 'list');
      assert.equal(r.order, 'T-A');
      assert.deepEqual(r.mutants, [
        { path: M1, exists: true, cached_outcome: 'killed' },
        { path: M2, exists: true, cached_outcome: null },
      ], 'the cache answer belongs to the current content; a stale entry is not shown');
      assert.deepEqual(r.written, []);
      noWrites(m);
      assert.equal(prover.calls.length, 0, 'listing never calls the host');
      assert.deepEqual(lastJson(m), r, '--raw prints the result as JSON');
      assert.equal(exitCodeFor(r), 0);
      assert.deepEqual(m.calls.error, []);
    }
  });

  it('listShowsAMissingFileAndAnEmptyList', () => {
    const { m } = setup({ orders: join(testBlock('T-A', listBlock([M1, M3])), BACKSTOP), files: { [M1]: 'mutant one' } });
    const r = run(m, ['mutants', '--order', 'T-A']);
    assert.deepEqual(r.mutants, [
      { path: M1, exists: true, cached_outcome: null },
      { path: M3, exists: false, cached_outcome: null },
    ]);
    const none = run(setup().m, ['mutants', '--order', 'T-A']);
    assert.equal(none.ok, true);
    assert.deepEqual(none.mutants, []);
  });

  it('listHumanOutput', () => {
    const key = M.cacheKey({ check_kind: 'node-test', check_rule: null, target: 'check a', clean: 'good', mutant: 'mutant one' });
    const { m } = setup({ orders: HARDENED, files: { [M1]: 'mutant one', [MUTANTS]: M.serializeCache({ [key]: { outcome: 'killed', ts: TS } }) } });
    run(m, ['mutants', '--order', 'T-A'], { raw: false });
    assert.ok(m.calls.log[0].includes('standing-orders mutants') && m.calls.log[0].includes('T-A'), m.calls.log[0]);
    assert.ok(m.calls.log.some((l) => l.includes(M1) && l.includes('killed')), m.calls.log.join('\n'));
    assert.ok(m.calls.log.some((l) => l.includes(M2)), 'a mutant whose file is missing is listed too');
  });

  // row 36
  it('listErrors', () => {
    const cases = [
      ['unknown id', { orders: PLAIN }, 'NOPE', 'order_not_found'],
      ['ids are exact', { orders: PLAIN }, 't-a', 'order_not_found'],
      ['a prefix is not an id', { orders: PLAIN }, 'T-', 'order_not_found'],
      ['backstop', { orders: PLAIN }, 'B-1', 'order_not_test'],
      ['invalid yaml', { orders: 'version: "1"\norders: not-a-list\n' }, 'T-A', 'orders_unusable'],
      ['yaml with an invalid mutant', { orders: join(testBlock('T-A', listBlock(['../escape.js'])), BACKSTOP) }, 'T-A', 'orders_unusable'],
      ['missing file', { orders: null }, 'T-A', 'orders_unusable'],
      ['unreadable file', { links: { [ORDERS]: '/etc/outside' } }, 'T-A', 'orders_unusable'],
    ];
    for (const [label, opts, id, code] of cases) {
      const { m } = setup(opts);
      const r = run(m, ['mutants', '--order', id]);
      assert.equal(r.ok, false, label);
      assert.equal(r.subcommand, 'mutants', label);
      assert.equal(codeOf(r), code, `${label}: ${JSON.stringify(r.errors)}`);
      assert.equal(m.calls.error.length, 1, label);
      assert.deepEqual(r.written, [], label);
      noWrites(m);
      assert.equal(exitCodeFor(r), 1, label);
    }
    // the same refusals while disabled: a read-only command does not hide them
    const off = setup({ config: disabled() });
    assert.equal(codeOf(run(off.m, ['mutants', '--order', 'NOPE'])), 'order_not_found');
  });
});

describe('router mutants: --add refusals', () => {
  const NEW_JSON = JSON.stringify({ order: 'T-A', path: NEW, content: CONTENT });

  // row 37
  it('addRefusedWhenDisabled', () => {
    for (const config of [null, disabled(), JSON.stringify({})]) {
      for (const body of ['not json', '[{}]', '5', NEW_JSON]) {
        const { m } = setup({ config });
        const r = run(m, ['mutants', '--add', body]);
        assert.equal(r.ok, true, body);
        assert.equal(r.disabled, true, body);
        assert.equal(r.subcommand, 'mutants');
        assert.equal(r.message, DISABLED);
        assert.deepEqual(r.written, []);
        noWrites(m);
        assert.equal(m.read(ORDERS), PLAIN, 'ORDERS.yaml untouched');
        assert.equal(m.has(NEW), false);
        assert.deepEqual(lastJson(m), r);
        assert.equal(exitCodeFor(r), 0);
      }
    }
    // the shape of the command line is still checked first, as for promote
    const m = setup({ config: disabled() }).m;
    assert.equal(codeOf(run(m, ['mutants', '--add'])), 'usage');
  });

  // row 38
  it('addRefusesBatch', () => {
    const one = { order: 'T-A', path: NEW, content: CONTENT };
    const cases = [
      ['a list of one', `[${JSON.stringify(one)}]`],
      ['a list of two', JSON.stringify([one, { ...one, path: `${DIR}/other.js` }])],
      ['an empty list', '[]'],
    ];
    for (const [label, body] of cases) {
      const { m } = setup();
      assertRefused(m, add(m, body), 'batch_refused', label, PLAIN);
      assert.equal(m.has(NEW), false, label);
    }
    const twice = setup();
    assertRefused(twice.m, run(twice.m, ['mutants', '--add', JSON.stringify(one), '--add', JSON.stringify(one)]), 'batch_refused', 'two --add flags', PLAIN);
  });

  // row 39
  it('addUsage', () => {
    const ok = { order: 'T-A', path: NEW, content: CONTENT };
    const without = (key) => {
      const o = { ...ok };
      delete o[key];
      return JSON.stringify(o);
    };
    const bodies = [
      'not json',
      '"a string"',
      '5',
      'null',
      'true',
      '{}',
      without('order'),
      without('path'),
      without('content'),
      JSON.stringify({ ...ok, order: 5 }),
      JSON.stringify({ ...ok, order: null }),
      JSON.stringify({ ...ok, path: 5 }),
      JSON.stringify({ ...ok, path: null }),
      JSON.stringify({ ...ok, content: 5 }),
      JSON.stringify({ ...ok, content: null }),
      JSON.stringify({ ...ok, content: ['x'] }),
    ];
    for (const body of bodies) {
      const { m } = setup();
      assertRefused(m, add(m, body), 'usage', body, PLAIN);
    }
    for (const args of [['mutants', '--add'], ['mutants', '--add', '--raw']]) {
      const { m } = setup();
      assertRefused(m, run(m, args), 'usage', args.join(' '), PLAIN);
    }
  });

  it('addRefusesOrders', () => {
    const none = setup();
    assertRefused(none.m, addMutant(none.m, NEW, CONTENT, 'NOPE'), 'order_not_found', 'unknown order', PLAIN);
    const backstop = setup();
    assertRefused(backstop.m, addMutant(backstop.m, NEW, CONTENT, 'B-1'), 'order_not_test', 'backstop order', PLAIN);
    const broken = setup({ orders: 'version: "1"\norders: not-a-list\n' });
    assertRefused(broken.m, addMutant(broken.m, NEW), 'orders_unusable', 'broken file', 'version: "1"\norders: not-a-list\n');
    const missing = setup({ orders: null });
    const r = addMutant(missing.m, NEW);
    assert.equal(r.ok, false);
    assert.equal(missing.m.has(NEW), false);
    noWrites(missing.m);
  });

  // row 40
  it('addRefusesPaths', () => {
    const checkFiles = [CHECK, BAD, GOOD];
    const cases = [
      ['absolute', '/abs/m.js', 'path_invalid', {}],
      ['parent segment', '../m.js', 'path_invalid', {}],
      ['parent segment in the middle', 'a/../../m.js', 'path_invalid', {}],
      ['parent segment with backslashes', 'a\\..\\m.js', 'path_invalid', {}],
      ['drive letter', 'C:\\x\\m.js', 'path_invalid', {}],
      ['network path', '\\\\srv\\x\\m.js', 'path_invalid', {}],
      ['under .planning', '.planning/x.js', 'path_reserved', {}],
      ['nested under .planning', '.planning/standing-orders/m.js', 'path_reserved', {}],
      ['under .planning spelled with ./', './.planning/x.js', 'path_reserved', {}],
      ['the cache itself', '.planning/standing-orders/MUTANTS.json', 'path_reserved', {}],
      ['the check target', CHECK, 'mutant_is_check_file', { drop: checkFiles }],
      ['the violation fixture', BAD, 'mutant_is_check_file', { drop: checkFiles }],
      ['the clean fixture', GOOD, 'mutant_is_check_file', { drop: checkFiles }],
      ['an existing file', M1, 'mutant_exists', { files: { [M1]: 'already here' } }],
      ['a file under a link out of the project', `${DIR}/linked/m.js`, 'path_outside_project', { links: { [`${DIR}/linked`]: '/elsewhere' } }],
    ];
    for (const [label, p, code, opts] of cases) {
      const { m } = setup(opts);
      const r = addMutant(m, p);
      assertRefused(m, r, code, label, PLAIN);
      assert.equal(m.has(p), Boolean(opts.files && opts.files[p] !== undefined), `${label}: nothing was created${opts.files ? ' or overwritten' : ''}`);
      if (opts.files) assert.equal(m.read(p), 'already here', `${label}: the existing file is not overwritten`);
    }
  });

  // row 41
  it('addDuplicate', () => {
    for (const present of [false, true]) {
      const { m } = setup({ orders: HARDENED, files: present ? { [M1]: 'mutant one' } : {} });
      const r = addMutant(m, M1);
      assert.equal(r.ok, false, `file present: ${present}`);
      assert.ok(['mutant_exists', 'duplicate_mutant'].includes(codeOf(r)), JSON.stringify(r.errors));
      assert.deepEqual(r.written, []);
      noWrites(m);
      assert.equal(m.read(ORDERS), HARDENED);
      assert.equal(m.has(M1), present);
      assert.equal(m.calls.error.length, 1);
    }
  });

  // row 42
  it('contentBounds', () => {
    const bytes = (s) => Buffer.byteLength(s, 'utf8');
    const accepted = [
      ['one byte', 'x'],
      ['exactly the limit', 'x'.repeat(65536)],
      ['two-byte characters at the limit', String.fromCharCode(0xe9).repeat(32768)],
      ['three-byte characters at the limit', String.fromCharCode(0x20ac).repeat(21845) + 'a'],
      ['four-byte characters at the limit', String.fromCodePoint(0x1f600).repeat(16384)],
    ];
    const refused = [
      ['empty', ''],
      ['one byte over', 'x'.repeat(65537)],
      ['two-byte characters, fewer than 65536 of them but over in bytes', String.fromCharCode(0xe9).repeat(32768) + 'a'],
      ['three-byte characters over', String.fromCharCode(0x20ac).repeat(21846)],
      ['four-byte characters over', String.fromCodePoint(0x1f600).repeat(16385)],
    ];
    for (const [label, content] of accepted) {
      assert.ok(bytes(content) <= 65536, label);
      const { m } = setup();
      const r = addMutant(m, NEW, content);
      assert.equal(r.ok, true, `${label}: ${JSON.stringify(r.errors)}`);
      assert.equal(m.read(NEW), content, label);
    }
    for (const [label, content] of refused) {
      const { m } = setup();
      assertRefused(m, addMutant(m, NEW, content), 'content_invalid', label, PLAIN);
      assert.equal(m.has(NEW), false, label);
    }
  });
});

describe('router mutants: --add writes', () => {
  // row 43
  it('addInsertsKey', () => {
    const middle = join(['# a header comment'], testBlock('T-A'), testBlock('T-B'), BACKSTOP);
    const last = join(BACKSTOP, testBlock('T-A'));
    const cases = [
      ['first of three', middle, 'T-A', (lines) => lines.indexOf('  - id: T-B')],
      ['middle of three', middle, 'T-B', (lines) => lines.indexOf('  - id: B-1')],
      ['last in the file', last, 'T-A', (lines) => lines.length - 1],
    ];
    for (const [label, text, id, nextAt] of cases) {
      const { m } = setup({ orders: text });
      const events = [];
      const realWrite = m.deps.writeFile;
      const realRename = m.deps.rename;
      m.deps.writeFile = (p, t) => {
        events.push(p);
        return realWrite(p, t);
      };
      m.deps.rename = (from, to) => {
        events.push(to);
        return realRename(from, to);
      };
      const r = addMutant(m, NEW, CONTENT, id);
      assert.equal(r.ok, true, `${label}: ${JSON.stringify(r)}`);
      assert.equal(r.schema, 1);
      assert.equal(r.subcommand, 'mutants');
      assert.equal(r.disabled, false);
      assert.equal(r.mode, 'add');
      assert.equal(r.order, id);
      assert.equal(r.path, NEW);
      assert.deepEqual(r.written, [NEW, ORDERS], `${label}: the mutant file first, then ORDERS.yaml`);
      assert.equal(m.read(NEW), CONTENT, label);
      assert.ok(m.calls.mkdir.includes(path.dirname(abs(m, NEW))), `${label}: the parent directory is created`);
      assert.ok(m.calls.rename.some(([, to]) => to === abs(m, ORDERS)), `${label}: ORDERS.yaml is replaced atomically`);
      assert.ok(!m.calls.writeFile.includes(abs(m, ORDERS)), `${label}: never written in place`);
      const first = (needle) => events.findIndex((p) => p.startsWith(abs(m, needle)));
      assert.ok(first(NEW) !== -1 && first(ORDERS) !== -1 && first(NEW) < first(ORDERS), `${label}: the mutant is written before ORDERS.yaml`);
      assert.deepEqual(lastJson(m), r);
      assert.equal(exitCodeFor(r), 0);
      assert.deepEqual(m.calls.error, []);

      const after = m.read(ORDERS);
      const ins = insertion(text, after, 2);
      assert.match(ins.added[0], /^ {4}check_mutants:\r?$/, `${label}: the key sits with the order's other keys`);
      assert.match(ins.added[1], new RegExp(`^ {6}- "?${esc(NEW)}"?\\r?$`), `${label}: one item, indented under the key`);
      const lines = text.split('\n');
      const blockStart = lines.indexOf(`  - id: ${id}`);
      assert.ok(ins.at > blockStart, `${label}: inside the target order`);
      assert.equal(ins.at, nextAt(lines), `${label}: right after the order's last key, before whatever follows`);
      assertOnlyMutantsChanged(text, after, id, [NEW]);
      assert.equal(run(m, ['validate']).ok, true, `${label}: the file validates afterwards`);
    }
  });

  // row 44
  it('addAppends', () => {
    const layouts = [
      ['block list, then another key', { keyIndent: '    ', itemIndent: '      ' }, ['    source: "contract §4"']],
      ['block list at the end of the order', { keyIndent: '    ', itemIndent: '      ' }, []],
      ['items level with the key', { keyIndent: '    ', itemIndent: '    ' }, ['    source: "contract §4"']],
      ['items indented four', { keyIndent: '    ', itemIndent: '        ' }, []],
    ];
    for (const [label, indents, after] of layouts) {
      const text = join(testBlock('T-A', [...listBlock([M1, M2], indents), ...after]), BACKSTOP);
      const { m } = setup({ orders: text });
      const r = addMutant(m, M3);
      assert.equal(r.ok, true, `${label}: ${JSON.stringify(r)}`);
      assert.equal(m.read(M3), CONTENT);
      const ins = insertion(text, m.read(ORDERS), 1);
      assert.match(ins.added[0], new RegExp(`^${indents.itemIndent}- "?${esc(M3)}"?\\r?$`), `${label}: same indentation as the existing items`);
      assert.equal(ins.prev, `${indents.itemIndent}- ${M2}`, `${label}: right after the last item`);
      assert.equal(m.read(ORDERS).split('check_mutants:').length, 2, `${label}: no second key`);
      assertOnlyMutantsChanged(text, m.read(ORDERS), 'T-A', [M1, M2, M3]);
    }
  });

  // row 45
  it('flowListManual', () => {
    const text = join(testBlock('T-A', [`    check_mutants: [${M1}]`]), BACKSTOP);
    const { m } = setup({ orders: text });
    const r = addMutant(m, M2);
    assert.equal(r.ok, false);
    assert.equal(codeOf(r), 'manual');
    assert.deepEqual(r.written, []);
    noWrites(m);
    assert.equal(m.has(M2), false, 'nothing is written, not even the mutant file');
    assert.equal(m.read(ORDERS), text);
    assert.equal(typeof r.paste, 'string');
    assert.ok(r.paste.includes(M2), 'the YAML to paste names the path');
    assert.ok(r.paste.includes('check_mutants'), r.paste);
    assert.equal(r.content, CONTENT, 'and the content to save is handed back');
    assert.equal(m.calls.error.length, 1);
    assert.equal(exitCodeFor(r), 1);
  });

  // row 46
  it('addTargetsExactOrder', () => {
    const noisy = testBlock('REFUND-1', ['    # check_mutants: [pending]'], { statement: '"Rule about check_mutants: handling"' });
    const text = join(noisy, testBlock('REFUND-10', listBlock([M1])), testBlock('"REFUND-2"'), testBlock("'REFUND-3'"));
    for (const id of ['REFUND-1', 'REFUND-10', 'REFUND-2', 'REFUND-3']) {
      const { m } = setup({ orders: text });
      const r = addMutant(m, NEW, CONTENT, id);
      assert.equal(r.ok, true, `${id}: ${JSON.stringify(r)}`);
      const after = m.read(ORDERS);
      const expected = id === 'REFUND-10' ? [M1, NEW] : [NEW];
      assertOnlyMutantsChanged(text, after, id, expected);
      const b = hashesOf(text);
      const a = hashesOf(after);
      for (const other of Object.keys(b).filter((k) => k !== id)) assert.deepEqual(a[other].check_mutants, b[other].check_mutants, `${id}: ${other}'s mutants are as they were`);
      assert.ok(after.includes('    # check_mutants: [pending]'), `${id}: the comment survives`);
      assert.ok(after.includes('"Rule about check_mutants: handling"'));
    }
  });

  // row 47
  it('addPreservesCrlf', () => {
    const text = PLAIN.replace(/\n/g, '\r\n');
    const { m } = setup({ orders: text });
    const r = addMutant(m, NEW);
    assert.equal(r.ok, true, JSON.stringify(r));
    const after = m.read(ORDERS);
    assert.ok(!/(^|[^\r])\n/.test(after), 'every line ending is still CRLF');
    const ins = insertion(text, after, 2);
    assert.match(ins.added[0], /^ {4}check_mutants:\r$/);
    assertOnlyMutantsChanged(text, after, 'T-A', [NEW]);
    assert.equal(m.read(NEW), CONTENT, 'the mutant file is written as given, not converted');

    // a file with no final newline stays valid
    const bare = PLAIN.slice(0, -1);
    const other = setup({ orders: bare });
    assert.equal(addMutant(other.m, NEW).ok, true);
    assertOnlyMutantsChanged(bare, other.m.read(ORDERS), 'T-A', [NEW]);
  });

  // row 48
  it('addQuotesPath', () => {
    const awkward = [
      'tests/m: one.js',
      'tests/m #1.js',
      'tests/my mutant.js',
      '&anchor.js',
      '*alias.js',
      '!tag.js',
      '@at.js',
      '%percent.js',
      '`tick.js',
      "'single'.js",
      '"double".js',
      '{brace}.js',
      '[bracket].js',
      '>fold.js',
      '|literal.js',
      '?question.js',
      '-dash.js',
      '- item.js',
      '#hash.js',
      ':colon.js',
      'a,b.js',
      'null',
      'true',
      '~',
      '123',
      'tests/' + String.fromCharCode(0xfc, 0xef) + '/' + String.fromCharCode(0x65e5, 0x672c) + '.js',
      'tests/' + String.fromCodePoint(0x1f600) + '.js',
    ];
    for (const p of awkward) {
      const { m } = setup();
      const r = addMutant(m, p);
      assert.equal(r.ok, true, `${JSON.stringify(p)}: ${JSON.stringify(r)}`);
      assert.equal(m.read(p), CONTENT, JSON.stringify(p));
      assertOnlyMutantsChanged(PLAIN, m.read(ORDERS), 'T-A', [p]);
    }
  });

  // row 49
  it('addRollsBack', () => {
    // the second write fails: the first must be undone
    for (const dep of ['writeFile', 'rename']) {
      const { m } = setup();
      const real = m.deps[dep];
      m.deps[dep] = (...args) => {
        const target = String(dep === 'rename' ? args[1] : args[0]);
        if (target.startsWith(abs(m, ORDERS))) throw new Error('disk full');
        return real(...args);
      };
      const r = addMutant(m, NEW);
      assert.equal(r.ok, false, dep);
      assert.equal(codeOf(r), 'write_failed', dep);
      assert.deepEqual(r.written, [], `${dep}: nothing persisted is reported`);
      assert.equal(m.has(NEW), false, `${dep}: the mutant file just created is removed`);
      assert.ok(m.calls.unlink.includes(abs(m, NEW)), dep);
      assert.equal(m.read(ORDERS), PLAIN, dep);
      assert.equal(m.calls.error.length, 1, dep);
      assert.equal(exitCodeFor(r), 1);
    }
    // cleanup that itself fails still reports the original failure
    const stuck = setup({
      overrides: {
        unlink: () => {
          throw new Error('EBUSY');
        },
      },
    });
    const realWrite = stuck.m.deps.writeFile;
    stuck.m.deps.writeFile = (p, t) => {
      if (p.startsWith(abs(stuck.m, ORDERS))) throw new Error('disk full');
      return realWrite(p, t);
    };
    const r = addMutant(stuck.m, NEW);
    assert.equal(r.ok, false);
    assert.equal(codeOf(r), 'write_failed');
    assert.equal(stuck.m.read(ORDERS), PLAIN);

    // the first write fails: ORDERS.yaml is never touched
    const first = setup();
    const firstWrite = first.m.deps.writeFile;
    first.m.deps.writeFile = (p, t) => {
      if (p.startsWith(abs(first.m, NEW))) throw new Error('disk full');
      return firstWrite(p, t);
    };
    const f = addMutant(first.m, NEW);
    assert.equal(codeOf(f), 'write_failed');
    assert.equal(first.m.has(NEW), false);
    assert.equal(first.m.read(ORDERS), PLAIN);
    assert.deepEqual(f.written, []);

    const noDir = setup({
      overrides: {
        mkdir: () => {
          throw new Error('EACCES');
        },
      },
    });
    const d = addMutant(noDir.m, NEW);
    assert.equal(codeOf(d), 'write_failed');
    assert.equal(noDir.m.has(NEW), false);
    assert.equal(noDir.m.read(ORDERS), PLAIN);
  });
});

describe('router mutants: --run', () => {
  const key = (mutant) => M.cacheKey({ check_kind: 'node-test', check_rule: null, target: 'check a', clean: 'good', mutant });
  const hardened = (opts = {}) => setup({ orders: HARDENED, files: { [M1]: 'mutant one', [M2]: 'mutant two' }, ...opts });
  const RUN = ['mutants', '--run', '--order', 'T-A'];
  const fixtures = (prover) => prover.calls.map((c) => c.fixture);

  // row 51
  it('runCommand', () => {
    for (const config of [null, disabled()]) {
      const { m, prover } = hardened({ config });
      const r = run(m, RUN);
      assert.equal(r.ok, true);
      assert.equal(r.disabled, true, 'running the check is not a read-only query: it follows the activation key');
      assert.equal(r.message, DISABLED);
      assert.deepEqual(r.written, []);
      noWrites(m);
      assert.equal(prover.calls.length, 0);
      assert.equal(exitCodeFor(r), 0);
    }

    const { m, prover } = hardened();
    const r = run(m, RUN);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.schema, 1);
    assert.equal(r.subcommand, 'mutants');
    assert.equal(r.disabled, false);
    assert.equal(r.mode, 'run');
    assert.equal(r.order, 'T-A');
    assert.equal(r.verdict, 'clear');
    assert.equal(r.base.status, 'green');
    assert.equal(r.base.flagged, false);
    assert.deepEqual(r.mutants.map((x) => [x.path, x.outcome, x.cached]), [[M1, 'killed', false], [M2, 'killed', false]]);
    assert.deepEqual(fixtures(prover), [BAD, M1, M2]);
    assert.deepEqual(r.written, [MUTANTS]);
    assert.deepEqual(Object.values(JSON.parse(m.read(MUTANTS)).entries).map((e) => e.outcome), ['killed', 'killed']);
    assert.equal(m.has(ENFORCEMENT), false, 'a manual run is not a phase run: no ENFORCEMENT.json');
    assert.deepEqual(lastJson(m), r);
    assert.equal(exitCodeFor(r), 0);

    // a second run is served from the cache
    prover.calls.length = 0;
    const again = run(m, RUN);
    assert.deepEqual(fixtures(prover), [BAD]);
    assert.deepEqual(again.mutants.map((x) => x.cached), [true, true]);
    assert.equal(again.verdict, 'clear');
    assert.deepEqual(again.written, []);

    // --no-cache runs everything and writes fresh answers
    prover.calls.length = 0;
    const fresh = run(m, [...RUN, '--no-cache']);
    assert.deepEqual(fixtures(prover), [BAD, M1, M2]);
    assert.deepEqual(fresh.mutants.map((x) => x.cached), [false, false]);
    assert.deepEqual(fresh.written, [MUTANTS]);
    assert.equal(exitCodeFor(fresh), 0);
  });

  it('runSurvivorExitsOne', () => {
    const { m, prover } = hardened({ table: { [M2]: FLAGGED } });
    const r = run(m, RUN);
    assert.equal(r.ok, true, 'the command ran; the verdict is what is wrong');
    assert.equal(r.verdict, 'flagged');
    assert.deepEqual(r.mutants.map((x) => [x.path, x.outcome]), [[M1, 'killed'], [M2, 'survived']]);
    assert.equal(exitCodeFor(r), 1);
    assert.deepEqual(r.written, [MUTANTS]);
    assert.deepEqual(Object.values(JSON.parse(m.read(MUTANTS)).entries).map((e) => e.outcome).sort(), ['killed', 'survived']);
    assert.equal(prover.calls.length, 3);
    run(m, RUN, { raw: false });
    assert.ok(m.calls.log.some((l) => l.includes(M1) && l.includes('killed')), m.calls.log.join('\n'));
    assert.ok(m.calls.log.some((l) => l.includes(M2) && l.includes('survived')), m.calls.log.join('\n'));
  });

  it('runErrorExitsOneAndIsNotCached', () => {
    const { m } = hardened({ table: { [M1]: new Error('spawn failed') } });
    const r = run(m, RUN);
    assert.equal(r.verdict, 'flagged');
    assert.equal(r.mutants[0].outcome, 'error');
    assert.equal(exitCodeFor(r), 1);
    assert.deepEqual(Object.keys(JSON.parse(m.read(MUTANTS)).entries).length, 1, 'only the answered mutant is remembered');
  });

  it('runBaseNotProvenSkipsMutants', () => {
    const { m, prover } = hardened({ table: { [BAD]: FLAGGED } });
    const r = run(m, RUN);
    assert.equal(r.ok, true);
    assert.equal(r.verdict, 'flagged');
    assert.equal(r.base.flagged, true);
    assert.deepEqual(r.mutants, []);
    assert.deepEqual(fixtures(prover), [BAD]);
    assert.deepEqual(r.written, []);
    assert.equal(m.has(MUTANTS), false);
    assert.equal(exitCodeFor(r), 1);
  });

  it('runRefusesLikeList', () => {
    for (const [id, code] of [['NOPE', 'order_not_found'], ['B-1', 'order_not_test']]) {
      const { m, prover } = hardened();
      const r = run(m, ['mutants', '--run', '--order', id]);
      assert.equal(codeOf(r), code);
      assert.equal(prover.calls.length, 0);
      noWrites(m);
      assert.equal(exitCodeFor(r), 1);
    }
    const noHost = hardened({ overrides: { argv: ['node', '/not/the/host.cjs'] } });
    const r = run(noHost.m, RUN);
    assert.equal(r.verdict, 'flagged', 'no host CLI: the base check cannot be proven');
    assert.equal(exitCodeFor(r), 1);
  });

  it('runAndEnforceShareTheCache', () => {
    const { m, prover } = hardened({ phase: true });
    run(m, RUN);
    assert.equal(prover.calls.length, 3);
    prover.calls.length = 0;
    const r = run(m, ['enforce', '--phase-dir', PHASE]);
    assert.equal(r.enforcement, 'clear', JSON.stringify(r.reasons));
    assert.deepEqual(fixtures(prover), [BAD], 'enforce reuses what --run learned');
    assert.deepEqual(r.results[0].mutants.map((x) => x.cached), [true, true]);
    // and the other way round
    const other = hardened({ phase: true });
    run(other.m, ['enforce', '--phase-dir', PHASE]);
    other.prover.calls.length = 0;
    const runAgain = run(other.m, RUN);
    assert.deepEqual(fixtures(other.prover), [BAD]);
    assert.deepEqual(runAgain.mutants.map((x) => x.cached), [true, true]);
  });

  it('cachedKeyMatchesWhatTheListReports', () => {
    const { m } = hardened();
    run(m, RUN);
    const listed = run(m, ['mutants', '--order', 'T-A']);
    assert.deepEqual(listed.mutants.map((x) => x.cached_outcome), ['killed', 'killed']);
    assert.ok(Object.keys(JSON.parse(m.read(MUTANTS)).entries).includes(key('mutant one')));
  });
});

describe('router mutants: usage', () => {
  // row 52
  it('usageCombos', () => {
    const body = JSON.stringify({ order: 'T-A', path: NEW, content: CONTENT });
    const combos = [
      ['mutants'],
      ['mutants', '--raw'],
      ['mutants', '--order'],
      ['mutants', '--order', '--raw'],
      ['mutants', '--run'],
      ['mutants', '--run', '--no-cache'],
      ['mutants', '--add', body, '--run'],
      ['mutants', '--add', body, '--run', '--order', 'T-A'],
      ['mutants', '--order', 'T-A', '--order', 'B-1'],
      ['mutants', '--order', 'T-A', 'positional'],
      ['mutants', '--order', 'T-A', '--bogus'],
      ['mutants', '--run', '--order', 'T-A', '--add'],
    ];
    for (const args of combos) {
      const { m, prover } = setup({ orders: HARDENED });
      const r = run(m, args);
      const label = args.join(' ');
      assert.equal(r.ok, false, label);
      assert.equal(r.subcommand, 'mutants', label);
      assert.equal(codeOf(r), 'usage', `${label}: ${JSON.stringify(r)}`);
      assert.deepEqual(r.written, [], label);
      assert.equal(m.calls.error.length, 1, `${label}: the message is reported once`);
      noWrites(m);
      assert.equal(prover.calls.length, 0, label);
      assert.equal(exitCodeFor(r), 1, label);
    }
    // accepted and ignored: --ws, which the host dispatcher forwards
    const ok = setup({ orders: HARDENED });
    assert.equal(run(ok.m, ['mutants', '--order', 'T-A', '--ws', 'w1']).ok, true);
  });

  it('mutantsHasNoPhaseFlags', () => {
    const { m } = setup({ orders: HARDENED });
    assert.equal(codeOf(run(m, ['mutants', '--order', 'T-A', '--phase-dir', PHASE])), 'usage');
  });
});

describe('router: validate sees check_mutants', () => {
  it('validateSurfacesMutantRules', () => {
    const plain = run(setup().m, ['validate']);
    assert.equal(plain.ok, true, JSON.stringify(plain.errors));
    assert.deepEqual(plain.warnings.filter((w) => w.code === 'no_mutants').map((w) => w.path), ['$.orders[0]'], 'a test order without mutants is reported, not rejected');

    const hardenedReport = run(setup({ orders: HARDENED }).m, ['validate']);
    assert.equal(hardenedReport.ok, true, JSON.stringify(hardenedReport.errors));
    assert.deepEqual(hardenedReport.warnings.filter((w) => w.code === 'no_mutants'), []);

    const bad = run(setup({ orders: join(testBlock('T-A', listBlock(['../x.js', M1, M1])), BACKSTOP) }).m, ['validate']);
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.errors.map((e) => [e.code, e.path]), [['path_invalid', '$.orders[0].check_mutants[0]'], ['duplicate_mutant', '$.orders[0].check_mutants[2]']]);
  });

  it('exportsTheSubcommand', () => {
    assert.equal(router.SUBCOMMANDS[router.SUBCOMMANDS.length - 1], 'mutants');
  });
});
