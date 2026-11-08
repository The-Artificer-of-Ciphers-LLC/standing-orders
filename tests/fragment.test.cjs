'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The planner fragment is a product document (ADR-0001 altitude condition a):
// the planner reads it, so the promises it makes are checked as data.
const FRAGMENT = fs.readFileSync(path.resolve(__dirname, '..', 'fragments', 'plan-pre-planner.md'), 'utf8');

describe('fragments/plan-pre-planner.md', () => {
  it('plannerFragmentHonorsAltitudeCondition', () => {
    assert.ok(FRAGMENT.includes('in addition to'), 'orders apply in addition to the phase must_haves');
    assert.ok(FRAGMENT.includes('standing-orders select'), 'names the select command');
    assert.ok(FRAGMENT.includes('STANDING-ORDERS.md'), 'names the verdict file');
  });
});
