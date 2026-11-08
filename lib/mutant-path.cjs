'use strict';

/**
 * lib/mutant-path.cjs — the leaf both ORDERS.yaml validation (orders.cjs, phase.cjs) and mutant
 * enforcement (mutants.cjs) share: the one canonical form of a mutant path, the reservation of
 * `.planning/`, the cache file's location and the code strings of the `mutants` command.
 *
 * It requires nothing from the other lib modules, so it can sit under all of them without a cycle
 * (mutants.cjs -> host.cjs -> phase.cjs -> orders.cjs). mutants.cjs re-exports everything here.
 */

const path = require('node:path');

const MUTANTS_PATH = '.planning/standing-orders/MUTANTS.json';
const PLANNING_DIR = '.planning';
const DRIVE_RE = /^[A-Za-z]:/;

/** One source of truth for the code strings the validator and the `mutants` command report. */
const MUTANT_CODES = Object.freeze({
  ORDER_NOT_FOUND: 'order_not_found',
  ORDER_NOT_TEST: 'order_not_test',
  PATH_INVALID: 'path_invalid',
  PATH_OUTSIDE_PROJECT: 'path_outside_project',
  PATH_RESERVED: 'path_reserved',
  MUTANT_IS_CHECK_FILE: 'mutant_is_check_file',
  MUTANT_EXISTS: 'mutant_exists',
  MUTANT_MISSING: 'mutant_missing',
  CONTENT_INVALID: 'content_invalid',
  MANUAL: 'manual',
});

/**
 * The normalized, project-relative form of a mutant path, or null when it is not one:
 * backslashes become `/`; an absolute, drive-letter or UNC path is refused; so is any `..` segment as
 * written; then `path.posix.normalize` collapses repeated and `.` segments and the trailing `/` goes.
 * A result that is empty, `.`, `..` or starts with `../` is refused too. Case is kept (see mutantPathKey).
 */
function canonicalMutantPath(p) {
  if (typeof p !== 'string') return null;
  const slashed = p.replace(/\\/g, '/');
  if (slashed === '' || slashed.startsWith('/') || DRIVE_RE.test(slashed)) return null;
  if (slashed.split('/').includes('..')) return null;
  const posixPath = path.posix.normalize(slashed); // collapses repeated '/', so at most one trailing '/' remains
  const normalized = posixPath.endsWith('/') ? posixPath.slice(0, -1) : posixPath; // no regex: CodeQL js/polynomial-redos
  if (normalized === '' || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

/** The form every comparison uses: canonical and lower-cased (macOS and Windows ignore case), or null. */
function mutantPathKey(p) {
  const canonical = canonicalMutantPath(p);
  return canonical === null ? null : canonical.toLowerCase();
}

/** True when the canonical path is `.planning` or lies under it (any case). */
function isReservedMutantPath(canonical) {
  if (typeof canonical !== 'string') return false;
  const key = canonical.toLowerCase();
  return key === PLANNING_DIR || key.startsWith(PLANNING_DIR + '/');
}

module.exports = { MUTANTS_PATH, MUTANT_CODES, canonicalMutantPath, mutantPathKey, isReservedMutantPath };
