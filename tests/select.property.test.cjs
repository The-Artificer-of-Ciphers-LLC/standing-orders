'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const { parseOrders, VERIFICATIONS } = require('../lib/orders.cjs');
const { globToRegExp, normalizePath, selectApplicable, renderApplicable } = require('../lib/select.cjs');
const { doc, order, SEED } = require('./helpers/fixtures.cjs');

const segment = fc.stringMatching(/^[a-z0-9_.-]{1,6}$/);
const globSegment = fc.oneof(segment, fc.constant('*'), fc.constant('**'), fc.constant('a?c'));
const glob = fc.array(globSegment, { minLength: 1, maxLength: 4 }).map((s) => s.join('/'));
const filePath = fc.array(segment, { minLength: 1, maxLength: 5 }).map((s) => s.join('/'));
const reqId = fc.stringMatching(/^[A-Z]{2,4}-[0-9]{1,2}$/);

const orderArb = fc.record({
  id: fc.stringMatching(/^[A-Z][A-Z0-9-]{1,8}$/),
  paths: fc.array(glob, { maxLength: 2 }),
  requirements: fc.array(reqId, { maxLength: 2 }),
  verification: fc.constantFrom(...VERIFICATIONS),
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
        assert.equal(typeof re.test, 'function');
        // The matcher reasons over the normalised glob's SEGMENTS (`./` stripped, slashes collapsed,
        // `**` meaningful only as a whole segment), so the structural claims below must too.
        const segs = normalizePath(g).split('/');
        const first = segs[0];
        const last = segs[segs.length - 1];
        const hasGlobstar = segs.includes('**');
        if (re.test(p)) {
          // Start: a first segment beginning with a wildcard may admit a different first segment
          // (`*/**` matches every path); otherwise the match is start-anchored. A leading `**`
          // segment admits any prefix.
          if (!first.startsWith('*')) assert.equal(re.test('zz/' + p), false, 'anchored at start');
          if (first === '**') assert.equal(re.test('zz/' + p), true, 'leading ** admits any prefix');
          // End: without a `**` segment the segment count is fixed, so an extra segment never
          // matches; a trailing `**` segment always admits one. A `**` elsewhere may absorb the growth.
          if (!hasGlobstar) assert.equal(re.test(p + '/zz'), false, 'anchored at end without **');
          if (last === '**') assert.equal(re.test(p + '/zz'), true, 'trailing ** admits any suffix');
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
