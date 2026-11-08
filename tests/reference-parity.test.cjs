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
