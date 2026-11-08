'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');

/** sha512 (hex) of js-yaml 4.3.2 `dist/js-yaml.js` as published on npm (verified 2026-11-07 against the registry integrity hash of the tarball). */
const JS_YAML_SHA512 = '8d94689e3708f93f3612788889f53f094ff3416a32eb65ba4185bde62ae60f73dd742ad80123aef5b368c8a8354d79d2642e534272ca844b61413cf08412b183';

describe('vendored js-yaml', () => {
  it('vendoredJsYamlIsPinned', () => {
    const vendored = fs.readFileSync(path.join(ROOT, 'lib', 'vendor', 'js-yaml.cjs'));
    const upstream = fs.readFileSync(path.join(ROOT, 'node_modules', 'js-yaml', 'dist', 'js-yaml.js'));
    assert.ok(upstream.equals(vendored), 'vendored bundle is byte-identical to the pinned devDependency');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.devDependencies['js-yaml'], '4.3.2', 'exact pin');
    const upstreamPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'js-yaml', 'package.json'), 'utf8'));
    assert.equal(upstreamPkg.version, '4.3.2');
    const digest = crypto.createHash('sha512').update(vendored).digest('hex');
    assert.equal(digest, JS_YAML_SHA512, 'vendored bundle matches the pinned upstream digest');
  });

  it('vendoredLicenseIsPresentAndMatchesUpstream', () => {
    const lic = fs.readFileSync(path.join(ROOT, 'lib', 'vendor', 'js-yaml.LICENSE.txt'), 'utf8');
    assert.ok(/MIT License/.test(lic));
    const up = fs.readFileSync(path.join(ROOT, 'node_modules', 'js-yaml', 'LICENSE'), 'utf8');
    assert.equal(lic, up);
  });

  it('vendoredBundleLoadsStandaloneWithFailsafeSchema', () => {
    const y = require('../lib/vendor/js-yaml.cjs');
    assert.equal(typeof y.load, 'function');
    assert.equal(typeof y.FAILSAFE_SCHEMA, 'object');
    assert.equal(typeof y.YAMLException, 'function');
    assert.deepEqual(y.load('a: 1\nb: [x, y]\n', { schema: y.FAILSAFE_SCHEMA }), { a: '1', b: ['x', 'y'] });
  });
});
