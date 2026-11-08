'use strict';

/**
 * lib/select.cjs — applicable-rule selection and the byte-capped APPLICABLE.md
 * rendering (PRD-0001 R5; ADR-0001 §4 `plan:pre` select step).
 *
 * Pure. Scope matching uses a deliberately minimal glob (`*`, `**`, `?`; every
 * other character is literal) over forward-slash paths; backslashes are
 * normalised unconditionally because a Windows-authored ORDERS.yaml is read on
 * Linux too. An order with no scope at all is global (confirmed 2026-11-07).
 *
 * Rendering packs WHOLE orders, in a deterministic order (test tier before
 * backstop, then by id), into a UTF-8 byte budget, with a header that states the
 * orders apply IN ADDITION TO the phase's own must_haves (ADR-857 altitude
 * condition) and a footer that always states how many orders were omitted.
 */

/** Forward slashes, runs of slashes collapsed, no leading `./`. */
function normalizePath(p) {
  return String(p).replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\.\//, '');
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * Compile a minimal glob to an anchored RegExp.
 *   `**` followed by `/`  → zero or more whole segments
 *   `/**` at the end      → the directory itself or anything below it
 *   `**` elsewhere        → anything
 *   `*`                   → anything within one segment
 *   `?`                   → exactly one non-slash character
 * Everything else is literal.
 */
const SLASH_TOKEN = '\\/';

function globToRegExp(glob) {
  const g = normalizePath(glob);
  // One regex fragment per glob token, so a trailing `/**` can replace the
  // preceding literal slash without string surgery on an earlier fragment
  // (which broke on `**/**`, where the previous fragment was not a slash).
  const tokens = [];
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      i++;
      if (g[i + 1] === '/') {
        i++;
        tokens.push('(?:.*/)?');
      } else if (i + 1 === g.length && tokens.length > 0 && tokens[tokens.length - 1] === SLASH_TOKEN) {
        tokens.pop();
        tokens.push('(?:/.*)?');
      } else {
        tokens.push('.*');
      }
    } else if (c === '*') {
      tokens.push('[^/]*');
    } else if (c === '?') {
      tokens.push('[^/]');
    } else {
      tokens.push(escapeRegex(c));
    }
  }
  return new RegExp('^' + tokens.join('') + '$');
}

/** Does the order's scope match any of the phase's files or requirement ids? Empty scope matches everything. */
function matchesScope(order, selection = {}) {
  const files = Array.isArray(selection.files) ? selection.files.map(normalizePath) : [];
  const requirements = Array.isArray(selection.requirements) ? selection.requirements : [];
  const paths = (order.scope && order.scope.paths) || [];
  const reqs = (order.scope && order.scope.requirements) || [];
  if (paths.length === 0 && reqs.length === 0) return true;
  for (const glob of paths) {
    const re = globToRegExp(glob);
    if (files.some((f) => re.test(f))) return true;
  }
  return reqs.some((r) => requirements.includes(r));
}

function tierRank(order) {
  return order.verification === 'test' ? 0 : 1;
}

function byTierThenId(a, b) {
  const t = tierRank(a) - tierRank(b);
  if (t !== 0) return t;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The orders applicable to a phase, in rendering order. */
function selectApplicable(document, selection = {}) {
  return document.orders.filter((o) => matchesScope(o, selection)).sort(byTierThenId);
}

// ─── Rendering ────────────────────────────────────────────────────────────────

/** One line: newlines collapsed to spaces, other C0/DEL controls replaced with U+FFFD. */
function line(value) {
  if (value === null || value === undefined) return '—';
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/\r\n?|\n/g, ' ').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '�');
}

function header(phase) {
  const title = phase === undefined || phase === null || phase === '' ? '# Applicable standing orders' : `# Applicable standing orders — phase ${line(phase)}`;
  return `${title}\n\nThese orders apply in addition to the phase's own must_haves, never instead of them. Cite each order id in must_haves; never list an order's check target in files_modified.\n\n`;
}

/** The footer never embeds the cap value, so its length depends only on the omitted count. */
function footer(omitted) {
  return `${omitted} applicable order(s) omitted to stay within the byte cap.\n`;
}

function checkText(order) {
  if (order.verification !== 'test') return 'backstop — no mechanical check; the verifier reports insufficient_spec';
  const rule = order.check_rule ? ` (rule ${line(order.check_rule)})` : '';
  return `${line(order.check_kind)} ${line(order.check_target)}${rule}`;
}

function scopeText(order) {
  const paths = order.scope.paths.map(line);
  const reqs = order.scope.requirements.map(line);
  if (paths.length === 0 && reqs.length === 0) return 'global (every phase)';
  return `paths [${paths.join(', ')}]; requirements [${reqs.join(', ')}]`;
}

function renderOrder(order) {
  return [
    `## ${line(order.id)} (${line(order.kind)}, ${line(order.verification)})`,
    `- Statement: ${line(order.statement)}`,
    `- Operation: ${line(order.operation)}`,
    `- Contexts: ${order.contexts.length === 0 ? 'all' : order.contexts.map(line).join(', ')}`,
    `- Scope: ${scopeText(order)}`,
    `- Check: ${checkText(order)}`,
    `- Source: ${line(order.source)}`,
    '',
    '',
  ].join('\n');
}

function byteLength(s) {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Render APPLICABLE.md within `maxBytes`.
 * @param {object[]} orders  already selected and ordered (see selectApplicable)
 * @param {{ maxBytes?: number, phase?: string }} options
 * @returns {{ text: string, included: string[], omitted: string[], bytes: number }}
 */
function renderApplicable(orders, options = {}) {
  const cap = typeof options.maxBytes === 'number' && Number.isFinite(options.maxBytes) ? Math.floor(options.maxBytes) : 0;
  const head = header(options.phase);
  const blocks = orders.map((o) => ({ id: o.id, text: renderOrder(o) }));
  const included = [];
  const omitted = [];
  let body = '';
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    // Worst case for the footer count: everything not yet included after this
    // block is omitted. A later inclusion only shrinks that number, so a block
    // that fits under this estimate always fits in the final text.
    const worstOmitted = omitted.length + (blocks.length - included.length - 1 - omitted.length);
    const candidate = byteLength(head) + byteLength(body) + byteLength(b.text) + byteLength(footer(worstOmitted));
    if (candidate <= cap) {
      body += b.text;
      included.push(b.id);
    } else {
      omitted.push(b.id);
    }
  }
  const text = head + body + footer(omitted.length);
  return { text, included, omitted, bytes: byteLength(text) };
}

module.exports = { normalizePath, globToRegExp, matchesScope, selectApplicable, renderApplicable };
