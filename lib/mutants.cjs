'use strict';

/**
 * lib/mutants.cjs — mutant enforcement for test-tier standing orders (ADR-0002).
 *
 * A mutant is a violation fixture that differs from the base only by being a
 * second "bad" input. It is proven by the very same prover call as the base
 * (runEnforcement), with only `check_violation_fixture` replaced. Mutants run
 * only after the base result is green and unflagged, in sorted path order,
 * sequentially.
 *
 * Fail-closed: an `error` outcome is never cached, and a cache problem means
 * "empty", never "killed". Every file this module reads (the mutants, the check
 * target and clean fixture it hashes, the cache) goes through `readContained`:
 * no symlinks, regular files only, the real path inside the real project root,
 * bounded size. The cache key covers the code too: the HEAD tree id, resolved
 * once per run by `resolveCodeId`; with no usable tree id nothing is read from
 * or written to the cache.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const { runEnforcement } = require('./host.cjs');
const { canonicalize, orderHash } = require('./trace.cjs');
const { parseOrders, ERROR_CODES } = require('./orders.cjs');
const { isPlainObject, compareStrings } = require('./util.cjs');
const { MUTANTS_PATH, MUTANT_CODES, canonicalMutantPath, mutantPathKey, isReservedMutantPath } = require('./mutant-path.cjs');

const MAX_CACHE_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 2000;
const MAX_MUTANT_BYTES = 65536;
const MAX_HASHED_BYTES = 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
const TREE_ID_RE = /^[0-9a-f]{40,64}$/;

const OUTCOMES = Object.freeze({ KILLED: 'killed', SURVIVED: 'survived', ERROR: 'error' });
const REASONS = Object.freeze({
  SURVIVED: 'mutant_survived',
  UNVERIFIED: 'mutant_unverified',
  MISSING: 'mutant_missing',
  UNREADABLE: 'mutant_unreadable',
});

const sha = (t) => crypto.createHash('sha256').update(String(t), 'utf8').digest('hex');

function cacheKey({ check_kind, check_rule, target, clean, mutant, code }) {
  const parts = { check_kind, target: sha(target), mutant: sha(mutant) };
  if (check_rule) parts.check_rule = check_rule;
  if (typeof clean === 'string') parts.clean = sha(clean);
  if (typeof code === 'string' && code !== '') parts.code = code;
  return sha(canonicalize(parts));
}

/** The cache key of one mutant of `order`: `texts` are the file texts { target, clean, mutant }, `code` the HEAD tree id. */
function cacheKeyFor(order, { target, clean, mutant }, code) {
  return cacheKey({ check_kind: order.check_kind, check_rule: order.check_kind === 'lint-rule' ? order.check_rule : null, target, clean, mutant, code });
}

const validEntry = (e) => isPlainObject(e) && (e.outcome === OUTCOMES.KILLED || e.outcome === OUTCOMES.SURVIVED) && typeof e.ts === 'string';

function parseCache(text) {
  const out = {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return out;
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.entries)) return out;
  for (const key of Object.keys(parsed.entries)) {
    if (key === '__proto__') continue;
    const entry = parsed.entries[key];
    if (validEntry(entry)) out[key] = { outcome: entry.outcome, ts: entry.ts };
  }
  return out;
}

function serializeCache(entries) {
  let keys = Object.keys(entries);
  if (keys.length > MAX_CACHE_ENTRIES) {
    keys = keys.sort((a, b) => compareStrings(entries[b].ts, entries[a].ts) || compareStrings(a, b)).slice(0, MAX_CACHE_ENTRIES);
  }
  const out = {};
  for (const k of keys.sort(compareStrings)) out[k] = entries[k];
  return JSON.stringify({ schema: 1, entries: out }, null, 2) + '\n';
}

function isInside(root, abs) {
  const rel = path.relative(root, abs);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

/**
 * Read one project file with containment and a size bound: { text } or { error, kind }.
 * Refused: a path outside the project, a symbolic link, a file that does not exist, anything but a regular
 * file, a real path outside the real root, a file over `maxBytes`, a dep that throws. `error` names `rel`.
 * kind: outside | symlink | missing | not_file | too_large | unreadable.
 */
function readContained(root, rel, io, maxBytes) {
  const refuse = (kind, detail) => ({ error: `${rel} ${detail}`, kind });
  try {
    const abs = path.resolve(root, rel);
    if (!isInside(root, abs)) return refuse('outside', 'resolves outside the project');
    if (io.isSymlink(abs)) return refuse('symlink', 'is a symbolic link');
    if (!io.exists(abs)) return refuse('missing', 'does not exist');
    if (!io.isFile(abs)) return refuse('not_file', 'is not a regular file');
    const real = io.realpath(abs);
    if (!isInside(io.realpath(root), real)) return refuse('outside', 'resolves outside the project');
    const size = io.statSize(real);
    if (typeof size !== 'number' || !(size <= maxBytes)) return refuse('too_large', `is larger than ${maxBytes} bytes`);
    return { text: String(io.readFile(abs)) };
  } catch (e) {
    return { error: `${rel}: ${e && e.message}`, kind: 'unreadable' };
  }
}

/** Read the cache. Any problem (missing, symlink, outside root, too big, bad JSON) is "empty". */
function readCache({ root, io }) {
  const file = readContained(root, MUTANTS_PATH, io, MAX_CACHE_BYTES);
  return file.error === undefined ? parseCache(file.text) : {};
}

/** Read one mutant file with containment: { text } or { error } (the error starts with its reason code). */
function readMutant(root, p, io) {
  const file = readContained(root, p, io, MAX_MUTANT_BYTES);
  if (file.error === undefined) return file;
  return { error: `${file.kind === 'missing' ? REASONS.MISSING : REASONS.UNREADABLE}: ${file.error}` };
}

/** The texts the cache key hashes besides the mutant: { target, clean } (clean null when unset), or null when either cannot be read. */
function hashableTexts(order, root, io) {
  if (typeof order.check_target !== 'string' || order.check_target === '') return null;
  const target = readContained(root, order.check_target, io, MAX_HASHED_BYTES);
  if (target.error !== undefined) return null;
  if (!order.check_clean_fixture) return { target: target.text, clean: null };
  const clean = readContained(root, order.check_clean_fixture, io, MAX_HASHED_BYTES);
  return clean.error === undefined ? { target: target.text, clean: clean.text } : null;
}

function gitOutput(io, root, args, timeoutMs) {
  const out = io.execFile('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, encoding: 'utf8', windowsHide: true, maxBuffer: MAX_GIT_OUTPUT_BYTES });
  return String(out === undefined || out === null ? '' : out);
}

/**
 * The code component of the cache key: the HEAD tree id, or null when no cache may be used. Null when git is
 * unavailable, times out, prints something that is not a tree id, or the working tree is dirty outside `.planning`
 * (so the tree id would not describe the code the check ran against). Never throws.
 */
function resolveCodeId({ root, io, timeoutMs }) {
  try {
    const tree = gitOutput(io, root, ['rev-parse', 'HEAD^{tree}'], timeoutMs).trim();
    if (!TREE_ID_RE.test(tree)) return null;
    const dirty = gitOutput(io, root, ['status', '--porcelain', '--', '.', ':(exclude).planning'], timeoutMs);
    return dirty.trim() === '' ? tree : null;
  } catch (e) {
    return null;
  }
}

/** killed iff the host proved the check green and unflagged; survived iff the host located and ran the check; anything else is an error. */
function classifyOutcome(result) {
  if (result.status === 'green' && result.flagged === false) return OUTCOMES.KILLED;
  if (result.located === true) return OUTCOMES.SURVIVED;
  return OUTCOMES.ERROR;
}

/**
 * Run the mutants of `order` after a proven base. Returns
 * { result, entries, changed }: `result` is `base` itself when there is nothing
 * to do (no mutants, or the base is not green and unflagged). `code` is the HEAD
 * tree id from resolveCodeId; without a valid one nothing is read from or written
 * to the cache.
 */
function applyMutants({ order, base, root, io, entries = {}, useCache = true, ts, code = null }) {
  const list = isPlainObject(order) && Array.isArray(order.check_mutants) ? order.check_mutants.filter((x) => typeof x === 'string' && x !== '') : [];
  if (list.length === 0 || !(base && base.status === 'green' && base.flagged === false)) return { result: base, entries, changed: false };
  const sorted = [...list].sort(compareStrings);
  const next = { ...entries };
  let changed = false;
  const texts = typeof code === 'string' && TREE_ID_RE.test(code) ? hashableTexts(order, root, io) : null;
  const results = sorted.map((p) => {
    const file = readMutant(root, p, io);
    if (file.error !== undefined) return { path: p, outcome: OUTCOMES.ERROR, cached: false, reason: file.error };
    const key = texts === null ? null : cacheKeyFor(order, { target: texts.target, clean: texts.clean, mutant: file.text }, code);
    if (useCache && key !== null && validEntry(entries[key])) return { path: p, outcome: entries[key].outcome, cached: true, reason: 'cached' };
    const answer = runEnforcement({ order: { ...order, check_violation_fixture: p }, cwd: root, env: io.env, argv: io.argv, deps: io });
    const outcome = classifyOutcome(answer);
    if (outcome !== OUTCOMES.ERROR && key !== null) {
      next[key] = { outcome, ts };
      changed = true;
    }
    return { path: p, outcome, cached: false, reason: answer.reason };
  });
  const survived = results.filter((x) => x.outcome === OUTCOMES.SURVIVED).map((x) => x.path);
  const unverified = results.filter((x) => x.outcome === OUTCOMES.ERROR).map((x) => x.path);
  const parts = [];
  if (survived.length > 0) parts.push(`${REASONS.SURVIVED}: ${survived.join(', ')}`);
  if (unverified.length > 0) parts.push(`${REASONS.UNVERIFIED}: ${unverified.join(', ')}`);
  const flagged = parts.length > 0;
  return { result: { ...base, flagged, reason: flagged ? parts.join('; ') : base.reason, mutants: results }, entries: next, changed };
}

// ─── mutants --add: validation and the ORDERS.yaml insertion plan (pure) ──────

const YAML_PLAIN_RE = /^[A-Za-z_][A-Za-z0-9_./-]*$/;
const YAML_WORDS = new Set(['null', 'true', 'false', 'yes', 'no', 'on', 'off', '~']);
const yamlScalar = (p) => (YAML_PLAIN_RE.test(p) && !YAML_WORDS.has(p.toLowerCase()) ? p : JSON.stringify(p));

const withoutEol = (line) => line.replace(/\r?\n$/, '');
const isBlankOrComment = (text) => text.trim() === '' || /^\s*#/.test(text);
const unquoteScalar = (value) => value.replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2');
const leadingSpaces = (text) => /^\s*/.exec(text)[0].length;

/** The line index and dash indent of the list item `- id: <id>`, or null. */
function findOrderStart(lines, id) {
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(\s*)-\s+id:\s*(.*)$/.exec(withoutEol(lines[i]));
    if (match && unquoteScalar(match[2]) === id) return { start: i, dashIndent: match[1].length };
  }
  return null;
}

/** The index of the first line after the order's block (the first non-blank line indented less than its keys). */
function findOrderEnd(lines, start, keyIndent) {
  for (let i = start + 1; i < lines.length; i += 1) {
    const text = withoutEol(lines[i]);
    if (isBlankOrComment(text)) continue;
    if (leadingSpaces(text) < keyIndent) return i;
  }
  return lines.length;
}

/** Insert `p` into the check_mutants of order `id` in ORDERS.yaml text. { text } or { manual: true }. */
function insertMutantText(text, id, p) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  const found = findOrderStart(lines, id);
  if (found === null) return { manual: true };
  const { start, dashIndent } = found;
  const keyIndent = dashIndent + 2;
  const end = findOrderEnd(lines, start, keyIndent);
  const keyRe = new RegExp(`^ {${keyIndent}}check_mutants:(.*)$`);
  let keyAt = -1;
  for (let i = start + 1; i < end; i += 1) {
    const match = keyRe.exec(withoutEol(lines[i]));
    if (match) {
      keyAt = i;
      if (match[1].replace(/\s+#.*$/, '').trim() !== '') return { manual: true };
      break;
    }
  }
  const withEol = (line) => (line.endsWith('\n') ? line : line + eol);
  const spaces = (n) => ' '.repeat(n);
  if (keyAt === -1) {
    let after = start + 1;
    for (let i = start + 1; i < end; i += 1) {
      if (!isBlankOrComment(withoutEol(lines[i]))) after = i + 1;
    }
    const head = lines.slice(0, after);
    head[head.length - 1] = withEol(head[head.length - 1]);
    return { text: head.join('') + `${spaces(keyIndent)}check_mutants:${eol}${spaces(keyIndent + 2)}- ${yamlScalar(p)}${eol}` + lines.slice(after).join('') };
  }
  let last = keyAt;
  let itemIndent = null;
  for (let i = keyAt + 1; i < end; i += 1) {
    const lineText = withoutEol(lines[i]);
    const item = /^(\s*)-\s/.exec(lineText);
    if (item && item[1].length >= keyIndent) {
      if (itemIndent === null) itemIndent = item[1].length;
      last = i;
    } else if (isBlankOrComment(lineText)) continue;
    else break;
  }
  if (itemIndent === null) return { manual: true };
  const head = lines.slice(0, last + 1);
  head[head.length - 1] = withEol(head[head.length - 1]);
  return { text: head.join('') + `${spaces(itemIndent)}- ${yamlScalar(p)}${eol}` + lines.slice(last + 1).join('') };
}

const failure = (code, message, extra) => ({ failure: extra === undefined ? { code, message } : { code, message, extra } });

/**
 * The checks of `mutants --add` that need no I/O: the order exists and is a test order, and the path (canonicalized)
 * is valid, not under .planning, not a check file of the order, not already a mutant.
 * `parsed` is the parseOrders result of the current ORDERS.yaml (ok). Returns { order, path } or { failure: { code, message } }.
 */
function validateMutantAdd({ parsed, id, path: given }) {
  const order = parsed.document.orders.find((candidate) => candidate.id === id);
  if (order === undefined) return failure(MUTANT_CODES.ORDER_NOT_FOUND, `no order with id ${id}`);
  if (order.verification !== 'test') return failure(MUTANT_CODES.ORDER_NOT_TEST, `${id} is not a test-tier order`);
  const canonical = canonicalMutantPath(given);
  if (canonical === null) return failure(MUTANT_CODES.PATH_INVALID, `${given} must be a relative path inside the project`);
  if (isReservedMutantPath(canonical)) return failure(MUTANT_CODES.PATH_RESERVED, `${given} is under .planning`);
  const key = canonical.toLowerCase();
  const checkKeys = [order.check_target, order.check_violation_fixture, order.check_clean_fixture].map(mutantPathKey).filter((k) => k !== null);
  if (checkKeys.includes(key)) return failure(MUTANT_CODES.MUTANT_IS_CHECK_FILE, `${given} is a check file of ${id}`);
  if (order.check_mutants.map(mutantPathKey).includes(key)) return failure(MUTANT_CODES.MUTANT_EXISTS, `${given} is already a mutant of ${id}`);
  return { order, path: canonical };
}

/**
 * Build the new ORDERS.yaml text for `mutants --add` and prove it: it re-parses, every other order hashes as before, and
 * the target order differs only by the added path. { plan: { text } } or { failure: { code, message, extra? } }; `manual`
 * carries the YAML to paste in `extra.paste`. `maxBytes` bounds the new text.
 */
function planMutantAdd({ text, parsed, id, mutantPath, maxBytes }) {
  const manual = () => failure(MUTANT_CODES.MANUAL, 'ORDERS.yaml cannot be extended safely; add the path by hand and save the mutant file', { paste: `check_mutants:\n  - ${yamlScalar(mutantPath)}` });
  const inserted = insertMutantText(text, id, mutantPath);
  if (inserted.manual) return manual();
  const after = parseOrders(inserted.text);
  if (!after.ok) return manual();
  const orderedBefore = parsed.document.orders;
  const orderedAfter = after.document.orders;
  const sameElsewhere =
    orderedAfter.length === orderedBefore.length &&
    orderedAfter.every((order, i) =>
      order.id === id
        ? orderHash({ ...order, check_mutants: orderedBefore[i].check_mutants }) === orderHash(orderedBefore[i]) && JSON.stringify(order.check_mutants) === JSON.stringify([...orderedBefore[i].check_mutants, mutantPath])
        : orderHash(order) === orderHash(orderedBefore[i]),
    );
  if (!sameElsewhere) return manual();
  if (Buffer.byteLength(inserted.text, 'utf8') > maxBytes) return failure(ERROR_CODES.FILE_TOO_LARGE, 'ORDERS.yaml would be too large');
  return { plan: { text: inserted.text } };
}

module.exports = {
  MUTANTS_PATH,
  MAX_CACHE_BYTES,
  MAX_CACHE_ENTRIES,
  MAX_MUTANT_BYTES,
  MAX_HASHED_BYTES,
  MUTANT_CODES,
  OUTCOMES,
  REASONS,
  canonicalMutantPath,
  mutantPathKey,
  isReservedMutantPath,
  cacheKey,
  cacheKeyFor,
  parseCache,
  serializeCache,
  readContained,
  readCache,
  readMutant,
  hashableTexts,
  resolveCodeId,
  classifyOutcome,
  applyMutants,
  validateMutantAdd,
  planMutantAdd,
  isInside,
};
