'use strict';

/**
 * lib/orders.cjs — parse and validate `ORDERS.yaml` (PRD-0001 R1–R4; ADR-0001 §3).
 *
 * The one boundary where human-authored YAML enters Standing Orders. It is
 * deliberately strict (Postel's law applied at the edge): unknown keys, unknown
 * enum values and an unsupported version are errors, every scalar stays a
 * string, and the document is treated as untrusted input exactly like gsd-core
 * treats `.planning/` frontmatter — anchors, aliases and merge keys are refused
 * before any expansion can happen.
 *
 * Pure: no I/O, never throws for bad input. `parseOrders(text)` returns
 *   { ok, document, errors, warnings }
 * where `document` is null unless `ok`, and every error/warning is
 *   { code, path, message }   (path is a JSONPath-ish locator, e.g. `$.orders[1].id`).
 *
 * Context resolution (confirmed with the maintainer 2026-11-07): every context
 * resolves to a closed set of LEAF contexts. A context with no members is a leaf
 * and resolves to {itself}. `includes: [x, y]` is the union of x's and y's leaf
 * sets; `extends: p` makes this context a member of p (the same membership edge,
 * written from the child's side). Cycles and undefined names are errors.
 */

const { load, FAILSAFE_SCHEMA } = require('./vendor/js-yaml.cjs');

// ─── Closed vocabularies ──────────────────────────────────────────────────────

const KINDS = Object.freeze(['prohibition', 'invariant', 'variant']);
const VERIFICATIONS = Object.freeze(['test', 'backstop']);
const CHECK_KINDS = Object.freeze(['node-test', 'lint-rule']);

const TOP_KEYS = Object.freeze(['version', 'contexts', 'orders']);
const CONTEXT_KEYS = Object.freeze(['description', 'includes', 'extends']);
const SCOPE_KEYS = Object.freeze(['paths', 'requirements']);
const ORDER_KEYS = Object.freeze([
  'id', 'kind', 'statement', 'operation', 'outcome', 'contexts', 'scope', 'verification',
  'check_kind', 'check_target', 'check_rule', 'check_violation_fixture', 'check_clean_fixture', 'source',
]);
const CHECK_KEYS = Object.freeze(['check_kind', 'check_target', 'check_rule', 'check_violation_fixture', 'check_clean_fixture']);

const SUPPORTED_VERSION = '1';
const CONTEXT_NAME_RE = /^[a-z][a-z0-9-]*$/;

/** Every code any Standing Orders surface can report (the router's file codes included, one vocabulary). */
const ERROR_CODES = Object.freeze({
  INPUT_NOT_STRING: 'input_not_string',
  YAML_ANCHOR_REFUSED: 'yaml_anchor_refused',
  YAML_NULL_BYTE: 'yaml_null_byte',
  YAML_SYNTAX: 'yaml_syntax',
  ROOT_NOT_MAPPING: 'root_not_mapping',
  VERSION_UNSUPPORTED: 'version_unsupported',
  UNKNOWN_KEY: 'unknown_key',
  UNKNOWN_KEY_FOR_KIND: 'unknown_key_for_kind',
  CONTEXTS_NOT_MAPPING: 'contexts_not_mapping',
  CONTEXT_NAME_INVALID: 'context_name_invalid',
  UNDEFINED_CONTEXT: 'undefined_context',
  CONTEXT_CYCLE: 'context_cycle',
  CONTEXT_TOO_DEEP: 'context_too_deep',
  ORDERS_NOT_LIST: 'orders_not_list',
  MISSING_FIELD: 'missing_field',
  DUPLICATE_ID: 'duplicate_id',
  ENUM_INVALID: 'enum_invalid',
  TYPE_INVALID: 'type_invalid',
  // warnings
  FIXTURE_MISSING: 'fixture_missing',
  CHECK_IGNORED_FOR_BACKSTOP: 'check_ignored_for_backstop',
  CHECK_TARGET_MISSING: 'check_target_missing',
  // router (file) codes
  PATH_OUTSIDE_CWD: 'path_outside_cwd',
  FILE_NOT_FOUND: 'file_not_found',
  FILE_UNREADABLE: 'file_unreadable',
  FILE_TOO_LARGE: 'file_too_large',
});

// ─── Small helpers ────────────────────────────────────────────────────────────

/** Thrown from inside the js-yaml listener; never escapes `refuseAnchorsAndAliases`. */
class AnchorDetectedSignal extends Error {}

/**
 * FAILSAFE: only str/seq/map, so every scalar is a string. `json: false` (unlike
 * gsd-core's frontmatter reader) makes a duplicated mapping key a parse ERROR
 * rather than last-wins: in a rule store, a second `orders:` key silently
 * replacing the first would make whole rule sets vanish.
 */
const YAML_LOAD_OPTS = Object.freeze({ schema: FAILSAFE_SCHEMA, json: false });

/** The leaf set of an order when the document declares no contexts at all: one universal context. */
const UNIVERSAL_CONTEXT = '*';

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function finding(code, path, message) {
  return { code, path, message };
}

/** True when `v` is a non-empty, non-whitespace string. */
function isText(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Refuse anchors, aliases and merge keys BEFORE the real parse (same posture as
 * gsd-core `src/frontmatter.cts` `refuseAnchorsAndAliases`). The listener throws
 * the moment js-yaml records an anchor, which aborts the parse before any alias
 * can be expanded — a billion-laughs document is refused in the time it takes to
 * read its first anchor, not after building the tree. Any other failure is left
 * for the real parse to report.
 */
function refuseAnchorsAndAliases(yaml) {
  try {
    load(yaml, {
      ...YAML_LOAD_OPTS,
      listener: (_event, state) => {
        if (state.anchor !== null && state.anchor !== undefined) throw new AnchorDetectedSignal();
      },
    });
    return false;
  } catch (e) {
    return e instanceof AnchorDetectedSignal;
  }
}

// ─── Context resolution ───────────────────────────────────────────────────────

/**
 * Resolve a validated context map to leaf sets.
 * `children[name]` is the set of direct members (from `includes` on the parent
 * and `extends` on the child). Returns { leafSets, allLeaves, cycles } where
 * `cycles` is an array of sorted member arrays, one per distinct cycle.
 */
function resolveContexts(children) {
  const names = Object.keys(children);
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = Object.create(null);
  const memo = Object.create(null);
  const cycleKeys = new Set();
  const cycles = [];
  const stack = [];
  for (const n of names) color[n] = WHITE;

  function visit(name) {
    if (color[name] === BLACK) return memo[name];
    if (color[name] === GRAY) {
      const start = stack.indexOf(name);
      const members = [...stack.slice(start)].sort();
      const key = members.join('\u0000');
      if (!cycleKeys.has(key)) {
        cycleKeys.add(key);
        cycles.push(members);
      }
      return new Set();
    }
    color[name] = GRAY;
    stack.push(name);
    const kids = [...children[name]].sort();
    let leaves;
    if (kids.length === 0) {
      leaves = new Set([name]);
    } else {
      leaves = new Set();
      for (const k of kids) for (const l of visit(k)) leaves.add(l);
    }
    stack.pop();
    color[name] = BLACK;
    memo[name] = leaves;
    return leaves;
  }

  for (const n of names) visit(n);

  const inCycle = new Set();
  for (const c of cycles) for (const m of c) inCycle.add(m);
  const leafSets = Object.create(null);
  for (const n of names) {
    if (!inCycle.has(n)) leafSets[n] = [...memo[n]].sort();
  }
  const allLeaves = names.filter((n) => children[n].size === 0 && !inCycle.has(n)).sort();
  return { leafSets, allLeaves, cycles };
}

// ─── Validation passes ────────────────────────────────────────────────────────

function validateContexts(raw, errors) {
  const contexts = Object.create(null);
  const children = Object.create(null);
  if (raw === undefined) return { contexts, children };
  if (!isPlainObject(raw)) {
    errors.push(finding(ERROR_CODES.CONTEXTS_NOT_MAPPING, '$.contexts', 'contexts must be a mapping of context name to definition'));
    return { contexts, children };
  }
  const names = Object.keys(raw);
  const defined = new Set(names.filter((n) => CONTEXT_NAME_RE.test(n)));
  for (const name of names) {
    const p = `$.contexts.${name}`;
    if (!CONTEXT_NAME_RE.test(name)) {
      errors.push(finding(ERROR_CODES.CONTEXT_NAME_INVALID, p, `context name ${JSON.stringify(name)} must match ${CONTEXT_NAME_RE}`));
      continue;
    }
    const def = raw[name];
    if (!isPlainObject(def)) {
      errors.push(finding(ERROR_CODES.TYPE_INVALID, p, 'a context definition must be a mapping (use {} for a plain leaf context)'));
      continue;
    }
    const out = { description: null, includes: [], extends: null };
    for (const k of Object.keys(def)) {
      if (!CONTEXT_KEYS.includes(k)) errors.push(finding(ERROR_CODES.UNKNOWN_KEY, `${p}.${k}`, `unknown context key ${JSON.stringify(k)}; allowed: ${CONTEXT_KEYS.join(', ')}`));
    }
    if (def.description !== undefined) {
      if (typeof def.description !== 'string') errors.push(finding(ERROR_CODES.TYPE_INVALID, `${p}.description`, 'description must be a string'));
      else out.description = def.description;
    }
    if (def.includes !== undefined) {
      if (!Array.isArray(def.includes)) {
        errors.push(finding(ERROR_CODES.TYPE_INVALID, `${p}.includes`, 'includes must be a list of context names'));
      } else {
        def.includes.forEach((m, i) => {
          if (typeof m !== 'string') errors.push(finding(ERROR_CODES.TYPE_INVALID, `${p}.includes[${i}]`, 'context names must be strings'));
          else if (!defined.has(m)) errors.push(finding(ERROR_CODES.UNDEFINED_CONTEXT, `${p}.includes[${i}]`, `context ${JSON.stringify(m)} is not defined`));
          else out.includes.push(m);
        });
      }
    }
    if (def.extends !== undefined) {
      if (typeof def.extends !== 'string') errors.push(finding(ERROR_CODES.TYPE_INVALID, `${p}.extends`, 'extends must be a context name'));
      else if (!defined.has(def.extends)) errors.push(finding(ERROR_CODES.UNDEFINED_CONTEXT, `${p}.extends`, `context ${JSON.stringify(def.extends)} is not defined`));
      else out.extends = def.extends;
    }
    contexts[name] = out;
  }
  for (const name of Object.keys(contexts)) children[name] = new Set();
  for (const [name, def] of Object.entries(contexts)) {
    for (const m of def.includes) children[name].add(m);
    if (def.extends !== null) children[def.extends].add(name);
  }
  return { contexts, children };
}

/** Read an optional scalar field; pushes `type_invalid` for a non-string or an empty string. Returns string or null. */
function optionalString(obj, key, p, errors) {
  if (obj[key] === undefined) return null;
  if (!isText(obj[key])) {
    errors.push(finding(ERROR_CODES.TYPE_INVALID, `${p}.${key}`, `${key} must be a non-empty string`));
    return null;
  }
  return obj[key];
}

/** Read a required scalar field; pushes `missing_field` or `type_invalid`. Returns string or null. */
function requiredString(obj, key, p, errors) {
  if (obj[key] === undefined) {
    errors.push(finding(ERROR_CODES.MISSING_FIELD, `${p}.${key}`, `${key} is required`));
    return null;
  }
  return optionalString(obj, key, p, errors);
}

function stringList(obj, key, p, errors) {
  if (obj[key] === undefined) return [];
  if (!Array.isArray(obj[key])) {
    errors.push(finding(ERROR_CODES.TYPE_INVALID, `${p}.${key}`, `${key} must be a list of strings`));
    return [];
  }
  const out = [];
  obj[key].forEach((v, i) => {
    if (!isText(v)) errors.push(finding(ERROR_CODES.TYPE_INVALID, `${p}.${key}[${i}]`, `${key} entries must be non-empty strings`));
    else out.push(v);
  });
  return out;
}

function validateOrder(rawOrder, index, definedContexts, seenIds, errors, warnings) {
  const p = `$.orders[${index}]`;
  if (!isPlainObject(rawOrder)) {
    errors.push(finding(ERROR_CODES.TYPE_INVALID, p, 'an order must be a mapping'));
    return null;
  }
  for (const k of Object.keys(rawOrder)) {
    if (!ORDER_KEYS.includes(k)) errors.push(finding(ERROR_CODES.UNKNOWN_KEY, `${p}.${k}`, `unknown order key ${JSON.stringify(k)}; allowed: ${ORDER_KEYS.join(', ')}`));
  }

  const id = requiredString(rawOrder, 'id', p, errors);
  if (id !== null) {
    if (seenIds.has(id)) errors.push(finding(ERROR_CODES.DUPLICATE_ID, `${p}.id`, `order id ${JSON.stringify(id)} is already defined`));
    else seenIds.add(id);
  }

  const kind = requiredString(rawOrder, 'kind', p, errors);
  if (kind !== null && !KINDS.includes(kind)) errors.push(finding(ERROR_CODES.ENUM_INVALID, `${p}.kind`, `kind must be one of ${KINDS.join(', ')} (got ${JSON.stringify(kind)})`));

  const statement = requiredString(rawOrder, 'statement', p, errors);

  const operation = optionalString(rawOrder, 'operation', p, errors);
  let outcome = null;
  if (kind === 'variant') {
    if (rawOrder.operation === undefined) errors.push(finding(ERROR_CODES.MISSING_FIELD, `${p}.operation`, 'a variant requires operation'));
    outcome = requiredString(rawOrder, 'outcome', p, errors);
  } else if (rawOrder.outcome !== undefined) {
    errors.push(finding(ERROR_CODES.UNKNOWN_KEY_FOR_KIND, `${p}.outcome`, 'outcome is only valid on a variant'));
  }

  const contexts = [];
  if (rawOrder.contexts !== undefined) {
    if (!Array.isArray(rawOrder.contexts)) {
      errors.push(finding(ERROR_CODES.TYPE_INVALID, `${p}.contexts`, 'contexts must be a list of context names'));
    } else {
      rawOrder.contexts.forEach((c, i) => {
        if (typeof c !== 'string') errors.push(finding(ERROR_CODES.TYPE_INVALID, `${p}.contexts[${i}]`, 'context names must be strings'));
        else if (!definedContexts.has(c)) errors.push(finding(ERROR_CODES.UNDEFINED_CONTEXT, `${p}.contexts[${i}]`, `context ${JSON.stringify(c)} is not defined`));
        else if (!contexts.includes(c)) contexts.push(c);
      });
    }
  }

  const scope = { paths: [], requirements: [] };
  if (rawOrder.scope !== undefined) {
    if (!isPlainObject(rawOrder.scope)) {
      errors.push(finding(ERROR_CODES.TYPE_INVALID, `${p}.scope`, 'scope must be a mapping with paths and/or requirements'));
    } else {
      for (const k of Object.keys(rawOrder.scope)) {
        if (!SCOPE_KEYS.includes(k)) errors.push(finding(ERROR_CODES.UNKNOWN_KEY, `${p}.scope.${k}`, `unknown scope key ${JSON.stringify(k)}; allowed: ${SCOPE_KEYS.join(', ')}`));
      }
      scope.paths = stringList(rawOrder.scope, 'paths', `${p}.scope`, errors);
      scope.requirements = stringList(rawOrder.scope, 'requirements', `${p}.scope`, errors);
    }
  }

  const verification = requiredString(rawOrder, 'verification', p, errors);
  if (verification !== null && !VERIFICATIONS.includes(verification)) {
    errors.push(finding(ERROR_CODES.ENUM_INVALID, `${p}.verification`, `verification must be one of ${VERIFICATIONS.join(', ')} (got ${JSON.stringify(verification)})`));
  }

  const check = {};
  for (const k of CHECK_KEYS) check[k] = optionalString(rawOrder, k, p, errors);

  if (verification === 'test') {
    for (const k of ['check_kind', 'check_target']) {
      if (rawOrder[k] === undefined) errors.push(finding(ERROR_CODES.MISSING_FIELD, `${p}.${k}`, `a test-tier order requires ${k}`));
    }
    if (check.check_kind !== null && !CHECK_KINDS.includes(check.check_kind)) {
      errors.push(finding(ERROR_CODES.ENUM_INVALID, `${p}.check_kind`, `check_kind must be one of ${CHECK_KINDS.join(', ')} (got ${JSON.stringify(check.check_kind)})`));
    }
    if (check.check_kind === 'lint-rule' && rawOrder.check_rule === undefined) {
      errors.push(finding(ERROR_CODES.MISSING_FIELD, `${p}.check_rule`, 'a lint-rule check requires check_rule'));
    }
    for (const k of ['check_violation_fixture', 'check_clean_fixture']) {
      if (rawOrder[k] === undefined) {
        warnings.push(finding(ERROR_CODES.FIXTURE_MISSING, `${p}.${k}`, `${k} is absent; the fail-first prover cannot prove this check and will report it flagged`));
      }
    }
  } else if (verification === 'backstop') {
    for (const k of CHECK_KEYS) {
      if (rawOrder[k] !== undefined) warnings.push(finding(ERROR_CODES.CHECK_IGNORED_FOR_BACKSTOP, `${p}.${k}`, `${k} is ignored on a backstop order (no mechanical check runs)`));
    }
  }

  const source = optionalString(rawOrder, 'source', p, errors);

  return {
    id, kind, statement, operation, outcome, contexts, scope, verification,
    check_kind: check.check_kind,
    check_target: check.check_target,
    check_rule: check.check_rule,
    check_violation_fixture: check.check_violation_fixture,
    check_clean_fixture: check.check_clean_fixture,
    source,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse and validate ORDERS.yaml text.
 * @param {string} text
 * @returns {{ ok: boolean, document: object|null, errors: object[], warnings: object[] }}
 */
function parseOrders(text) {
  const errors = [];
  const warnings = [];
  const fail = (code, path, message) => {
    errors.push(finding(code, path, message));
    return { ok: false, document: null, errors, warnings };
  };

  if (typeof text !== 'string') return fail(ERROR_CODES.INPUT_NOT_STRING, '$', 'ORDERS.yaml content must be a string');

  let src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  src = src.replace(/\r\n?/g, '\n');
  if (src.includes('\u0000')) return fail(ERROR_CODES.YAML_NULL_BYTE, '$', 'ORDERS.yaml contains a NUL byte');

  if (refuseAnchorsAndAliases(src)) {
    return fail(ERROR_CODES.YAML_ANCHOR_REFUSED, '$', 'YAML anchors, aliases and merge keys are refused in ORDERS.yaml');
  }

  let raw;
  try {
    raw = load(src, YAML_LOAD_OPTS);
  } catch (e) {
    const msg = e && typeof e.message === 'string' ? e.message : String(e);
    return fail(ERROR_CODES.YAML_SYNTAX, '$', `ORDERS.yaml is not valid YAML: ${msg}`);
  }
  if (!isPlainObject(raw)) {
    const why = raw === undefined ? 'the file is empty' : `the root is ${Array.isArray(raw) ? 'a list' : typeof raw === 'string' ? 'a string' : String(raw)}`;
    return fail(ERROR_CODES.ROOT_NOT_MAPPING, '$', `ORDERS.yaml must be a mapping at the root; ${why}`);
  }

  for (const k of Object.keys(raw)) {
    if (!TOP_KEYS.includes(k)) errors.push(finding(ERROR_CODES.UNKNOWN_KEY, `$.${k}`, `unknown top-level key ${JSON.stringify(k)}; allowed: ${TOP_KEYS.join(', ')}`));
  }
  if (raw.version !== SUPPORTED_VERSION) {
    errors.push(finding(ERROR_CODES.VERSION_UNSUPPORTED, '$.version', `version must be ${SUPPORTED_VERSION} (got ${raw.version === undefined ? 'nothing' : JSON.stringify(raw.version)})`));
  }

  const { contexts, children } = validateContexts(raw.contexts, errors);
  let resolved;
  try {
    resolved = resolveContexts(children);
  } catch (e) {
    // Only a pathological membership chain (thousands deep) can exhaust the stack; never throw.
    if (!(e instanceof RangeError)) throw e;
    errors.push(finding(ERROR_CODES.CONTEXT_TOO_DEEP, '$.contexts', 'the context membership chain is too deep to resolve'));
    resolved = { leafSets: Object.create(null), allLeaves: [], cycles: [] };
  }
  for (const members of resolved.cycles) {
    const err = finding(ERROR_CODES.CONTEXT_CYCLE, `$.contexts.${members[0]}`, `contexts form a cycle: ${members.join(' -> ')}`);
    err.members = members;
    errors.push(err);
  }
  const definedContexts = new Set(Object.keys(contexts));

  const orders = [];
  if (raw.orders !== undefined) {
    if (!Array.isArray(raw.orders)) {
      errors.push(finding(ERROR_CODES.ORDERS_NOT_LIST, '$.orders', 'orders must be a list'));
    } else {
      const seen = new Set();
      raw.orders.forEach((o, i) => {
        const normalized = validateOrder(o, i, definedContexts, seen, errors, warnings);
        if (normalized !== null) orders.push(normalized);
      });
    }
  }

  if (errors.length > 0) return { ok: false, document: null, errors, warnings };

  const document = {
    version: SUPPORTED_VERSION,
    contexts: { ...contexts },
    orders,
    leafSets: { ...resolved.leafSets },
    allLeaves: resolved.allLeaves,
  };
  return { ok: true, document, errors, warnings };
}

/**
 * The leaf contexts an order effectively applies in: the union of its named
 * contexts' leaf sets, or every leaf when it names none. A document that
 * declares no contexts has one universal leaf (`*`), so orders in it still
 * overlap one another (adversarial review of #2: an empty leaf set made every
 * conflict undetectable).
 * @returns {string[]} sorted, unique
 */
function effectiveLeaves(order, document) {
  const allLeaves = Array.isArray(document.allLeaves) && document.allLeaves.length > 0 ? document.allLeaves : [UNIVERSAL_CONTEXT];
  if (!order.contexts || order.contexts.length === 0) return [...allLeaves];
  const out = new Set();
  for (const c of order.contexts) for (const l of (document.leafSets && document.leafSets[c]) || []) out.add(l);
  return [...out].sort();
}

module.exports = {
  parseOrders,
  effectiveLeaves,
  KINDS,
  VERIFICATIONS,
  CHECK_KINDS,
  ORDER_KEYS,
  CONTEXT_KEYS,
  SCOPE_KEYS,
  ERROR_CODES,
  SUPPORTED_VERSION,
  UNIVERSAL_CONTEXT,
};
