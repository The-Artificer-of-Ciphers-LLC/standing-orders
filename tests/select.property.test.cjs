'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const { parseOrders } = require('../lib/orders.cjs');
const { globToRegExp, selectApplicable, renderApplicable } = require('../lib/select.cjs');
const { doc, order } = require('./helpers/fixtures.cjs');

const SEED = 20261107;

const segment = fc.stringMatching(/^[a-z0-9_.-]{1,6}$/);
const globSegment = fc.oneof(segment, fc.constant('*'), fc.constant('**'), fc.constant('a?c'));
const glob = fc.array(globSegment, { minLength: 1, maxLength: 4 }).map((s) => s.join('/'));
const filePath = fc.array(segment, { minLength: 1, maxLength: 5 }).map((s) => s.join('/'));
const reqId = fc.stringMatching(/^[A-Z]{2,4}-[0-9]{1,2}$/);

const orderArb = fc.record({
  id: fc.stringMatching(/^[A-Z][A-Z0-9-]{1,8}$/),
  paths: fc.array(glob, { maxLength: 2 }),
  requirements: fc.array(reqId, { maxLength: 2 }),
  verification: fc.constantFrom('test', 'backstop'),
});

function documentOf(specs) {
  const seen = new Set();
  const orders = [];
  for (const s of specs) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    const o = order({ id: s.id, verification: s.verification, scope: { paths: s.paths, requirements: s.requirements } });
    if (s.verification === 'test') Object.assign(o, { check_kind: 'node-test', check_target: 't.cjs', check_violation_fixture: 'v', check_clean_fixture: 'c' });
    orders.push(o);
  }
  const r = parseOrders(doc({ orders }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return r.document;
}

describe('select — properties', () => {
  it('prop_globIsAnchoredAndTotal', () => {
    fc.assert(
      fc.property(fc.oneof(glob, fc.string()), filePath, (g, p) => {
        const re = globToRegExp(g);
        assert.ok(re instanceof RegExp);
        if (re.test(p)) {
          // A glob that begins with `**` legitimately admits any prefix; every other glob is start-anchored.
          if (!g.startsWith('**')) assert.equal(re.test('zz/' + p), false, 'anchored at start');
          assert.equal(re.test(p + '/zz'), g.endsWith('**'), 'anchored at end unless ** tail');
        }
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('prop_selectionIsMonotone', () => {
    fc.assert(
      fc.property(
        fc.array(orderArb, { maxLength: 6 }),
        fc.array(filePath, { maxLength: 4 }),
        fc.array(filePath, { maxLength: 3 }),
        fc.array(reqId, { maxLength: 3 }),
        fc.array(reqId, { maxLength: 2 }),
        (specs, files, moreFiles, reqs, moreReqs) => {
          const d = documentOf(specs);
          const base = selectApplicable(d, { files, requirements: reqs }).map((o) => o.id);
          const grown = selectApplicable(d, { files: [...files, ...moreFiles], requirements: [...reqs, ...moreReqs] }).map((o) => o.id);
          for (const id of base) assert.ok(grown.includes(id), `${id} stays selected when inputs grow`);
        },
      ),
      { seed: SEED, numRuns: 200 },
    );
  });

  it('prop_selectionIsASubset', () => {
    fc.assert(
      fc.property(fc.array(orderArb, { maxLength: 6 }), fc.array(filePath, { maxLength: 4 }), (specs, files) => {
        const d = documentOf(specs);
        const sel = selectApplicable(d, { files, requirements: [] });
        const ids = new Set(d.orders.map((o) => o.id));
        for (const o of sel) assert.ok(ids.has(o.id));
        assert.equal(new Set(sel.map((o) => o.id)).size, sel.length, 'no duplicates');
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  it('prop_renderRespectsCapAndPartitionsIds', () => {
    fc.assert(
      fc.property(fc.array(orderArb, { minLength: 1, maxLength: 6 }), fc.integer({ min: 0, max: 3000 }), (specs, cap) => {
        const d = documentOf(specs);
        const r = renderApplicable(d.orders, { maxBytes: cap });
        const ids = d.orders.map((o) => o.id).sort();
        assert.deepEqual([...r.included, ...r.omitted].sort(), ids, 'included ∪ omitted = input');
        const floor = renderApplicable([], { maxBytes: 100000 }).bytes;
        if (cap >= floor) assert.ok(r.bytes <= cap, `bytes ${r.bytes} <= cap ${cap}`);
        assert.equal(r.bytes, Buffer.byteLength(r.text, 'utf8'));
      }),
      { seed: SEED, numRuns: 200 },
    );
  });
});
