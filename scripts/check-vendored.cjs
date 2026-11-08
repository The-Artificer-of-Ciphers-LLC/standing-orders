#!/usr/bin/env node
'use strict';

/**
 * check-vendored.cjs — byte-compares every vendored artifact in lib/vendor/
 * against the exact devDependency version in node_modules.
 *
 * A GSD capability is installed copy-only (ADR-1244 D5 rule 1): no npm step
 * ever runs on the user's machine, so anything the router needs at runtime is
 * vendored in-tree. This script is the drift guard: it fails when the vendored
 * copy differs from the pinned upstream, or when the pin in package.json is a
 * range instead of an exact version.
 *
 * Usage: node scripts/check-vendored.cjs
 * Exit:  0 all vendored files match; 1 drift or missing upstream.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** One row per vendored artifact: upstream file -> vendored file. */
const VENDORED = [
  {
    pkg: 'js-yaml',
    upstream: path.join('node_modules', 'js-yaml', 'dist', 'js-yaml.js'),
    vendored: path.join('lib', 'vendor', 'js-yaml.cjs'),
    license: path.join('lib', 'vendor', 'js-yaml.LICENSE.txt'),
    upstreamLicense: path.join('node_modules', 'js-yaml', 'LICENSE'),
  },
];

function readOrNull(p) {
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

function main() {
  const problems = [];
  const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const devDeps = pkgJson.devDependencies || {};

  for (const row of VENDORED) {
    const pin = devDeps[row.pkg];
    if (typeof pin !== 'string' || !/^\d+\.\d+\.\d+$/.test(pin)) {
      problems.push(`${row.pkg}: devDependencies pin must be an exact version (got ${JSON.stringify(pin)})`);
    }
    const up = readOrNull(path.join(ROOT, row.upstream));
    const vend = readOrNull(path.join(ROOT, row.vendored));
    if (up === null) {
      problems.push(`${row.pkg}: upstream ${row.upstream} not found — run npm install first`);
    } else if (vend === null) {
      problems.push(`${row.pkg}: vendored ${row.vendored} is missing`);
    } else if (!up.equals(vend)) {
      problems.push(`${row.pkg}: ${row.vendored} differs from ${row.upstream} (refresh with: cp ${row.upstream} ${row.vendored})`);
    }
    const upLic = readOrNull(path.join(ROOT, row.upstreamLicense));
    const vendLic = readOrNull(path.join(ROOT, row.license));
    if (vendLic === null) {
      problems.push(`${row.pkg}: license notice ${row.license} is missing`);
    } else if (upLic !== null && !upLic.equals(vendLic)) {
      problems.push(`${row.pkg}: ${row.license} differs from ${row.upstreamLicense}`);
    }
  }

  if (problems.length > 0) {
    for (const p of problems) process.stderr.write(`check-vendored: ${p}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`check-vendored: ${VENDORED.length} vendored artifact(s) match their pinned upstream\n`);
}

main();
