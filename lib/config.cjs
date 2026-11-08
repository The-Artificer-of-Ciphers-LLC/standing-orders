'use strict';

/**
 * lib/config.cjs — read the `standing-orders.*` capability configuration from the
 * host's `.planning/config.json` (the host nests dotted keys; the flat key is
 * never read).
 *
 * Pure apart from the injected `readFile`. Never throws for bad input: an
 * unreadable, unparsable or invalid value falls back to the default, and an
 * invalid value that was present yields a `config_invalid` warning.
 *
 *   readCapabilityConfig({ cwd, env, readFile }) ->
 *     { enabled, blockOn, maxBytes, warnings: [{ code, key, message }] }
 */

const path = require('node:path');
const { MAX_DOC_BYTES } = require('./phase.cjs');

const CONFIG_KEYS = Object.freeze({
  enabled: 'standing-orders.enabled',
  blockOn: 'standing-orders.block_on',
  maxBytes: 'standing-orders.max_bytes',
});
const CONFIG_DEFAULTS = Object.freeze({
  'standing-orders.enabled': false,
  'standing-orders.block_on': 'conflict',
  'standing-orders.max_bytes': 6000,
});
const BLOCK_ON_VALUES = Object.freeze(['conflict', 'conflict_or_missing', 'never']);
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** A project or workstream name is usable only when it is one plain path segment. */
function cleanSegment(value) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (t === '') return null;
  if (t.includes('/') || t.includes('\\') || t.includes('..')) return null;
  return t;
}

/** Candidate config files, most specific first. */
function configPaths(cwd, env) {
  const e = env || {};
  const base = path.join(cwd, '.planning');
  let dir = base;
  const project = cleanSegment(e.GSD_PROJECT);
  if (project !== null) dir = path.join(dir, project);
  const workstream = cleanSegment(e.GSD_WORKSTREAM);
  if (workstream !== null) dir = path.join(dir, 'workstreams', workstream);
  const first = path.join(dir, 'config.json');
  const second = path.join(base, 'config.json');
  return first === second ? [first] : [first, second];
}

function walk(root, segments) {
  let node = root;
  for (const seg of segments) {
    if (FORBIDDEN_SEGMENTS.has(seg)) return { found: false, value: undefined };
    if (!isPlainObject(node) || !Object.prototype.hasOwnProperty.call(node, seg)) return { found: false, value: undefined };
    node = node[seg];
  }
  return { found: true, value: node };
}

/** Size of `p`, or 0 (unknown: let the read decide) when it cannot be measured. */
function sizeOf(statSize, p) {
  try {
    return statSize(p);
  } catch (e) {
    return 0;
  }
}

function resolveConfigValue(dotKey, { cwd, env, readFile, statSize }) {
  const segments = String(dotKey).split('.');
  for (const p of configPaths(cwd, env)) {
    let parsed;
    try {
      if (typeof statSize === 'function' && sizeOf(statSize, p) > MAX_DOC_BYTES) continue;
      parsed = JSON.parse(readFile(p));
    } catch (e) {
      continue;
    }
    const hit = walk(parsed, segments);
    if (hit.found) return hit;
  }
  return { found: false, value: undefined };
}

function invalid(key, value) {
  return { code: 'config_invalid', key, message: `${key} has an invalid value ${JSON.stringify(value)}; using the default ${JSON.stringify(CONFIG_DEFAULTS[key])}` };
}

function readCapabilityConfig({ cwd, env, readFile, statSize }) {
  const warnings = [];
  const ctx = { cwd, env, readFile, statSize };

  const en = resolveConfigValue(CONFIG_KEYS.enabled, ctx);
  const enabled = en.found ? Boolean(en.value) : false;

  const bo = resolveConfigValue(CONFIG_KEYS.blockOn, ctx);
  let blockOn = CONFIG_DEFAULTS[CONFIG_KEYS.blockOn];
  if (bo.found) {
    if (BLOCK_ON_VALUES.includes(bo.value)) blockOn = bo.value;
    else warnings.push(invalid(CONFIG_KEYS.blockOn, bo.value));
  }

  const mb = resolveConfigValue(CONFIG_KEYS.maxBytes, ctx);
  let maxBytes = CONFIG_DEFAULTS[CONFIG_KEYS.maxBytes];
  if (mb.found) {
    if (Number.isInteger(mb.value) && mb.value >= 0) maxBytes = mb.value;
    else warnings.push(invalid(CONFIG_KEYS.maxBytes, mb.value));
  }

  return { enabled, blockOn, maxBytes, warnings };
}

module.exports = { CONFIG_KEYS, CONFIG_DEFAULTS, BLOCK_ON_VALUES, configPaths, resolveConfigValue, readCapabilityConfig };
