'use strict';

/**
 * lib/phase.cjs — collect the inputs a phase offers to Standing Orders: the file
 * paths its documents mention, and the files, requirements and must_haves its
 * plans declare.
 *
 * Pure apart from the injected `deps.listDir` / `deps.readFile`. Never throws for
 * bad input: a document or plan that cannot be read or parsed is reported, not
 * raised. Plan frontmatter is untrusted: anchors and aliases are refused and
 * every scalar stays a string (FAILSAFE schema).
 */

const path = require('node:path');
const { load, FAILSAFE_SCHEMA } = require('./vendor/js-yaml.cjs');
const { refuseAnchorsAndAliases } = require('./orders.cjs');

const PLAN_SUFFIX = '-PLAN.md';
const VERDICT_FILE = 'STANDING-ORDERS.md';
const MAX_DOC_BYTES = 1048576;

const REJECT_CHARS = ';&|$<>(){}[]*?\'"!=,`';
const SPAN_RE = /`([^`\n]+)`/g;
const POSITION_SUFFIX_RE = /:\d+(?::\d+)?$/;
const DRIVE_RE = /^[A-Za-z]:/;
const EXTENSION_RE = /\.[A-Za-z0-9]{1,10}$/;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function unique(list) {
  return [...new Set(list)];
}

/** Backslashes to `/`, runs of `/` collapsed, every leading `./` removed. */
function normalizeToken(t) {
  return t.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^(\.\/)+/, '');
}

function hasRejectedChar(t) {
  for (const ch of t) if (REJECT_CHARS.includes(ch)) return true;
  return false;
}

function acceptSpan(span) {
  let t = span.trim().replace(POSITION_SUFFIX_RE, '');
  if (t === '' || t.length > 300) return null;
  if (/\s/.test(t) || t.includes('://') || hasRejectedChar(t) || t.startsWith('-')) return null;
  t = normalizeToken(t);
  if (t === '' || t.startsWith('/') || DRIVE_RE.test(t)) return null;
  if (t.split('/').includes('..')) return null;
  if (!t.includes('/') && !EXTENSION_RE.test(t)) return null;
  return t;
}

function extractPathTokens(markdown) {
  if (typeof markdown !== 'string') return [];
  const out = [];
  let fenced = false;
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (line.trim().startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    for (const m of line.matchAll(SPAN_RE)) {
      const t = acceptSpan(m[1]);
      if (t !== null) out.push(t);
    }
  }
  return unique(out);
}

function splitReqIds(value) {
  if (typeof value !== 'string') return [];
  return unique(value.replace(/[[\]]/g, '').split(/[,\s]+/).filter((s) => s !== ''));
}

function parsePlanFrontmatter(text) {
  if (typeof text !== 'string') return { ok: false, error: 'no frontmatter' };
  let src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  src = src.replace(/\r\n?/g, '\n');
  if (!src.startsWith('---\n')) return { ok: false, error: 'no frontmatter' };
  const lines = src.slice(4).split('\n');
  const end = lines.indexOf('---');
  if (end === -1) return { ok: false, error: 'unterminated frontmatter' };
  const block = lines.slice(0, end).join('\n');
  if (refuseAnchorsAndAliases(block)) return { ok: false, error: 'anchors or aliases refused' };
  let data;
  try {
    data = load(block, { schema: FAILSAFE_SCHEMA, json: true });
  } catch (e) {
    return { ok: false, error: `invalid YAML: ${e && e.message ? e.message : String(e)}` };
  }
  if (!isPlainObject(data)) return { ok: false, error: 'frontmatter is not a mapping' };
  return { ok: true, data };
}

function stringList(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string');
  return [];
}

function normalizePlan(data) {
  const d = isPlainObject(data) ? data : {};
  return {
    files_modified: stringList(d.files_modified).map(normalizeToken),
    requirements: stringList(d.requirements).map((s) => s.trim()).filter((s) => s !== ''),
    must_haves: d.must_haves,
  };
}

function collectStrings(value, out) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (isPlainObject(value)) for (const k of Object.keys(value)) collectStrings(value[k], out);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isCited(id, mustHaves) {
  if (typeof id !== 'string' || id === '') return false;
  const strings = [];
  collectStrings(mustHaves, strings);
  const re = new RegExp('(?<![A-Za-z0-9_-])' + escapeRegExp(id) + '(?![A-Za-z0-9_-])');
  return strings.some((s) => re.test(s));
}

function errMessage(e) {
  return e && e.message ? e.message : String(e);
}

function isVerdictName(name) {
  return name === VERDICT_FILE || name.endsWith('-' + VERDICT_FILE);
}

/** True when `file` resolves (through links) to a path strictly inside `realDir`. */
function insideDir(realDir, file, realpath) {
  const rel = path.relative(realDir, realpath(file));
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function collectPhaseInputs({ phaseDir, deps: given }) {
  const deps = { realpath: (p) => p, statSize: () => undefined, ...given };
  const warnings = [];
  let names;
  try {
    names = Array.from(deps.listDir(phaseDir)).map(String);
  } catch (e) {
    warnings.push({ code: 'phase_dir_unreadable', message: `${phaseDir} could not be listed: ${errMessage(e)}` });
    return { files: [], planRequirements: [], plans: [], warnings };
  }
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  let realDir;
  try {
    realDir = deps.realpath(phaseDir);
  } catch (e) {
    warnings.push({ code: 'phase_dir_unreadable', message: `${phaseDir} could not be resolved: ${errMessage(e)}` });
    return { files: [], planRequirements: [], plans: [], warnings };
  }

  const plans = [];
  const docTokens = [];
  const unreadablePlan = (name, error) => plans.push({ file: name, ok: false, files_modified: [], requirements: [], must_haves: undefined, error });
  for (const name of names) {
    const full = phaseDir.replace(/[\\/]+$/, '') + '/' + name;
    const isPlan = name.endsWith(PLAN_SUFFIX);
    if (!isPlan && (!name.endsWith('.md') || name.endsWith('-SUMMARY.md') || isVerdictName(name))) continue;

    let contained;
    let size;
    try {
      contained = insideDir(realDir, full, deps.realpath);
      size = deps.statSize(full);
    } catch (e) {
      if (isPlan) unreadablePlan(name, `could not be read: ${errMessage(e)}`);
      else warnings.push({ code: 'doc_unreadable', message: `${name} could not be examined: ${errMessage(e)}` });
      continue;
    }
    if (!contained) {
      if (isPlan) unreadablePlan(name, 'outside phase directory');
      else warnings.push({ code: 'doc_outside_phase', message: `${name} resolves outside the phase directory and was skipped` });
      continue;
    }
    if (typeof size === 'number' && size > MAX_DOC_BYTES) {
      if (isPlan) unreadablePlan(name, 'plan too large');
      else warnings.push({ code: 'doc_too_large', message: `${name} is larger than ${MAX_DOC_BYTES} bytes and was skipped` });
      continue;
    }

    if (isPlan) {
      let text;
      try {
        text = deps.readFile(full);
      } catch (e) {
        plans.push({ file: name, ok: false, files_modified: [], requirements: [], must_haves: undefined, error: `could not be read: ${errMessage(e)}` });
        continue;
      }
      const parsed = parsePlanFrontmatter(text);
      if (!parsed.ok) {
        plans.push({ file: name, ok: false, files_modified: [], requirements: [], must_haves: undefined, error: parsed.error });
        continue;
      }
      plans.push({ file: name, ok: true, ...normalizePlan(parsed.data) });
      continue;
    }
    let text;
    try {
      text = deps.readFile(full);
    } catch (e) {
      warnings.push({ code: 'doc_unreadable', message: `${name} could not be read: ${errMessage(e)}` });
      continue;
    }
    if (typeof text !== 'string') continue;
    if (Buffer.byteLength(text) > MAX_DOC_BYTES) {
      warnings.push({ code: 'doc_too_large', message: `${name} is larger than ${MAX_DOC_BYTES} bytes and was skipped` });
      continue;
    }
    docTokens.push(...extractPathTokens(text));
  }

  const okPlans = plans.filter((p) => p.ok);
  return {
    files: unique([...docTokens, ...okPlans.flatMap((p) => p.files_modified)]),
    planRequirements: unique(okPlans.flatMap((p) => p.requirements)),
    plans,
    warnings,
  };
}

module.exports = {
  PLAN_SUFFIX, VERDICT_FILE, MAX_DOC_BYTES,
  extractPathTokens, splitReqIds, parsePlanFrontmatter, normalizePlan, isCited, collectPhaseInputs,
};
