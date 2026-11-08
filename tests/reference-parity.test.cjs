'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { KINDS, VERIFICATIONS, CHECK_KINDS, ERROR_CODES } = require('../lib/orders.cjs');

// The reference document is the product here (schema documentation), so reading
// it as data is the intended behavioral check: the enums it documents must equal
// the enums the parser enforces, or the doc lies to rule authors.
const DOC = fs.readFileSync(path.resolve(__dirname, '..', 'references', 'standing-orders.md'), 'utf8');

/** Values from a line of the form `- **<field>** — one of: `a` | `b` | `c`` */
function enumFromDoc(field) {
  const re = new RegExp(`^- \\*\\*${field}\\*\\*[^\\n]*?one of:([^\\n]*)$`, 'm');
  const m = DOC.match(re);
  assert.ok(m, `reference doc declares an enum line for ${field}`);
  return [...m[1].matchAll(/`([^`]+)`/g)].map((x) => x[1]);
}

describe('references/standing-orders.md parity', () => {
  it('referenceDocEnumsMatchExports', () => {
    assert.deepEqual(enumFromDoc('kind'), [...KINDS]);
    assert.deepEqual(enumFromDoc('verification'), [...VERIFICATIONS]);
    assert.deepEqual(enumFromDoc('check_kind'), [...CHECK_KINDS]);
  });

  it('referenceDocMatchesLoopSurface', () => {
    const { SUBCOMMANDS } = require('../standing-orders-router.cjs');
    const { BLOCK_ON_VALUES } = require('../lib/config.cjs');
    const { STATUS } = require('../lib/gate.cjs');
    for (const sub of SUBCOMMANDS) {
      assert.ok(DOC.includes('`standing-orders ' + sub + '`'), `reference doc documents the subcommand ${sub}`);
    }
    for (const value of BLOCK_ON_VALUES) {
      assert.ok(DOC.includes('`' + value + '`'), `reference doc documents block_on value ${value}`);
    }
    for (const value of Object.values(STATUS)) {
      assert.ok(DOC.includes('`' + value + '`'), `reference doc documents verdict status ${value}`);
    }
  });

  it('referenceDocListsEveryErrorCode', () => {
    for (const code of Object.values(ERROR_CODES)) {
      assert.ok(DOC.includes('`' + code + '`'), `reference doc documents error code ${code}`);
    }
  });
});

describe('references/standing-orders.md phase 3 parity', () => {
  it('referenceDocListsPhase3CodesAndCommand', () => {
    const { SUBCOMMANDS } = require('../standing-orders-router.cjs');
    const { STATUS } = require('../lib/gate.cjs');
    assert.ok(SUBCOMMANDS.includes('enforce'));
    assert.ok(DOC.includes('`standing-orders enforce`'), 'reference doc documents the enforce subcommand');
    for (const code of ['check_file_modified', 'not_projected', 'enforcement_flagged']) {
      assert.ok(DOC.includes('`' + code + '`'), `reference doc documents verdict reason ${code}`);
    }
    assert.ok(DOC.includes('`' + STATUS.FLAGGED + '`'), 'reference doc documents the flagged status');
    assert.ok(DOC.includes('ENFORCEMENT.json'), 'reference doc names the enforcement report');
    assert.ok(DOC.includes('`enforcement`'), 'reference doc documents the enforcement verdict field');
  });
});

describe('references/standing-orders.md phase 5 parity', () => {
  it('referenceDocListsPhase5Surface', () => {
    const { SUBCOMMANDS } = require('../standing-orders-router.cjs');
    const { PROMOTE_CODES } = require('../lib/promote.cjs');
    const { SEMANTIC_CODES } = require('../lib/semantic.cjs');
    assert.ok(SUBCOMMANDS.includes('promote'), 'the router lists promote');
    assert.ok(SUBCOMMANDS.includes('semantic'), 'the router lists semantic');
    assert.ok(DOC.includes('`standing-orders promote`'), 'reference doc documents the promote subcommand');
    assert.ok(DOC.includes('`standing-orders semantic`'), 'reference doc documents the semantic subcommand');
    for (const code of [...Object.values(PROMOTE_CODES), ...Object.values(SEMANTIC_CODES)]) {
      assert.ok(DOC.includes('`' + code + '`'), `reference doc documents code ${code}`);
    }
    const capability = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'capability.json'), 'utf8'));
    assert.deepEqual(capability.commands[0].subcommands, [...SUBCOMMANDS], 'capability.json subcommands equal the router SUBCOMMANDS');
  });
});
