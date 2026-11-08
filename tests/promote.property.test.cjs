'use strict';

// Row 27: promotion never disturbs the orders already in the file. fast-check is not a dependency of this
// phase, so this is a seeded-PRNG loop: the same seed gives the same cases on every run.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parseOrders } = require('../lib/orders.cjs');
const { orderHash } = require('../lib/trace.cjs');
const { yamlOf, SEED } = require('./helpers/fixtures.cjs');

const P = new Proxy({}, { get: (_, key) => require('../lib/promote.cjs')[key] });

const RUNS = 200;
const MAX_BYTES = 256 * 1024;
const NON_ASCII = String.fromCharCode(0xe9, 0x65e5) + String.fromCodePoint(0x1f600);
const PIECES = ['alpha', 'beta', 'gamma', 'refund', 'never', 'always', ' ', ' ', ', ', '.', ': ', ' #', '"', "'", '\\', '- ', '[x]', '{y}', NON_ASCII];

/** mulberry32: a tiny deterministic generator. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (rng, n) => Math.floor(rng() * n);
const pick = (rng, list) => list[int(rng, list.length)];
const chance = (rng, p) => rng() < p;

function statement(rng) {
  let s = 'Rule ' + int(rng, 1000);
  for (let i = int(rng, 6); i >= 0; i -= 1) s += pick(rng, PIECES);
  return s.trim() + ' end';
}

function genOrder(rng, id, contexts) {
  const o = { id, kind: pick(rng, ['prohibition', 'invariant']), statement: statement(rng), verification: 'backstop' };
  if (chance(rng, 0.4)) o.source = 'source ' + int(rng, 100);
  if (chance(rng, 0.4)) o.scope = { paths: ['src/' + pick(rng, ['a', 'b', 'c']) + '/**'], requirements: ['REQ-' + (1 + int(rng, 9))] };
  if (contexts.length > 0 && chance(rng, 0.4)) o.contexts = [pick(rng, contexts)];
  return o;
}

/** A random valid ORDERS.yaml (produced by js-yaml, an independent writer) plus the order to add. */
function genCase(rng, n) {
  const contexts = chance(rng, 0.5) ? ['ctx-a', 'ctx-b'] : [];
  const existing = Array.from({ length: int(rng, 5) }, (_, i) => genOrder(rng, `OLD-${n}-${i}`, contexts));
  const root = { version: '1' };
  const contextsAfter = contexts.length > 0 && chance(rng, 0.5);
  const contextMap = Object.fromEntries(contexts.map((c) => [c, { description: c }]));
  if (contexts.length > 0 && !contextsAfter) root.contexts = contextMap;
  root.orders = existing;
  if (contextsAfter) root.contexts = contextMap;
  let text = yamlOf(root);
  const emptyFlow = existing.length === 0;
  if (chance(rng, 0.4) && !contextsAfter) text += (chance(rng, 0.5) ? '\n' : '') + '# end of file note\n';
  if (chance(rng, 0.3)) text = '# header comment\n' + text;
  const crlf = chance(rng, 0.25);
  if (crlf) text = text.replace(/\n/g, '\r\n');
  return { text, existing, emptyFlow, crlf, next: genOrder(rng, `NEW-${n}`, contexts) };
}

describe('promote: properties', () => {
  it('promotePreservesExistingOrders', () => {
    const rng = prng(SEED);
    for (let n = 0; n < RUNS; n += 1) {
      const c = genCase(rng, n);
      const label = `case ${n}: ${JSON.stringify(c.text)}`;
      const before = parseOrders(c.text);
      assert.equal(before.ok, true, `generator produced an invalid file (${label}): ${JSON.stringify(before.errors)}`);

      const r = P.promoteOrder({ text: c.text, order: c.next, maxBytes: MAX_BYTES });
      assert.equal(r.ok, true, `${label}: ${JSON.stringify(r)}`);
      assert.equal(r.id, c.next.id, label);

      const after = parseOrders(r.text);
      assert.equal(after.ok, true, `${label}: ${JSON.stringify(after.errors)}`);
      const oldOrders = before.document.orders;
      const newOrders = after.document.orders;
      assert.equal(newOrders.length, oldOrders.length + 1, label);
      for (let i = 0; i < oldOrders.length; i += 1) {
        assert.equal(orderHash(newOrders[i]), orderHash(oldOrders[i]), `${label}: order ${i} changed`);
      }
      const added = newOrders[newOrders.length - 1];
      assert.equal(added.id, c.next.id, label);
      assert.equal(added.statement, c.next.statement, `${label}: the statement round-trips`);
      assert.equal(newOrders.filter((o) => o.id === c.next.id).length, 1, label);

      if (!c.emptyFlow) {
        const item = P.serializeOrderItem(c.next, '  ', c.crlf ? '\r\n' : '\n');
        assert.equal(r.text.replace(item, ''), c.text, `${label}: every old byte is unchanged and only the item was added`);
      }
    }
  });

  it('promoteTwiceKeepsBothAndRefusesRepeat', () => {
    const rng = prng(SEED + 1);
    for (let n = 0; n < 50; n += 1) {
      const c = genCase(rng, n);
      const first = P.promoteOrder({ text: c.text, order: c.next, maxBytes: MAX_BYTES });
      assert.equal(first.ok, true, JSON.stringify(first));
      const second = P.promoteOrder({ text: first.text, order: genOrder(rng, `NEXT-${n}`, []), maxBytes: MAX_BYTES });
      assert.equal(second.ok, true, JSON.stringify(second));
      assert.equal(parseOrders(second.text).document.orders.length, c.existing.length + 2);
      const repeat = P.promoteOrder({ text: second.text, order: c.next, maxBytes: MAX_BYTES });
      assert.equal(repeat.ok, false);
      assert.equal(repeat.code, 'duplicate_id');
    }
  });
});
