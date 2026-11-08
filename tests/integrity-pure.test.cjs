'use strict';

// Phase 7 (#15), matrix rows 18, 20-24: trace binding, boolean enable, operation canonicalization, cap minimum, reference parity.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { orderHash, dispositionFor, buildRecords } = require('../lib/trace.cjs');
const { readCapabilityConfig } = require('../lib/config.cjs');
const { detectConflicts } = require('../lib/conflicts.cjs');
const { renderApplicable } = require('../lib/select.cjs');
const { parsed, variant, order, testOrder } = require('./helpers/fixtures.cjs');

const PHASE = '.planning/phases/03-billing';

describe('trace binds a proof to the order it proved', () => {
  const document = parsed({ orders: [testOrder({ id: 'T-1', statement: 'Never A.' })] });
  const o = document.orders[0];
  const enforcement = (extra) => ({ schema: 1, phase: PHASE, status: 'clear', results: [{ id: 'T-1', status: 'green', flagged: false, ...extra }] });

  // matrix row 18
  it('staleOrderHashIsUnenforced', () => {
    assert.equal(dispositionFor(o, enforcement({ order_hash: orderHash(o) }), PHASE), 'proven');
    assert.equal(dispositionFor(o, enforcement({ order_hash: 'sha256:' + '0'.repeat(64) }), PHASE), 'unenforced');
    assert.equal(dispositionFor(o, enforcement({ order_hash: 5 }), PHASE), 'unenforced');
    // a report written before the hash existed keeps its meaning (additive key)
    assert.equal(dispositionFor(o, enforcement({}), PHASE), 'proven');
    const edited = { ...o, statement: 'Never A, except on Tuesdays.' };
    const records = buildRecords({ applicable: [edited], document, phaseRel: PHASE, plans: [], files: [], enforcement: enforcement({ order_hash: orderHash(o) }), commitSha: null, ts: 't' });
    assert.equal(records[0].disposition, 'unenforced');
  });
});

describe('config: only the boolean true enables', () => {
  const ROOT = path.join(path.sep, 'proj', '.planning', 'config.json');
  const read = (value, present = true) => {
    const text = present ? JSON.stringify({ 'standing-orders': { enabled: value } }) : JSON.stringify({ 'standing-orders': {} });
    return readCapabilityConfig({ cwd: path.join(path.sep, 'proj'), env: {}, readFile: (p) => (p === ROOT ? text : (() => { throw new Error('ENOENT'); })()) });
  };

  // matrix row 20
  it('onlyBooleanTrueEnables', () => {
    assert.equal(read(true).enabled, true);
    assert.deepEqual(read(true).warnings, []);
    assert.equal(read(false).enabled, false);
    assert.deepEqual(read(false).warnings, []);
    assert.equal(read(undefined, false).enabled, false);
    assert.deepEqual(read(undefined, false).warnings, []);
    for (const value of ['false', 'true', 'yes', 1, 0, '', null, [], {}, 'TRUE']) {
      const cfg = read(value);
      assert.equal(cfg.enabled, false, JSON.stringify(value));
      const w = cfg.warnings.filter((x) => x.code === 'enabled_not_boolean');
      assert.equal(w.length, 1, JSON.stringify(value));
      assert.equal(w[0].key, 'standing-orders.enabled');
    }
  });

  // matrix row 23
  it('capHasAMinimum', () => {
    const maxBytes = (value) => readCapabilityConfig({ cwd: path.join(path.sep, 'proj'), env: {}, readFile: () => JSON.stringify({ 'standing-orders': { enabled: true, max_bytes: value } }) });
    for (const below of [0, 10, 511]) {
      const cfg = maxBytes(below);
      assert.equal(cfg.maxBytes, 512, `max_bytes ${below}`);
      assert.deepEqual(cfg.warnings.map((w) => w.code), ['max_bytes_below_minimum'], `max_bytes ${below}`);
      assert.equal(cfg.warnings[0].key, 'standing-orders.max_bytes');
    }
    for (const fine of [512, 513, 6000]) {
      const cfg = maxBytes(fine);
      assert.equal(cfg.maxBytes, fine);
      assert.deepEqual(cfg.warnings, []);
    }
    const dflt = readCapabilityConfig({ cwd: path.join(path.sep, 'proj'), env: {}, readFile: () => JSON.stringify({ 'standing-orders': { enabled: true } }) });
    assert.equal(dflt.maxBytes, 6000);
    assert.deepEqual(dflt.warnings, []);

    // the rendered file stays inside the effective cap, header and footer counted
    const orders = [order({ id: 'A' })];
    for (const cap of [10, 511, 512, 513]) {
      const effective = Math.max(cap, 512);
      const r = renderApplicable(orders, { maxBytes: effective, phase: '3' });
      assert.ok(r.bytes <= effective || r.included.length === 0, `cap ${cap}`);
      assert.equal(Buffer.byteLength(r.text, 'utf8'), r.bytes);
    }
  });
});

describe('conflicts: operations compare canonically', () => {
  const NFC = String.fromCharCode(0xe9);
  const NFD = 'e' + String.fromCharCode(0x301);
  const pair = (a, b, kinds = ['variant', 'variant']) => {
    const d = parsed({
      contexts: { 'ctx-a': { description: 'a' } },
      orders: [
        variant('V-A', 'op.one', ['ctx-a'], 'full'),
        kinds[1] === 'variant' ? variant('V-B', 'op.two', ['ctx-a'], 'prorated') : order({ id: 'V-B', kind: 'prohibition', operation: 'op.two', contexts: ['ctx-a'] }),
      ],
    });
    d.orders[0].operation = a;
    d.orders[1].operation = b;
    return detectConflicts(d).conflicts;
  };

  // matrix row 21
  it('operationsCompareCanonically', () => {
    for (const [a, b] of [['r.amt', 'R.Amt'], ['r.amt', ' r.amt '], ['R.AMT', 'r.amt\t'], [`r.${NFC}`, `r.${NFD}`], [`R.${NFC}`, ` r.${NFD} `]]) {
      const found = pair(a, b);
      assert.equal(found.length, 1, JSON.stringify([a, b]));
      assert.equal(found[0].kind, 'variant-outcome');
    }
    assert.equal(pair('r.amt', 'R.Amt ', ['variant', 'prohibition']).length, 1);
  });

  // matrix row 22: negative space
  it('distinctOperationsStayDistinct', () => {
    for (const [a, b] of [['r.amt', 'r.amts'], ['r.amt', 'r.amt.x'], ['r.amt', 'r_amt'], ['r.amt', 'r. amt'], [`r.${NFC}`, 'r.e']]) {
      assert.deepEqual(pair(a, b), [], JSON.stringify([a, b]));
    }
  });
});

// matrix row 24: the reference documents every new code, file and rule
describe('references/standing-orders.md phase 7 parity', () => {
  const DOC = fs.readFileSync(path.resolve(__dirname, '..', 'references', 'standing-orders.md'), 'utf8');
  it('referenceDocListsPhase7Surface', () => {
    for (const code of ['check_file_changed', 'integrity_missing', 'plan_changed', 'enabled_not_boolean', 'max_bytes_below_minimum']) {
      assert.ok(DOC.includes('`' + code + '`'), `reference doc documents ${code}`);
    }
    assert.ok(DOC.includes('STANDING-ORDERS-INTEGRITY.json'), 'reference doc names the integrity record');
    for (const term of ['ORDERS.yaml', 'glob', 'symbolic link', 'absolute', 'lint-rule', 'PRD R11', '512']) {
      assert.ok(DOC.includes(term), `reference doc mentions ${term}`);
    }
  });
});
