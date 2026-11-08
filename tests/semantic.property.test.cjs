'use strict';

// Row 57: whatever sequence of proposals and resolutions is applied (and whatever is refused), the semantic
// document stays valid. Seeded-PRNG loop (fast-check is not a dependency of this phase).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { SEED } = require('./helpers/fixtures.cjs');

const S = new Proxy({}, { get: (_, key) => require('../lib/semantic.cjs')[key] });

const ORDER_IDS = ['A', 'B', 'C', 'D'];
const KNOWN = new Set(ORDER_IDS);
const STATUSES = ['unresolved', 'resolved', 'dismissed', 'bogus'];
const REASONS = [undefined, null, '', '   ', 'a reason', '  padded  ', 'x'.repeat(1001)];

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

function randomProposals(rng) {
  const n = pick(rng, [0, 1, 1, 2, 3, 8, 51]);
  return Array.from({ length: n }, () => {
    const orders = Array.from({ length: 1 + int(rng, 3) }, () => pick(rng, rng() < 0.1 ? [...ORDER_IDS, 'GHOST'] : ORDER_IDS));
    return { orders, statement: pick(rng, ['one', 'two', 'three', 'one  ', 'x'.repeat(int(rng, 1100))]) };
  });
}

function assertValid(document, label) {
  const text = S.serializeSemantic(document);
  const back = S.parseSemantic(text);
  assert.equal(back.ok, true, `${label}: ${JSON.stringify(back)}`);
  assert.deepEqual(back.document, document, `${label}: round trip`);
  const ids = document.findings.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, `${label}: ids are unique`);
  for (const f of document.findings) {
    if (f.status === 'dismissed') assert.ok(typeof f.reason === 'string' && f.reason.trim() !== '', `${label}: ${f.id} is dismissed without a reason`);
    if (f.status === 'unresolved') assert.equal(f.resolved_by, null, `${label}: ${f.id}`);
    else assert.equal(f.resolved_by, 'human', `${label}: ${f.id}`);
    assert.ok(f.proposed_by === 'agent' || f.proposed_by === 'auto', label);
  }
}

describe('semantic: properties', () => {
  it('semanticDocumentStaysValid', () => {
    const rng = prng(SEED);
    for (let run = 0; run < 100; run += 1) {
      let document = S.emptyDocument('.planning/phases/03-billing');
      let tick = 0;
      for (let step = 0; step < 25; step += 1) {
        const label = `run ${run} step ${step}`;
        const before = JSON.stringify(document);
        const auto = rng() < 0.3;
        const ts = new Date(Date.UTC(2026, 10, 8, 0, 0, tick++)).toISOString();
        if (rng() < 0.5 || document.findings.length === 0) {
          const list = randomProposals(rng);
          const r = S.proposeFindings({ document, proposals: list, knownIds: KNOWN, auto, ts });
          if (r.ok) {
            assert.equal(r.added.length + r.duplicates.length, list.length, `${label}: every proposal is added or reported as a duplicate`);
            for (const id of r.added) {
              const f = r.document.findings.find((x) => x.id === id);
              assert.equal(f.status, 'unresolved', label);
              assert.equal(f.proposed_by, auto ? 'auto' : 'agent', label);
              assert.equal(f.ts, ts, label);
            }
            document = r.document;
          } else {
            assert.equal(typeof r.code, 'string', label);
            assert.equal(r.document, undefined, `${label}: a refused call returns no document`);
          }
        } else {
          const target = rng() < 0.9 ? pick(rng, document.findings).id : 'S-4242';
          const status = pick(rng, STATUSES);
          const r = S.resolveFinding({ document, id: target, status, reason: pick(rng, REASONS), auto, ts });
          if (r.ok) {
            assert.equal(auto, false, `${label}: --auto never decides`);
            assert.equal(r.finding.status, status, label);
            document = r.document;
          } else {
            assert.equal(r.document, undefined, label);
            if (auto && status !== 'bogus') assert.ok(['auto_never_dismisses', 'auto_cannot_confirm'].includes(r.code),`${label}: ${r.code}`);
          }
        }
        assertValid(document, label);
        if (JSON.stringify(document) === before) continue;
        assert.ok(document.findings.length >= JSON.parse(before).findings.length, `${label}: findings are never removed`);
      }
    }
  });

  it('refusedCallsLeaveTheDocumentUntouched', () => {
    const rng = prng(SEED + 7);
    let document = S.emptyDocument('p');
    const seeded = S.proposeFindings({ document, proposals: [{ orders: ['A'], statement: 'seed' }], knownIds: KNOWN, auto: false, ts: '2026-11-08T00:00:00.000Z' });
    document = seeded.document;
    const frozen = JSON.stringify(document);
    for (let i = 0; i < 100; i += 1) {
      S.proposeFindings({ document, proposals: [{ orders: ['A', 'GHOST'], statement: `bad ${i}` }], knownIds: KNOWN, auto: rng() < 0.5, ts: 'ts' });
      S.resolveFinding({ document, id: 'S-1', status: 'dismissed', reason: pick(rng, [undefined, '', '  ']), auto: false, ts: 'ts' });
      S.resolveFinding({ document, id: 'S-1', status: pick(rng, ['resolved', 'dismissed', 'unresolved']), reason: 'r', auto: true, ts: 'ts' });
    }
    assert.equal(JSON.stringify(document), frozen);
  });
});
