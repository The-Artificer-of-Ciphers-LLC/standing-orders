'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const { orderHash, appendText, parseTrace, serializeRecord } = require('../lib/trace.cjs');
const { order, testOrder, parsed, SEED } = require('./helpers/fixtures.cjs');

const segment = fc.stringMatching(/^[a-z0-9_.-]{1,6}$/);
const globArb = fc.array(fc.oneof(segment, fc.constant('*'), fc.constant('**')), { minLength: 1, maxLength: 3 }).map((s) => s.join('/'));
const reqId = fc.stringMatching(/^[A-Z]{2,4}-[0-9]{1,2}$/);
// Non-blank: the parser rejects a whitespace-only statement or source, so a blank one is a setup error, not a hash case.
const text = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 ,.]{0,19}$/);

const specArb = fc.record({
  id: fc.stringMatching(/^[A-Z][A-Z0-9-]{1,8}$/),
  statement: text,
  kind: fc.constantFrom('prohibition', 'invariant'),
  test: fc.boolean(),
  operation: fc.option(segment, { nil: null }),
  source: fc.option(text, { nil: null }),
  contexts: fc.array(segment, { maxLength: 3 }),
  paths: fc.array(globArb, { maxLength: 3 }),
  requirements: fc.array(reqId, { maxLength: 3 }),
});

/** A normalized order (the parser's shape); contexts are not resolved here, the hash only sees the order. */
function normalized(s) {
  const base = s.test
    ? testOrder({ id: s.id, statement: s.statement, kind: s.kind })
    : order({ id: s.id, statement: s.statement, kind: s.kind });
  const doc = parsed({ orders: [base] });
  const o = { ...doc.orders[0], operation: s.operation, source: s.source, contexts: s.contexts, scope: { paths: s.paths, requirements: s.requirements } };
  return o;
}

/** Deterministic Fisher-Yates driven by an integer seed (no Math.random). */
function shuffled(list, seed) {
  const out = [...list];
  let x = (seed >>> 0) || 1;
  for (let i = out.length - 1; i > 0; i -= 1) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    const j = x % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function reorderKeys(value, seed) {
  if (Array.isArray(value)) return value.map((v) => reorderKeys(v, seed + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of shuffled(Object.keys(value), seed)) out[k] = reorderKeys(value[k], seed + 7);
    return out;
  }
  return value;
}

const seedArb = fc.integer({ min: 1, max: 2 ** 31 - 1 });

describe('trace — properties', () => {
  it('hashStableUnderKeyReorder', () => {
    fc.assert(
      fc.property(specArb, seedArb, (s, seed) => {
        const o = normalized(s);
        assert.equal(orderHash(reorderKeys(o, seed)), orderHash(o));
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  it('hashStableUnderSetListReorder', () => {
    fc.assert(
      fc.property(specArb, seedArb, fc.nat({ max: 3 }), (s, seed, dupes) => {
        const o = normalized(s);
        const grow = (list) => shuffled([...list, ...list.slice(0, dupes)], seed);
        const reordered = { ...o, contexts: grow(o.contexts), scope: { ...o.scope, paths: grow(o.scope.paths), requirements: grow(o.scope.requirements) } };
        assert.equal(orderHash(reordered), orderHash(o));
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  // Phase 6 (#7), row 12: `check_mutants` is a set, like contexts and scope.
  it('mutantsAreASet', () => {
    const mutantPath = fc.stringMatching(/^[a-z0-9_.-]{1,6}(\/[a-z0-9_.-]{1,6}){0,2}$/);
    fc.assert(
      fc.property(specArb, fc.array(mutantPath, { minLength: 1, maxLength: 5 }), seedArb, fc.nat({ max: 3 }), (s, list, seed, dupes) => {
        const o = normalized(s);
        const grown = shuffled([...list, ...list.slice(0, dupes)], seed);
        assert.equal(orderHash({ ...o, check_mutants: grown }), orderHash({ ...o, check_mutants: list }), 'reordering and repeating mutants is not an edit');
        assert.equal(orderHash({ ...o, check_mutants: [...new Set(list)].sort() }), orderHash({ ...o, check_mutants: list }));
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  it('mutantMembershipChangesHash', () => {
    const mutantPath = fc.stringMatching(/^[a-z0-9_.-]{1,6}(\/[a-z0-9_.-]{1,6}){0,2}$/);
    fc.assert(
      fc.property(specArb, fc.array(mutantPath, { maxLength: 4 }), mutantPath, (s, list, extra) => {
        fc.pre(!list.includes(extra));
        const o = normalized(s);
        assert.notEqual(orderHash({ ...o, check_mutants: [...list, extra] }), orderHash({ ...o, check_mutants: list }), 'a new member is an edit');
        assert.equal(orderHash({ ...o, check_mutants: [] }), orderHash(o), 'an empty list is the same as none');
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  it('hashChangesOnEdit', () => {
    const scalarFields = ['id', 'kind', 'statement', 'operation', 'outcome', 'verification', 'check_kind', 'check_target', 'check_rule', 'check_violation_fixture', 'check_clean_fixture', 'source'];
    fc.assert(
      fc.property(specArb, fc.constantFrom(...scalarFields), text, (s, field, value) => {
        const o = normalized(s);
        fc.pre(o[field] !== value);
        assert.notEqual(orderHash({ ...o, [field]: value }), orderHash(o), `editing ${field}`);
      }),
      { seed: SEED, numRuns: 300 },
    );
    // a new member of a set-valued list is an edit too
    fc.assert(
      fc.property(specArb, segment, (s, extra) => {
        const o = normalized(s);
        fc.pre(!o.contexts.includes(extra) && !o.scope.paths.includes(extra) && !o.scope.requirements.includes(extra));
        assert.notEqual(orderHash({ ...o, contexts: [...o.contexts, extra] }), orderHash(o));
        assert.notEqual(orderHash({ ...o, scope: { ...o.scope, paths: [...o.scope.paths, extra] } }), orderHash(o));
        assert.notEqual(orderHash({ ...o, scope: { ...o.scope, requirements: [...o.scope.requirements, extra] } }), orderHash(o));
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  it('appendIsPrefixPreserving', () => {
    const recordArb = fc
      .record({ id: fc.stringMatching(/^[A-Z][A-Z0-9-]{1,8}$/), hex: fc.stringMatching(/^[0-9a-f]{64}$/), phase: fc.stringMatching(/^[a-z0-9][a-z0-9_-]{0,5}$/), sha: fc.option(fc.stringMatching(/^[0-9a-f]{40}$/), { nil: null }) })
      .map((r) => ({
        schema: 1,
        order_id: r.id,
        order_hash: 'sha256:' + r.hex,
        contexts: ['*'],
        phase: r.phase,
        plans: [],
        files: [],
        check: null,
        disposition: 'insufficient_spec',
        commit_sha: r.sha,
        ts: '2026-11-08T00:00:00.000Z',
      }));
    const junk = fc.constantFrom('not json', '0', '[]', 'null', '{"schema":2}', '{"order_id":', '', '   ');
    const lineArb = fc.oneof(recordArb.map((r) => serializeRecord(r)), junk);
    fc.assert(
      fc.property(fc.array(lineArb, { maxLength: 6 }), fc.boolean(), fc.array(recordArb, { maxLength: 4 }), (lines, trailing, news) => {
        const prefix = lines.join('\n') + (trailing && lines.length > 0 ? '\n' : '');
        const before = parseTrace(prefix);
        const extra = appendText(prefix, news);
        const after = parseTrace(prefix + extra);
        assert.ok((prefix + extra).startsWith(prefix), 'existing bytes are never rewritten');
        assert.deepEqual(after.records.slice(0, before.records.length), before.records, 'every previously parsed record survives, in order');
        assert.deepEqual(after.records.slice(before.records.length), news, 'the new records follow, nothing merged');
        assert.equal(after.warnings.length, before.warnings.length, 'appending never adds an invalid line');
        if (news.length === 0) assert.equal(extra, '');
        else assert.ok(extra.endsWith('\n'));
      }),
      { seed: SEED, numRuns: 300 },
    );
  });
});
