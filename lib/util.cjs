'use strict';

/**
 * lib/util.cjs — small pure helpers shared by the Standing Orders modules.
 */

/** True for a non-null, non-array object. */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** The message of a thrown value, whatever it is. */
function errMessage(e) {
  return e && e.message ? e.message : String(e);
}

/** `list` without duplicates, first occurrence kept. */
function unique(list) {
  return [...new Set(list)];
}

/** Comparator for `Array.prototype.sort`: code-unit order, locale-independent. */
function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True for a string with at least one character. */
function nonEmptyString(v) {
  return typeof v === 'string' && v !== '';
}

/** The horizontal ellipsis, built from its code point to keep this source ASCII. */
const ELLIPSIS = String.fromCharCode(0x2026);

/** Collapse every whitespace run to one space and trim. */
function normalizeWs(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

module.exports = { isPlainObject, errMessage, unique, compareStrings, nonEmptyString, normalizeWs, ELLIPSIS };
