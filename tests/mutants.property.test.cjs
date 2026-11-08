'use strict';

// Phase 6 (#7), row 50: `mutants --add` is all-or-nothing. For any valid ORDERS.yaml layout and any path the command
// either writes the mutant AND an ORDERS.yaml that differs only by the added path, or writes nothing at all.
// The layouts are produced by a hand-written serializer (different code from the inserter under test) and the run is
// driven through the router over the in-memory filesystem. fast-check runs with the fixed repository seed.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const { routeStandingOrdersCommand } = require('../standing-orders-router.cjs');
const { parseOrders } = require('../lib/orders.cjs');
const { orderHash } = require('../lib/trace.cjs');
const { SEED } = require('./helpers/fixtures.cjs');
const { memfs } = require('./helpers/memfs.cjs');

const CONFIG = '.planning/config.json';
const ORDERS = '.planning/standing-orders/ORDERS.yaml';
const DIR = 'tests/fixtures/mutants';
const CONTENT = 'module.exports = 1;\n';
const SAFE = ['a', 'b', 'c', 'Z', '0', '7', '-', '_', ' ', ': ', ' #', '&', '*', '@', '!', '%', "'", '"', ',', String.fromCharCode(0xe9), String.fromCharCode(0x65e5)];
const SUPPORTED = ['none', 'block', 'blockLevel', 'blockDeep', 'blockThenComment'];
const LAYOUTS = [...SUPPORTED, 'flow', 'flowEmpty', 'blockCommentBetween'];

const nameArb = fc.array(fc.constantFrom(...SAFE), { minLength: 1, maxLength: 7 }).map((parts) => 'zz' + parts.join(''));
const spec = fc.record({
  indent: fc.constantFrom(0, 2, 4),
  count: fc.integer({ min: 1, max: 4 }),
  target: fc.nat(3),
  layouts: fc.array(fc.constantFrom(...LAYOUTS), { minLength: 4, maxLength: 4 }),
  mutantPos: fc.constantFrom('end', 'beforeSource', 'afterVerification'),
  quote: fc.constantFrom('', '"', "'"),
  crlf: fc.boolean(),
  finalNewline: fc.boolean(),
  blanks: fc.boolean(),
  headComment: fc.boolean(),
  backstopLast: fc.boolean(),
  name: nameArb,
});

/** One test order as lines. `layout` decides how its existing check_mutants are written. */
function orderLines(i, s, layout) {
  const dash = ' '.repeat(s.indent);
  const key = ' '.repeat(s.indent + 2);
  const id = `T-${i}`;
  const keys = [
    `${dash}- id: ${s.quote}${id}${s.quote}`,
    `${key}kind: prohibition`,
    `${key}statement: "Order ${i} never happens."   # inline note`,
    `${key}# which tests prove this`,
    `${key}verification: test`,
    `${key}check_kind: node-test`,
    `${key}check_target: tests/t${i}.test.cjs`,
    `${key}check_violation_fixture: tests/fixtures/bad${i}.js`,
    `${key}check_clean_fixture: tests/fixtures/good${i}.js`,
  ];
  const ex = [`${DIR}/ex${i}a.js`, `${DIR}/ex${i}b.js`];
  const items = (indent, list) => list.map((p) => `${indent}- ${p}`);
  const k2 = ' '.repeat(s.indent + 4);
  const k4 = ' '.repeat(s.indent + 6);
  const layouts = {
    none: [],
    block: [`${key}check_mutants:`, ...items(k2, ex)],
    blockLevel: [`${key}check_mutants:`, ...items(key, ex)],
    blockDeep: [`${key}check_mutants:`, ...items(k4, ex)],
    blockThenComment: [`${key}check_mutants:`, ...items(k2, ex), `${k2}# end of the list`],
    blockCommentBetween: [`${key}check_mutants:`, `${k2}- ${ex[0]}`, `${k2}# the second one is newer`, `${k2}- ${ex[1]}`],
    flow: [`${key}check_mutants: [${ex.join(', ')}]`],
    flowEmpty: [`${key}check_mutants: []`],
  };
  const block = layouts[layout];
  const source = `${key}source: "contract ${i}"`;
  if (s.mutantPos === 'end') return [...keys, ...block, ...(i % 2 === 0 ? [source] : [])];
  if (s.mutantPos === 'beforeSource') return [...keys, ...block, source];
  return [...keys.slice(0, 5), ...block, ...keys.slice(5), source];
}

function build(s) {
  const lines = ['version: "1"', 'orders:'];
  if (s.headComment) lines.unshift('# Standing orders');
  for (let i = 0; i < s.count; i += 1) {
    if (i > 0 && s.blanks) lines.push('');
    lines.push(...orderLines(i, s, s.layouts[i]));
  }
  if (s.backstopLast) lines.push(`${' '.repeat(s.indent)}- id: B-1`, `${' '.repeat(s.indent + 2)}kind: invariant`, `${' '.repeat(s.indent + 2)}statement: "Be fair."`, `${' '.repeat(s.indent + 2)}verification: backstop`);
  let text = lines.join('\n') + (s.finalNewline ? '\n' : '');
  if (s.crlf) text = text.replace(/\n/g, '\r\n');
  return text;
}

function project(text) {
  const files = { [CONFIG]: JSON.stringify({ 'standing-orders': { enabled: true } }), [ORDERS]: text };
  return memfs({ files });
}

const addTo = (m, order, p) =>
  routeStandingOrdersCommand({ args: ['standing-orders', 'mutants', '--add', JSON.stringify({ order, path: p, content: CONTENT }), '--raw'], cwd: m.cwd, raw: true, error: m.error, deps: m.deps });

const byId = (text) => {
  const parsed = parseOrders(text);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors) + '\n' + text);
  return Object.fromEntries(parsed.document.orders.map((o) => [o.id, o]));
};

/** True when `after` is `before` with extra lines inserted in one place and nothing else touched. */
function isPureInsertion(before, after) {
  const b = before.split('\n');
  const a = after.split('\n');
  if (a.length <= b.length) return false;
  let p = 0;
  while (p < b.length && a[p] === b[p]) p += 1;
  let s = 0;
  while (s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s += 1;
  return p + s >= b.length;
}

describe('mutants --add: properties', () => {
  it('addIsAllOrNothing', () => {
    fc.assert(
      fc.property(spec, (s) => {
        const text = build(s);
        const before = byId(text);
        const target = `T-${s.target % s.count}`;
        const m = project(text);
        const p = `${DIR}/${s.name}.js`;
        const r = addTo(m, target, p);
        assert.notEqual(r.errors && r.errors[0] && r.errors[0].code, 'internal_error', JSON.stringify(r));
        if (r.ok) {
          const after = byId(m.read(ORDERS));
          assert.deepEqual(Object.keys(after), Object.keys(before));
          for (const id of Object.keys(before)) {
            if (id === target) continue;
            assert.equal(orderHash(after[id]), orderHash(before[id]), `${id} changed`);
          }
          assert.deepEqual(after[target].check_mutants, [...before[target].check_mutants, p]);
          assert.equal(orderHash({ ...after[target], check_mutants: before[target].check_mutants }), orderHash(before[target]), 'the target differs only by the added path');
          assert.equal(m.read(p), CONTENT, 'the mutant file holds the content');
          assert.equal(r.written.length, 2);
          // adding the same path again is refused and changes nothing
          const snapshot = m.read(ORDERS);
          const again = addTo(m, target, p);
          assert.equal(again.ok, false);
          assert.equal(m.read(ORDERS), snapshot, 'a repeat changes nothing');
        } else {
          assert.deepEqual(r.written, []);
          assert.equal(m.read(ORDERS), text, 'ORDERS.yaml is byte-identical after a refusal');
          assert.equal(m.has(p), false, 'and no mutant file was left behind');
          assert.deepEqual(m.calls.writeFile, []);
          assert.deepEqual(m.calls.rename, []);
        }
      }),
      { seed: SEED, numRuns: 150 },
    );
  });

  it('supportedLayoutsAlwaysSucceedAsAPureInsertion', () => {
    fc.assert(
      fc.property(spec, (raw) => {
        const s = { ...raw, layouts: raw.layouts.map((l) => (SUPPORTED.includes(l) ? l : 'block')) };
        const text = build(s);
        const target = `T-${s.target % s.count}`;
        const m = project(text);
        const p = `${DIR}/${s.name}.js`;
        const r = addTo(m, target, p);
        assert.equal(r.ok, true, `${JSON.stringify(r)}\n${text}`);
        const after = m.read(ORDERS);
        if (s.finalNewline) {
          assert.equal(isPureInsertion(text, after), true, `only lines were inserted:\n${text}\n---\n${after}`);
          const delta = after.split('\n').length - text.split('\n').length;
          assert.equal(delta, s.layouts[s.target % s.count] === 'none' ? 2 : 1);
        }
        if (s.crlf) assert.equal(/(^|[^\r])\n/.test(after), false, 'line endings stay CRLF');
        assert.equal(byId(after)[target].check_mutants.at(-1), p);
      }),
      { seed: SEED + 1, numRuns: 150 },
    );
  });
});
