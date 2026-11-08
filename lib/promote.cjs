'use strict';

/**
 * lib/promote.cjs -- promotion of phase rules into ORDERS.yaml (PRD-0001 R16; ADR-0001 section 4).
 *
 * Pure: every function takes its inputs as arguments and never throws for bad
 * input (a coded refusal is returned instead). All file I/O lives in the router.
 *
 * Reads candidates out of a phase's `*-SPEC.md` (resolved rows of the
 * `## Prohibitions` table) and `*-CONTEXT.md` (`- **D-NN:** text` lines inside
 * `<decisions>`), and adds exactly ONE order to ORDERS.yaml by inserting text:
 * the file is a human-owned document, so it is never re-serialized (comments and
 * layout survive). A re-parse guard proves every pre-existing order is unchanged.
 */

const { parseOrders, ORDER_KEYS } = require('./orders.cjs');
const { orderHash } = require('./trace.cjs');
const { isPlainObject, errMessage, normalizeWs } = require('./util.cjs');

const MAX_PHASE_FILE_BYTES = 1024 * 1024;
const MAX_CANDIDATES = 200;
const ORIGINS = Object.freeze(['spec-prohibition', 'context-decision']);
const PROMOTE_CODES = Object.freeze({
  BATCH_REFUSED: 'batch_refused',
  DUPLICATE_ID: 'duplicate_id',
  INVALID_ORDER: 'invalid_order',
  INSERT_UNSUPPORTED: 'insert_unsupported',
  ORDERS_UNUSABLE: 'orders_unusable',
  FILE_TOO_LARGE: 'file_too_large',
  PHASE_FILE_SKIPPED: 'phase_file_skipped',
});

const REQ_ID_RE = /^[A-Z][A-Z0-9]*-[0-9]+$/;
const TOP_KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:(.*)$/;
const SEPARATOR_CELL_RE = /^:?-{3,}:?$/;
const DECISION_RE = /^\s*[-*]\s+\*\*(D-[0-9]+):\*\*\s*(.+?)\s*$/;
const LINE_SEPARATORS = [String.fromCharCode(0x2028), String.fromCharCode(0x2029), String.fromCharCode(0x85)];

/** True for the name of a SPEC.md (not a UI-SPEC.md or AI-SPEC.md). */
function isSpecFileName(name) {
  if (typeof name !== 'string') return false;
  if (!(name === 'SPEC.md' || /-SPEC\.md$/.test(name))) return false;
  return !/(^|-)(UI|AI)-SPEC\.md$/.test(name);
}

/** True for the name of a CONTEXT.md. */
function isContextFileName(name) {
  return typeof name === 'string' && (name === 'CONTEXT.md' || /-CONTEXT\.md$/.test(name));
}

function normalizeEol(text) {
  return String(text).replace(/\r\n|\r/g, '\n');
}

/** The cells of a Markdown table row, or null when the line is not one. `\|` is a literal pipe. */
function splitTableRow(line) {
  const t = String(line).trim();
  if (t.length < 2 || !t.startsWith('|') || !t.endsWith('|')) return null;
  const inner = t.slice(1, -1);
  const cells = [];
  let cell = '';
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (c === '\\' && inner[i + 1] === '|') {
      cell += '|';
      i += 1;
    } else if (c === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += c;
    }
  }
  cells.push(cell.trim());
  return cells;
}

/** The resolved rows of a SPEC.md `## Prohibitions` table, as candidates. */
function specProhibitions(text, fileLabel) {
  const lines = normalizeEol(text).split('\n');
  const start = lines.findIndex((l) => /^##\s+Prohibitions\b/.test(l));
  if (start === -1) return [];
  const out = [];
  let n = 0;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) break;
    const cells = splitTableRow(lines[i]);
    if (cells === null || cells.length < 3) continue;
    if (cells.every((c) => SEPARATOR_CELL_RE.test(c))) continue;
    if (cells[0].toLowerCase().startsWith('prohibition') || cells[2].toLowerCase() === 'status') continue;
    if (cells[0].startsWith('[')) continue;
    n += 1;
    if (cells[2].toLowerCase().replace(/[^a-z]/g, '') !== 'resolved') continue;
    out.push({
      origin: 'spec-prohibition',
      source: `${fileLabel} prohibition ${n}`,
      statement: cells[0],
      requirements: cells[1].split(/[\s,]+/).filter((t) => REQ_ID_RE.test(t)),
      verification: /\btest\b/i.test(cells[3] || '') ? 'test' : 'backstop',
    });
  }
  return out;
}

/** The `- **D-NN:** text` lines inside `<decisions>` blocks of a CONTEXT.md, as candidates. */
function contextDecisions(text, fileLabel) {
  const out = [];
  let inside = false;
  for (const line of normalizeEol(text).split('\n')) {
    if (inside) {
      if (line.includes('</decisions>')) {
        inside = false;
        continue;
      }
      const m = DECISION_RE.exec(line);
      if (m) {
        out.push({ origin: 'context-decision', source: `${fileLabel} ${m[1]}`, statement: m[2], requirements: [], verification: 'backstop' });
      }
    } else if (line.includes('<decisions>')) {
      inside = true;
    }
  }
  return out;
}

/** Candidates marked with the order that already carries them (null when ORDERS.yaml is unusable). */
function markPromoted(candidates, document) {
  const orders = document && Array.isArray(document.orders) ? document.orders : null;
  return candidates.map((c) => {
    if (orders === null) return { ...c, already_promoted: null, promoted_as: null };
    const statement = normalizeWs(c.statement);
    const hit = orders.find((o) => o.source === c.source || normalizeWs(o.statement) === statement);
    return { ...c, already_promoted: hit !== undefined, promoted_as: hit !== undefined ? hit.id : null };
  });
}

/** All candidates of the given phase files (spec files first, then context files), marked and capped. */
function buildCandidates({ files, document }) {
  const list = Array.isArray(files) ? files : [];
  const found = [];
  for (const f of list) if (isSpecFileName(f.name)) found.push(...specProhibitions(f.text, f.label));
  for (const f of list) if (isContextFileName(f.name)) found.push(...contextDecisions(f.text, f.label));
  const kept = found.filter((c) => c.statement.trim() !== '');
  const truncated = kept.length > MAX_CANDIDATES;
  return { candidates: markPromoted(kept.slice(0, MAX_CANDIDATES), document), truncated };
}

/** Parse the `--add` argument: exactly one JSON object. */
function parseAddArgument(json) {
  let value;
  try {
    value = JSON.parse(json);
  } catch (e) {
    return { ok: false, code: 'usage', message: `--add needs one order as a JSON object: ${errMessage(e)}` };
  }
  if (Array.isArray(value)) {
    return { ok: false, code: PROMOTE_CODES.BATCH_REFUSED, message: 'promote adds exactly one order per call; give one JSON object, not a list' };
  }
  if (!isPlainObject(value)) return { ok: false, code: 'usage', message: '--add needs one order as a JSON object' };
  return { ok: true, order: value };
}

/** JSON for a YAML double-quoted scalar or flow collection; line separators are escaped so no YAML reader splits on them. */
function jsonScalar(value) {
  let s = JSON.stringify(value);
  if (s === undefined) s = 'null';
  for (const sep of LINE_SEPARATORS) s = s.split(sep).join('\\u' + sep.charCodeAt(0).toString(16).padStart(4, '0'));
  return s;
}

/** One order as a YAML block-sequence item (JSON values are YAML flow). Unknown keys are kept so the re-parse refuses them. */
function serializeOrderItem(order, indent, eol) {
  const known = ORDER_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(order, k));
  const rest = Object.keys(order).filter((k) => !ORDER_KEYS.includes(k));
  const keys = [...known, ...rest].filter((k) => order[k] !== undefined && order[k] !== null);
  let text = '';
  keys.forEach((key, i) => {
    text += `${i === 0 ? `${indent}- ` : `${indent}  `}${key}: ${jsonScalar(order[key])}${eol}`;
  });
  return text;
}

/** Split text into lines that keep their own terminator, so every byte can be reassembled exactly. */
function splitLines(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) || [];
}

const bareLine = (line) => line.replace(/\r?\n$/, '');

/** Insert one order item into ORDERS.yaml text. */
function insertOrder(text, order) {
  const paste = serializeOrderItem(order, '  ', '\n');
  if (text === null || text === undefined) {
    return { ok: true, text: `version: "1"\norders:\n${paste}` };
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = splitLines(text);
  const unsupported = (why, flow) => ({ ok: false, code: PROMOTE_CODES.INSERT_UNSUPPORTED, message: `ORDERS.yaml cannot be extended safely (${why}); add the order by hand`, paste, flow });
  const withEol = (line) => (line.endsWith('\n') ? line : line + eol);

  let ordersAt = -1;
  const keyAt = [];
  lines.forEach((line, i) => {
    const m = TOP_KEY_RE.exec(bareLine(line));
    if (m) {
      keyAt.push(i);
      if (ordersAt === -1 && m[1] === 'orders') ordersAt = i;
    }
  });

  if (ordersAt === -1) {
    const head = lines.length > 0 ? [...lines.slice(0, -1), withEol(lines[lines.length - 1])] : [];
    return { ok: true, text: head.join('') + `orders:${eol}` + serializeOrderItem(order, '  ', eol) };
  }

  const ordersLine = bareLine(lines[ordersAt]);
  const rest = TOP_KEY_RE.exec(ordersLine)[2];
  const commentAt = rest.search(/\s#/);
  const comment = commentAt === -1 ? '' : rest.slice(commentAt).trim();
  const value = (commentAt === -1 ? rest : rest.slice(0, commentAt)).trim();
  const terminator = lines[ordersAt].slice(ordersLine.length);

  if (value !== '' && value !== '[]') return unsupported('orders is not a block list', value.startsWith('['));
  if (value === '[]') lines[ordersAt] = `orders:${comment === '' ? '' : ' ' + comment}${terminator}`;

  const nextKey = keyAt.find((k) => k > ordersAt);
  const blockEnd = nextKey === undefined ? lines.length : nextKey;
  let after = ordersAt + 1;
  let indent = '  ';
  for (let i = ordersAt + 1; i < blockEnd; i += 1) {
    const line = bareLine(lines[i]);
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    after = i + 1;
  }
  for (let i = ordersAt + 1; i < blockEnd; i += 1) {
    const m = /^(\s*)-\s/.exec(bareLine(lines[i]));
    if (m) {
      indent = m[1];
      break;
    }
  }
  const before = lines.slice(0, after);
  if (before.length > 0) before[before.length - 1] = withEol(before[before.length - 1]);
  return { ok: true, text: before.join('') + serializeOrderItem(order, indent, eol) + lines.slice(after).join('') };
}

/**
 * Add one order to ORDERS.yaml text (`text` null when the file is missing). Proves, by re-parsing, that the
 * result is valid, holds exactly one new order, and left every earlier order unchanged.
 */
function promoteOrder({ text, order, maxBytes }) {
  const fail = (code, message, extra) => ({ ok: false, code, message, ...extra });
  if (!isPlainObject(order) || typeof order.id !== 'string' || order.id === '') {
    return fail(PROMOTE_CODES.INVALID_ORDER, 'the order needs a non-empty string id');
  }
  const id = order.id;
  let old = [];
  if (text !== null && text !== undefined) {
    const before = parseOrders(text);
    if (!before.ok) {
      // a flow-style `orders: [...]` cannot be extended whatever it holds: say how to add the order by hand
      const probe = insertOrder(text, order);
      if (!probe.ok && probe.flow === true) return fail(PROMOTE_CODES.INSERT_UNSUPPORTED, probe.message, { paste: probe.paste });
      return fail(PROMOTE_CODES.ORDERS_UNUSABLE, 'ORDERS.yaml could not be used; run standing-orders validate', { errors: before.errors });
    }
    old = before.document.orders;
    if (old.some((o) => o.id === id)) return fail(PROMOTE_CODES.DUPLICATE_ID, `an order with id ${id} already exists`);
  }
  const inserted = insertOrder(text, order);
  if (!inserted.ok) return fail(inserted.code, inserted.message, { paste: inserted.paste });
  const paste = serializeOrderItem(order, '  ', '\n');
  const after = parseOrders(inserted.text);
  if (!after.ok) return fail(PROMOTE_CODES.INVALID_ORDER, 'the order is not valid; ORDERS.yaml was not changed', { errors: after.errors, paste });
  const added = after.document.orders.filter((o) => o.id === id);
  const others = after.document.orders.filter((o) => o.id !== id);
  const same = others.length === old.length && others.every((o, i) => orderHash(o) === orderHash(old[i]));
  if (added.length !== 1 || !same) {
    return fail(PROMOTE_CODES.INSERT_UNSUPPORTED, 'ORDERS.yaml cannot be extended safely; add the order by hand', { paste });
  }
  if (Buffer.byteLength(inserted.text, 'utf8') > maxBytes) {
    return fail(PROMOTE_CODES.FILE_TOO_LARGE, `ORDERS.yaml would exceed the ${maxBytes}-byte limit`);
  }
  return { ok: true, text: inserted.text, id };
}

module.exports = {
  MAX_PHASE_FILE_BYTES,
  MAX_CANDIDATES,
  ORIGINS,
  PROMOTE_CODES,
  isSpecFileName,
  isContextFileName,
  splitTableRow,
  specProhibitions,
  contextDecisions,
  markPromoted,
  buildCandidates,
  parseAddArgument,
  serializeOrderItem,
  insertOrder,
  promoteOrder,
};
