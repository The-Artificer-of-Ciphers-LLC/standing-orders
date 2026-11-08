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
 * The glob is matched segment by segment with a linear wildcard algorithm, not
 * a compiled RegExp: a hand-written scope like `*a*a*a*a*b`, or a run of ten
 * globstar segments, must never make selection hang (adversarial review of #2,
 * 2026-11-07). (Comment text here avoids the two-character comment terminator.)
 *
 * Rendering packs WHOLE orders, in a deterministic order (test tier before
 * backstop, then by id), into a UTF-8 byte budget, with a header that states the
 * orders apply IN ADDITION TO the phase's own must_haves (ADR-857 altitude
 * condition) and a footer that always states how many orders were omitted.
 */

const { projectionOf } = require('./phase.cjs');

/** Forward slashes, runs of slashes collapsed, every leading `./` removed. */
function normalizePath(p) {
  return String(p).replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^(\.\/)+/, '');
}

/**
 * Match one path segment against one glob segment where `*` matches any run of
 * characters (including none) and `?` exactly one. Two-pointer wildcard
 * matching: O(len(pattern) × len(segment)) worst case, no backtracking blow-up.
 */
function matchSegment(pattern, segment) {
  let p = 0;
  let s = 0;
  let star = -1;
  let mark = 0;
  while (s < segment.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === segment[s])) {
      p++;
      s++;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      mark = s;
    } else if (star !== -1) {
      p = star + 1;
      s = ++mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

/**
 * Compile a minimal glob into a matcher `{ test(path) }`.
 *   a segment that is exactly `**`  → zero or more whole segments (so a trailing
 *                                     `/**` matches the directory itself too)
 *   `*` inside a segment            → anything within that segment (`**` inside
 *                                     text behaves like `*`)
 *   `?`                             → exactly one character
 * Everything else is literal. Matching is anchored at both ends.
 */
function globToRegExp(glob) {
  const gsegs = normalizePath(glob).split('/').map((seg) => (seg === '**' ? seg : seg.replace(/\*{2,}/g, '*')));
  // Collapse consecutive `**` segments: they are equivalent and only cost time.
  const segs = gsegs.filter((seg, i) => !(seg === '**' && gsegs[i - 1] === '**'));

  function test(input) {
    const psegs = normalizePath(input).split('/');
    // dp[i][j]: glob segments [i..] match path segments [j..]
    const G = segs.length;
    const P = psegs.length;
    const dp = Array.from({ length: G + 1 }, () => new Array(P + 1).fill(false));
    dp[G][P] = true;
    for (let i = G - 1; i >= 0; i--) {
      for (let j = P; j >= 0; j--) {
        if (segs[i] === '**') {
          dp[i][j] = dp[i + 1][j] || (j < P && dp[i][j + 1]);
        } else {
          dp[i][j] = j < P && matchSegment(segs[i], psegs[j]) && dp[i + 1][j + 1];
        }
      }
    }
    return dp[0][0];
  }
  return { test, source: segs.join('/') };
}

/** Does the order's scope match any of the phase's files or requirement ids? Empty scope matches everything. */
function matchesScope(order, selection) {
  const sel = selection && typeof selection === 'object' ? selection : {};
  const files = Array.isArray(sel.files) ? sel.files.filter((f) => typeof f === 'string') : [];
  const requirements = Array.isArray(sel.requirements) ? sel.requirements : [];
  const paths = (order && order.scope && Array.isArray(order.scope.paths)) ? order.scope.paths : [];
  const reqs = (order && order.scope && Array.isArray(order.scope.requirements)) ? order.scope.requirements : [];
  if (paths.length === 0 && reqs.length === 0) return true;
  for (const glob of paths) {
    const matcher = globToRegExp(glob);
    if (files.some((f) => matcher.test(f))) return true;
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
  const orders = document && Array.isArray(document.orders) ? document.orders : [];
  return orders.filter((o) => matchesScope(o, selection)).sort(byTierThenId);
}

// ─── Rendering ────────────────────────────────────────────────────────────────

/**
 * Render a scalar on ONE line: every line terminator (LF, CR, CRLF, NEL, LS, PS)
 * becomes a space and every other C0/DEL control becomes U+FFFD, so a statement
 * can never start a new markdown line or section in APPLICABLE.md.
 */
// LF, CR, NEL, LS, PS — built from code points because LS/PS are themselves line
// terminators and cannot appear inside a regex literal.
const LINE_TERMINATORS_RE = new RegExp('[' + String.fromCharCode(0x0a, 0x0d, 0x85, 0x2028, 0x2029) + ']+', 'g');
// eslint-disable-next-line no-control-regex
const OTHER_CONTROLS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

function oneLine(value) {
  if (value === null || value === undefined) return '—';
  return String(value).replace(LINE_TERMINATORS_RE, ' ').replace(OTHER_CONTROLS_RE, REPLACEMENT_CHAR);
}

function header(phase) {
  const title = phase === undefined || phase === null || phase === '' ? '# Applicable standing orders' : `# Applicable standing orders — phase ${oneLine(phase)}`;
  return `${title}\n\nThese orders apply in addition to the phase's own must_haves, never instead of them. Cite each order id in must_haves; never list an order's check target in files_modified.\n\n`;
}

/** The footer never embeds the cap value, so its length depends only on the omitted count. */
function footer(omitted) {
  return `${omitted} applicable order(s) omitted to stay within the byte cap.\n`;
}

function checkText(order) {
  if (order.verification !== 'test') return 'backstop — no mechanical check; the verifier reports insufficient_spec';
  const rule = order.check_rule ? ` (rule ${oneLine(order.check_rule)})` : '';
  return `${oneLine(order.check_kind)} ${oneLine(order.check_target)}${rule}`;
}

function scopeText(order) {
  const scope = order.scope || { paths: [], requirements: [] };
  const paths = (scope.paths || []).map(oneLine);
  const reqs = (scope.requirements || []).map(oneLine);
  if (paths.length === 0 && reqs.length === 0) return 'global (every phase)';
  return `paths [${paths.join(', ')}]; requirements [${reqs.join(', ')}]`;
}

function renderOrder(order) {
  const contexts = Array.isArray(order.contexts) ? order.contexts : [];
  const projection = projectionOf(order);
  return [
    `## ${oneLine(order.id)} (${oneLine(order.kind)}, ${oneLine(order.verification)})`,
    `- Statement: ${oneLine(order.statement)}`,
    `- Operation: ${oneLine(order.operation)}`,
    `- Contexts: ${contexts.length === 0 ? 'all' : contexts.map(oneLine).join(', ')}`,
    `- Scope: ${scopeText(order)}`,
    `- Check: ${checkText(order)}`,
    `- Project as: must_haves.${projection.section} item ${oneLine(JSON.stringify(projection.item))}`,
    `- Source: ${oneLine(order.source)}`,
    '',
    '',
  ].join('\n');
}

function byteLength(s) {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Render APPLICABLE.md within `maxBytes` (`Infinity` means no cap; any other
 * non-finite or non-numeric cap is treated as zero room).
 * @param {object[]} orders  already selected and ordered (see selectApplicable)
 * @param {{ maxBytes?: number, phase?: string }} options
 * @returns {{ text: string, included: string[], omitted: string[], bytes: number }}
 */
function renderApplicable(orders, options = {}) {
  const raw = options.maxBytes;
  const cap = raw === Infinity ? Infinity : typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 0;
  const head = header(options.phase);
  const blocks = orders.map((o) => ({ id: o.id, text: renderOrder(o) }));
  const included = [];
  const omitted = [];
  let body = '';
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    // Worst case for the footer count: everything not yet included after this
    // block is omitted. A later inclusion only shrinks that number, so a block
    // that fits under this estimate always fits in the final text. The estimate
    // is never lossy either: it can overstate the footer by at most one digit,
    // while any later inclusion that would lower the count adds a whole block
    // (over 100 bytes of fixed skeleton), so a block refused here could not
    // have fit in any final text.
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

module.exports = { normalizePath, globToRegExp, matchesScope, selectApplicable, renderApplicable, oneLine };
