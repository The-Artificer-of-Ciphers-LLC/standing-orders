'use strict';

/**
 * lib/semantic.cjs -- the semantic-conflict ledger (PRD-0001 R8; ADR-0001 section 5; ADR-550 D2/D5).
 *
 * An LLM pass proposes findings (orders that contradict each other or the spec); a
 * human confirms or dismisses each one. This module is the contract around that
 * judgment, not the judgment: findings are validated, ids are monotonic, a
 * dismissal needs a reason, and an unattended (`auto`) run may only propose.
 *
 * Pure: every function takes its inputs as arguments and never throws for bad
 * input. The router owns the file.
 */

const { isPlainObject, normalizeWs } = require('./util.cjs');

const SEMANTIC_FILE = 'STANDING-ORDERS-SEMANTIC.json';
const SEMANTIC_SCHEMA = 1;
const FINDING_STATUSES = Object.freeze(['unresolved', 'resolved', 'dismissed']);
const MAX_FINDINGS_PER_CALL = 50;
const MAX_TEXT_CHARS = 1000;
const MAX_SEMANTIC_BYTES = 4 * 1024 * 1024;
const FINDING_ID_RE = /^S-[1-9][0-9]{0,5}$/;
const MAX_FINDING_NUMBER = 999999;
const SEMANTIC_CODES = Object.freeze({
  REASON_REQUIRED: 'reason_required',
  AUTO_NEVER_DISMISSES: 'auto_never_dismisses',
  AUTO_CANNOT_CONFIRM: 'auto_cannot_confirm',
  FINDING_NOT_FOUND: 'finding_not_found',
  UNKNOWN_ORDER: 'unknown_order',
  TOO_MANY_FINDINGS: 'too_many_findings',
  INVALID_FINDING: 'invalid_finding',
  SEMANTIC_UNUSABLE: 'semantic_unusable',
});
const FINDING_KEYS = Object.freeze(['id', 'orders', 'statement', 'status', 'reason', 'proposed_by', 'resolved_by', 'ts']);
const PROPOSAL_KEYS = Object.freeze(['orders', 'statement']);

const blank = (v) => typeof v !== 'string' || v.trim() === '';

/** A new, empty ledger for a phase directory. */
function emptyDocument(phase) {
  return { schema: SEMANTIC_SCHEMA, phase, findings: [] };
}

/** Problems with one finding (an empty list means valid). */
function validateFinding(f, index) {
  const at = `findings[${index}]`;
  if (!isPlainObject(f)) return [`${at} is not an object`];
  const problems = [];
  for (const key of Object.keys(f)) if (!FINDING_KEYS.includes(key)) problems.push(`${at} has an unknown key ${JSON.stringify(key)}`);
  if (typeof f.id !== 'string' || !FINDING_ID_RE.test(f.id)) problems.push(`${at}.id must look like S-1`);
  if (!Array.isArray(f.orders) || f.orders.length === 0 || f.orders.some(blank)) problems.push(`${at}.orders must be a non-empty list of order ids`);
  if (blank(f.statement) || f.statement.length > MAX_TEXT_CHARS) problems.push(`${at}.statement must be 1 to ${MAX_TEXT_CHARS} characters`);
  if (!FINDING_STATUSES.includes(f.status)) problems.push(`${at}.status must be one of ${FINDING_STATUSES.join(', ')}`);
  if (f.reason !== null && f.reason !== undefined && (typeof f.reason !== 'string' || f.reason.length > MAX_TEXT_CHARS)) {
    problems.push(`${at}.reason must be null or a string of at most ${MAX_TEXT_CHARS} characters`);
  }
  if (f.status === 'dismissed' && blank(f.reason)) problems.push(`${at}: a dismissed finding needs a reason`);
  if (f.proposed_by !== 'agent' && f.proposed_by !== 'auto') problems.push(`${at}.proposed_by must be agent or auto`);
  if (f.resolved_by !== null && f.resolved_by !== undefined && f.resolved_by !== 'human') problems.push(`${at}.resolved_by must be null or human`);
  if (typeof f.ts !== 'string') problems.push(`${at}.ts must be a string`);
  return problems;
}

/** Parse and validate the ledger text. */
function parseSemantic(text) {
  const unusable = (message, problems) => ({ ok: false, code: SEMANTIC_CODES.SEMANTIC_UNUSABLE, message, problems });
  let value;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return unusable('the semantic file is not valid JSON', []);
  }
  if (!isPlainObject(value)) return unusable('the semantic file is not a JSON object', []);
  const problems = [];
  if (value.schema !== SEMANTIC_SCHEMA) problems.push(`schema must be ${SEMANTIC_SCHEMA}`);
  if (typeof value.phase !== 'string') problems.push('phase must be a string');
  if (!Array.isArray(value.findings)) problems.push('findings must be a list');
  else {
    const seen = new Set();
    value.findings.forEach((f, i) => {
      problems.push(...validateFinding(f, i));
      if (isPlainObject(f) && typeof f.id === 'string') {
        if (seen.has(f.id)) problems.push(`findings[${i}].id ${f.id} is a duplicate`);
        seen.add(f.id);
      }
    });
  }
  if (problems.length > 0) return unusable(`the semantic file is not valid: ${problems[0]}`, problems);
  return { ok: true, document: value };
}

const refuse = (code, message) => ({ ok: false, code, message });

/** The problem with one proposal, or null. */
function proposalProblem(p, index) {
  if (!isPlainObject(p)) return `proposal ${index} is not an object`;
  for (const key of Object.keys(p)) if (!PROPOSAL_KEYS.includes(key)) return `proposal ${index} has an unknown key ${JSON.stringify(key)}`;
  if (!Array.isArray(p.orders) || p.orders.length === 0 || p.orders.some(blank)) return `proposal ${index}: orders must be a non-empty list of order ids`;
  if (blank(p.statement) || p.statement.length > MAX_TEXT_CHARS) return `proposal ${index}: statement must be 1 to ${MAX_TEXT_CHARS} characters`;
  return null;
}

/** Add proposed findings (unresolved). The whole call is refused if any proposal is unusable. */
function proposeFindings({ document, proposals, knownIds, auto, ts }) {
  if (!Array.isArray(proposals) || proposals.length === 0) return refuse(SEMANTIC_CODES.INVALID_FINDING, 'give a non-empty list of findings');
  if (proposals.length > MAX_FINDINGS_PER_CALL) {
    return refuse(SEMANTIC_CODES.TOO_MANY_FINDINGS, `at most ${MAX_FINDINGS_PER_CALL} findings per call; got ${proposals.length}`);
  }
  for (let i = 0; i < proposals.length; i += 1) {
    const problem = proposalProblem(proposals[i], i);
    if (problem !== null) return refuse(SEMANTIC_CODES.INVALID_FINDING, problem);
  }
  const unknown = [];
  for (const p of proposals) for (const id of p.orders) if (!knownIds.has(id) && !unknown.includes(id)) unknown.push(id);
  if (unknown.length > 0) return refuse(SEMANTIC_CODES.UNKNOWN_ORDER, `no such order in ORDERS.yaml: ${unknown.join(', ')}`);

  const keyOf = (orders, statement) => JSON.stringify([[...orders].sort(), normalizeWs(statement)]);
  const seen = new Set(document.findings.map((f) => keyOf(f.orders, f.statement)));
  let next = 1;
  for (const f of document.findings) {
    const m = /^S-([0-9]+)$/.exec(f.id);
    if (m) next = Math.max(next, Number(m[1]) + 1);
  }
  const findings = [...document.findings];
  const added = [];
  const duplicates = [];
  proposals.forEach((p, i) => {
    const orders = [...new Set(p.orders)];
    const key = keyOf(orders, p.statement);
    if (seen.has(key)) {
      duplicates.push(i);
      return;
    }
    seen.add(key);
    const id = `S-${next}`;
    next += 1;
    added.push(id);
    findings.push({
      id,
      orders,
      statement: p.statement.trim(),
      status: 'unresolved',
      reason: null,
      proposed_by: auto ? 'auto' : 'agent',
      resolved_by: null,
      ts,
    });
  });
  if (next - 1 > MAX_FINDING_NUMBER) return refuse(SEMANTIC_CODES.INVALID_FINDING, 'the finding id space is exhausted');
  return { ok: true, document: { ...document, findings }, added, duplicates };
}

/** Decide one finding. Only a human decides: `auto` may not dismiss, confirm or defer. */
function resolveFinding({ document, id, status, reason, auto, ts }) {
  if (!FINDING_STATUSES.includes(status)) return refuse('usage', `status must be one of ${FINDING_STATUSES.join(', ')}`);
  if (auto && status === 'dismissed') return refuse(SEMANTIC_CODES.AUTO_NEVER_DISMISSES, 'an unattended (--auto) run never dismisses a finding; a human must');
  if (auto) return refuse(SEMANTIC_CODES.AUTO_CANNOT_CONFIRM, 'an unattended (--auto) run cannot confirm or defer a finding; a human must');
  const index = document.findings.findIndex((f) => f.id === id);
  if (index === -1) return refuse(SEMANTIC_CODES.FINDING_NOT_FOUND, `no finding ${JSON.stringify(id)} in the semantic file`);
  const note = typeof reason === 'string' ? reason.trim() : '';
  if (status === 'dismissed' && note === '') return refuse(SEMANTIC_CODES.REASON_REQUIRED, 'dismissing a finding needs a non-empty --reason');
  if (note.length > MAX_TEXT_CHARS) return refuse(SEMANTIC_CODES.INVALID_FINDING, `the reason is longer than ${MAX_TEXT_CHARS} characters`);
  const decided = status !== 'unresolved';
  const finding = {
    ...document.findings[index],
    status,
    reason: decided && note !== '' ? note : null,
    resolved_by: decided ? 'human' : null,
    ts,
  };
  const findings = document.findings.map((f, i) => (i === index ? finding : f));
  return { ok: true, document: { ...document, findings }, finding };
}

/** How many findings are in each status. */
function countFindings(document) {
  const counts = { unresolved: 0, resolved: 0, dismissed: 0 };
  for (const f of document.findings) if (Object.prototype.hasOwnProperty.call(counts, f.status)) counts[f.status] += 1;
  return counts;
}

/** The ledger as file text. */
function serializeSemantic(document) {
  return JSON.stringify(document, null, 2) + '\n';
}

module.exports = {
  SEMANTIC_FILE,
  SEMANTIC_SCHEMA,
  FINDING_STATUSES,
  MAX_FINDINGS_PER_CALL,
  MAX_TEXT_CHARS,
  MAX_SEMANTIC_BYTES,
  FINDING_ID_RE,
  SEMANTIC_CODES,
  emptyDocument,
  validateFinding,
  parseSemantic,
  proposeFindings,
  resolveFinding,
  countFindings,
  serializeSemantic,
};
