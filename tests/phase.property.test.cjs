'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const { extractPathTokens } = require('../lib/phase.cjs');
const { SEED } = require('./helpers/fixtures.cjs');

// Phase-2 spec-review finding 3: whatever the markdown holds, an extracted
// token is a safe, project-relative path.
const NASTY = ['../up/x.js', '/etc/passwd', 'C:/x/y.js', 'c:\\x\\y.js', 'a/../b.js', 'a\\..\\b.js', '-rf/x.js', 'http://x/y.js', 'a b/c.js', './a/./b.js', 'ok/a.js', '..', '../..', 'a/..'];

describe('extractPathTokens properties', () => {
  it('extractPathTokensSafe', () => {
    const spanArb = fc.oneof(
      fc.string({ maxLength: 40 }),
      fc.stringMatching(/^[a-zA-Z0-9/.:\\ -]{0,24}$/),
      fc.constantFrom(...NASTY),
    );
    fc.assert(
      fc.property(fc.array(spanArb, { maxLength: 8 }), (spans) => {
        const md = spans.map((s) => '`' + s + '`').join(' ') + '\n';
        for (const token of extractPathTokens(md)) {
          assert.ok(!/\s/.test(token), `whitespace: ${JSON.stringify(token)}`);
          assert.ok(!token.includes('://'), `scheme: ${JSON.stringify(token)}`);
          assert.ok(!token.startsWith('/'), `leading slash: ${JSON.stringify(token)}`);
          assert.ok(!token.startsWith('-'), `leading dash: ${JSON.stringify(token)}`);
          assert.ok(!/^[A-Za-z]:/.test(token), `drive letter: ${JSON.stringify(token)}`);
          assert.ok(!token.split('/').includes('..'), `dot-dot segment: ${JSON.stringify(token)}`);
        }
      }),
      { seed: SEED, numRuns: 500 },
    );
  });

  it('extractPathTokensProbeIsNotVacuous', () => {
    const md = NASTY.map((s) => '`' + s + '`').join(' ');
    const tokens = extractPathTokens(md);
    assert.ok(tokens.includes('ok/a.js'), JSON.stringify(tokens));
    assert.ok(!tokens.includes('../up/x.js') && !tokens.includes('/etc/passwd'));
  });
});
