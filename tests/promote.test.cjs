'use strict';

// Phase 5 (#6): lib/promote.cjs, the pure half of promotion. Test names follow
// .gsd/phase/feat-6-promotion-llm-conflicts/50-test-matrix.md (rows 1-28).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parseOrders } = require('../lib/orders.cjs');
const { orderHash } = require('../lib/trace.cjs');
const { doc, order } = require('./helpers/fixtures.cjs');

// Resolved on first use, so while lib/promote.cjs does not exist every test fails on its own.
const P = new Proxy({}, { get: (_, key) => require('../lib/promote.cjs')[key] });

const WARN = String.fromCharCode(0x26a0);
const LABEL = '03-SPEC.md';
const CONTEXT_LABEL = '03-CONTEXT.md';
const NEW_ORDER = Object.freeze({ id: 'NEW-1', kind: 'invariant', statement: 'New rule.', verification: 'backstop' });
const ITEM_NEW = '  - id: "NEW-1"\n    kind: "invariant"\n    statement: "New rule."\n    verification: "backstop"\n';
const BIG = 1024 * 1024;

/** A SPEC.md with decoy tables around the Prohibitions section (the decoys carry `resolved` rows that must never be read). */
function spec(rows, eol = '\n') {
  return [
    '# Phase 3 spec',
    '',
    '## Acceptance',
    '',
    '| Criterion | Requirement | Status |',
    '|---|---|---|',
    '| Refunds are exact | BILL-04 | resolved |',
    '',
    '## Prohibitions (must-NOT)',
    '',
    '| statement | Requirement | Status | Verification / Reason |',
    '|---|---|---|---|',
    ...rows,
    '',
    '## Ambiguity Report',
    '',
    '| Dimension | Score | Status |',
    '|---|---|---|',
    '| Goal clarity | 0.9 | resolved |',
    '',
  ].join(eol);
}

const row = (statement, req, status, how) => `| ${statement} | ${req} | ${status} | ${how} |`;

/** A CONTEXT.md with decisions inside and outside the block. */
function context(eol = '\n') {
  return [
    '# Phase 3 context',
    '',
    '- **D-09:** A decision line outside the block is not a decision.',
    '',
    '<decisions>',
    '## Implementation Decisions',
    '',
    '- **D-01:** Refunds go through the ledger service.',
    'a plain line between decisions',
    '* **D-02:** Amounts are integer cents.',
    '</decisions>',
    '',
    '- **D-10:** Also outside.',
    '',
  ].join(eol);
}

describe('promote: SPEC.md prohibitions', () => {
  it('specKeepsOnlyResolvedRows', () => {
    const text = spec([
      row('A refund is never executed twice.', 'BILL-04', 'resolved', 'test: tests/billing/refund.test.cjs'),
      row('Never refund after 90 days.', 'BILL-05', 'dismissed', 'out of scope'),
      row('Never email card numbers.', 'BILL-06', `${WARN} UNRESOLVED`, ''),
    ]);
    assert.deepEqual(P.specProhibitions(text, LABEL), [
      {
        origin: 'spec-prohibition',
        source: '03-SPEC.md prohibition 1',
        statement: 'A refund is never executed twice.',
        requirements: ['BILL-04'],
        verification: 'test',
      },
    ]);
    // the label counts data rows, so it survives a later dismissal of an earlier row
    const later = P.specProhibitions(spec([row('Never X.', 'n/a', 'dismissed', 'no'), row('Never Y.', 'n/a', 'resolved', 'judgment')]), LABEL);
    assert.equal(later.length, 1);
    assert.equal(later[0].source, '03-SPEC.md prohibition 2');
    assert.equal(P.specProhibitions(spec([row('Never Z.', 'n/a', 'RESOLVED', 'x')]), LABEL).length, 1, 'status is case-insensitive');
  });

  it('specSkipsHeaderSeparatorPlaceholder', () => {
    const text = spec([row('[MUST NOT ... one line]', '[REQ-ID]', 'resolved', '[test or judgment]'), row('Prohibition', 'Req', 'resolved', 'x')]);
    assert.deepEqual(P.specProhibitions(text, LABEL), []);
    assert.deepEqual(P.specProhibitions(spec([]), LABEL), []);
  });

  it('specReadsOnlyProhibitionsSection', () => {
    const rows = [row('Never double refund.', 'BILL-04', 'resolved', 'test')];
    const found = P.specProhibitions(spec(rows), LABEL);
    assert.deepEqual(found.map((c) => c.statement), ['Never double refund.'], 'Acceptance and Ambiguity rows are not prohibitions');
    const noSection = ['# Spec', '', '## Acceptance', '', '| a | b | c |', '|---|---|---|', '| Refunds are exact | BILL-04 | resolved |', ''].join('\n');
    assert.deepEqual(P.specProhibitions(noSection, LABEL), []);
    assert.deepEqual(P.specProhibitions('', LABEL), []);
  });

  it('splitTableRowKeepsEscapedPipe', () => {
    assert.deepEqual(P.splitTableRow('| a \\| b | c |'), ['a | b', 'c']);
    assert.deepEqual(P.splitTableRow('  | a | b |  '), ['a', 'b']);
    assert.deepEqual(P.splitTableRow('| a | |'), ['a', '']);
    assert.equal(P.splitTableRow('not a row'), null);
    assert.equal(P.splitTableRow('| unterminated'), null);
    assert.equal(P.splitTableRow('unstarted |'), null);
    const found = P.specProhibitions(spec([row('Never write \\| to logs.', 'n/a', 'resolved', 'judgment')]), LABEL);
    assert.equal(found[0].statement, 'Never write | to logs.');
  });

  it('specRequirementTokens', () => {
    const reqs = (cell) => P.specProhibitions(spec([row('Never A.', cell, 'resolved', 'x')]), LABEL)[0].requirements;
    assert.deepEqual(reqs('BILL-04, BILL-05'), ['BILL-04', 'BILL-05']);
    assert.deepEqual(reqs('BILL-04 BILL-05'), ['BILL-04', 'BILL-05']);
    assert.deepEqual(reqs('n/a'), []);
    assert.deepEqual(reqs('bill-04'), [], 'ids are upper-case');
    assert.deepEqual(reqs(''), []);
  });

  it('specJudgmentBecomesBackstop', () => {
    const how = (cell) => P.specProhibitions(spec([row('Never A.', 'n/a', 'resolved', cell)]), LABEL)[0].verification;
    assert.equal(how('judgment: reviewed by hand'), 'backstop');
    assert.equal(how('test: tests/a.test.cjs'), 'test');
    assert.equal(how('Test'), 'test');
    assert.equal(how('latest release notes'), 'backstop', 'the word test, not a substring');
    assert.equal(how(''), 'backstop');
    const threeCells = ['## Prohibitions', '', '| statement | Requirement | Status |', '|---|---|---|', '| Never A. | n/a | resolved |', ''].join('\n');
    assert.equal(P.specProhibitions(threeCells, LABEL)[0].verification, 'backstop', 'a missing fourth cell is backstop');
  });
});

describe('promote: CONTEXT.md decisions', () => {
  it('contextReadsOnlyDecisionsBlock', () => {
    assert.deepEqual(P.contextDecisions(context(), CONTEXT_LABEL), [
      { origin: 'context-decision', source: '03-CONTEXT.md D-01', statement: 'Refunds go through the ledger service.', requirements: [], verification: 'backstop' },
      { origin: 'context-decision', source: '03-CONTEXT.md D-02', statement: 'Amounts are integer cents.', requirements: [], verification: 'backstop' },
    ]);
    assert.deepEqual(P.contextDecisions('- **D-01:** Outside any block.\n', CONTEXT_LABEL), []);
    assert.deepEqual(P.contextDecisions('', CONTEXT_LABEL), []);
    const twice = '<decisions>\n- **D-01:** One.\n</decisions>\ntext\n<decisions>\n- **D-02:** Two.\n</decisions>\n';
    assert.deepEqual(P.contextDecisions(twice, CONTEXT_LABEL).map((c) => c.source), ['03-CONTEXT.md D-01', '03-CONTEXT.md D-02']);
  });

  it('crlfSameAsLf', () => {
    const rows = [row('Never A.', 'BILL-04', 'resolved', 'test'), row('Never B.', 'n/a', 'resolved', 'judgment')];
    const lf = P.specProhibitions(spec(rows), LABEL);
    assert.equal(lf.length, 2);
    assert.deepEqual(P.specProhibitions(spec(rows, '\r\n'), LABEL), lf);
    assert.deepEqual(P.specProhibitions(spec(rows, '\r'), LABEL), lf);
    const ctx = P.contextDecisions(context(), CONTEXT_LABEL);
    assert.equal(ctx.length, 2);
    assert.deepEqual(P.contextDecisions(context('\r\n'), CONTEXT_LABEL), ctx);
    assert.deepEqual(P.contextDecisions(context('\r'), CONTEXT_LABEL), ctx);
  });

  it('specFileNameExcludesUiAndAi', () => {
    for (const name of ['SPEC.md', '03-SPEC.md', '03-billing-SPEC.md']) assert.equal(P.isSpecFileName(name), true, name);
    for (const name of ['UI-SPEC.md', '03-UI-SPEC.md', 'AI-SPEC.md', '03-AI-SPEC.md', 'SPEC.md.bak', 'NOTSPEC.md', 'spec.md', 'SPEC.txt', '']) {
      assert.equal(P.isSpecFileName(name), false, name);
    }
    for (const name of ['CONTEXT.md', '03-CONTEXT.md']) assert.equal(P.isContextFileName(name), true, name);
    for (const name of ['03-CONTEXT.md.bak', 'NOCONTEXT.md', 'context.md', '03-CONTEXTS.md', '']) assert.equal(P.isContextFileName(name), false, name);
  });
});

describe('promote: marking and capping candidates', () => {
  const parsedDoc = (orders) => {
    const r = parseOrders(doc({ orders }));
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    return r.document;
  };
  const candidate = (source, statement) => ({ origin: 'spec-prohibition', source, statement, requirements: [], verification: 'backstop' });

  it('markPromotedBySourceOrStatement', () => {
    const document = parsedDoc([
      order({ id: 'BY-SOURCE', statement: 'Reworded entirely.', source: '03-SPEC.md prohibition 1' }),
      order({ id: 'BY-STATEMENT', statement: 'Never double refund.' }),
    ]);
    const input = [
      candidate('03-SPEC.md prohibition 1', 'Original wording.'),
      candidate('03-SPEC.md prohibition 2', '  Never   double\trefund.  '),
      candidate('03-SPEC.md prohibition 3', 'Something else entirely.'),
    ];
    const snapshot = JSON.parse(JSON.stringify(input));
    const out = P.markPromoted(input, document);
    assert.deepEqual(input, snapshot, 'input is not mutated');
    assert.deepEqual(out.map((c) => [c.already_promoted, c.promoted_as]), [[true, 'BY-SOURCE'], [true, 'BY-STATEMENT'], [false, null]]);
    assert.deepEqual(out.map((c) => c.statement), input.map((c) => c.statement), 'the candidate text is kept as is');
  });

  it('markPromotedFirstMatchWins', () => {
    const document = parsedDoc([order({ id: 'FIRST', statement: 'Same words.' }), order({ id: 'SECOND', statement: 'Same words.' })]);
    assert.equal(P.markPromoted([candidate('s', 'Same words.')], document)[0].promoted_as, 'FIRST');
  });

  it('markPromotedUnusableIsNull', () => {
    const out = P.markPromoted([candidate('a', 'x'), candidate('b', 'y')], null);
    assert.deepEqual(out.map((c) => [c.already_promoted, c.promoted_as]), [[null, null], [null, null]]);
  });

  it('candidatesCapBoundary', () => {
    const decisions = (n) => ({
      name: '03-CONTEXT.md',
      label: '03-CONTEXT.md',
      text: ['<decisions>', ...Array.from({ length: n }, (_, i) => `- **D-${i + 1}:** Decision number ${i + 1}.`), '</decisions>', ''].join('\n'),
    });
    for (const [n, length, truncated] of [[199, 199, false], [200, 200, false], [201, 200, true]]) {
      const out = P.buildCandidates({ files: [decisions(n)], document: null });
      assert.equal(out.candidates.length, length, `n=${n}`);
      assert.equal(out.truncated, truncated, `n=${n}`);
    }
    assert.equal(P.MAX_CANDIDATES, 200);
    assert.equal(P.MAX_PHASE_FILE_BYTES, BIG);
  });

  it('buildCandidatesOrdersSpecFirstAndMarks', () => {
    const files = [
      { name: '03-CONTEXT.md', label: 'p/03-CONTEXT.md', text: context() },
      { name: '03-SPEC.md', label: 'p/03-SPEC.md', text: spec([row('Never A.', 'n/a', 'resolved', 'x')]) },
    ];
    const document = parsedDoc([order({ id: 'A-RULE', statement: 'Never A.' })]);
    const out = P.buildCandidates({ files, document });
    assert.deepEqual(out.candidates.map((c) => c.source), ['p/03-SPEC.md prohibition 1', 'p/03-CONTEXT.md D-01', 'p/03-CONTEXT.md D-02']);
    assert.deepEqual(out.candidates.map((c) => c.already_promoted), [true, false, false]);
    assert.equal(out.candidates[0].promoted_as, 'A-RULE');
    assert.equal(out.truncated, false);
    assert.deepEqual(P.buildCandidates({ files: [], document: null }), { candidates: [], truncated: false });
  });
});

describe('promote: the --add argument', () => {
  it('addArgumentShapes', () => {
    const array = P.parseAddArgument('[{"id":"A"}]');
    assert.equal(array.ok, false);
    assert.equal(array.code, 'batch_refused');
    assert.equal(P.parseAddArgument('[]').code, 'batch_refused');
    const one = P.parseAddArgument('{"id":"A","kind":"invariant"}');
    assert.equal(one.ok, true);
    assert.deepEqual(one.order, { id: 'A', kind: 'invariant' });
    for (const bad of ['x', '', '"s"', 'null', '7', 'true', '{"id":']) {
      const r = P.parseAddArgument(bad);
      assert.equal(r.ok, false, bad);
      assert.equal(r.code, 'usage', bad);
      assert.equal(typeof r.message, 'string', bad);
    }
    assert.equal(P.PROMOTE_CODES.BATCH_REFUSED, 'batch_refused');
  });

  it('serializeOrderItemShape', () => {
    const o = { source: 'src', statement: 'S.', id: 'X-1', kind: 'prohibition', contexts: ['a', 'b'], scope: { paths: ['p/**'], requirements: ['BILL-04'] }, verification: 'backstop', operation: null, outcome: undefined };
    assert.equal(
      P.serializeOrderItem(o, '  ', '\n'),
      [
        '  - id: "X-1"',
        '    kind: "prohibition"',
        '    statement: "S."',
        '    contexts: ["a","b"]',
        '    scope: {"paths":["p/**"],"requirements":["BILL-04"]}',
        '    verification: "backstop"',
        '    source: "src"',
        '',
      ].join('\n'),
    );
    assert.equal(P.serializeOrderItem(NEW_ORDER, '    ', '\r\n'), '    - id: "NEW-1"\r\n      kind: "invariant"\r\n      statement: "New rule."\r\n      verification: "backstop"\r\n');
  });
});

describe('promote: inserting an order into ORDERS.yaml text', () => {
  it('insertAppendsToOrdersBlock', () => {
    const text = doc({ orders: [order({ id: 'OLD-1', statement: 'Old rule.' })] });
    const r = P.insertOrder(text, NEW_ORDER);
    assert.equal(r.ok, true);
    assert.equal(r.text, text + ITEM_NEW);
  });

  it('insertBeforeNextTopLevelKey', () => {
    const head = 'version: "1"\norders:\n  - id: A\n    kind: invariant\n    statement: "A."\n    verification: backstop\n';
    const tail = '\n  # trailing note\n\ncontexts:\n  c1: {}\n';
    const r = P.insertOrder(head + tail, NEW_ORDER);
    assert.equal(r.ok, true);
    assert.equal(r.text, head + ITEM_NEW + tail, 'after the last item, before the blank and comment lines and the next key');

    const tight = P.insertOrder(head + 'contexts:\n  c1: {}\n', NEW_ORDER);
    assert.equal(tight.text, head + ITEM_NEW + 'contexts:\n  c1: {}\n');

    const between = 'version: "1"\norders:\n  - id: A\n    kind: invariant\n    statement: "A."\n    verification: backstop\n  # between items\n  - id: B\n    kind: invariant\n    statement: "B."\n    verification: backstop\n';
    assert.equal(P.insertOrder(between, NEW_ORDER).text, between + ITEM_NEW, 'a comment between items stays where it is');

    const lone = 'version: "1"\norders:\n\n# nothing yet\ncontexts:\n  c1: {}\n';
    assert.equal(P.insertOrder(lone, NEW_ORDER).text, 'version: "1"\norders:\n' + ITEM_NEW + '\n# nothing yet\ncontexts:\n  c1: {}\n', 'an empty block takes the item right after `orders:`');
  });

  it('insertCreatesOrdersKey', () => {
    const r = P.insertOrder('version: "1"\n', NEW_ORDER);
    assert.equal(r.ok, true);
    assert.equal(r.text, 'version: "1"\norders:\n' + ITEM_NEW);
    const noEol = P.insertOrder('version: "1"', NEW_ORDER);
    assert.equal(noEol.text, 'version: "1"\norders:\n' + ITEM_NEW, 'a missing final newline is supplied');
    const withContexts = P.insertOrder('version: "1"\ncontexts:\n  c1: {}\n', NEW_ORDER);
    assert.equal(withContexts.text, 'version: "1"\ncontexts:\n  c1: {}\norders:\n' + ITEM_NEW);
  });

  it('insertReplacesEmptyFlowList', () => {
    const r = P.insertOrder('version: "1"\norders: []  # none yet\ncontexts:\n  c1: {}\n', NEW_ORDER);
    assert.equal(r.ok, true);
    const lines = r.text.split('\n');
    assert.equal(lines[0], 'version: "1"');
    assert.match(lines[1], /^orders:\s*#\s*none yet$/, 'the comment is kept');
    assert.ok(!r.text.includes('[]'));
    assert.equal(lines.slice(2).join('\n'), ITEM_NEW + 'contexts:\n  c1: {}\n');

    const plain = P.insertOrder('version: "1"\norders: []\n', NEW_ORDER);
    assert.equal(plain.text, 'version: "1"\norders:\n' + ITEM_NEW);
  });

  it('insertRefusesFlowList', () => {
    for (const line of ['orders: [{id: A, kind: invariant}]', 'orders: [a]', 'orders: ~', 'orders: null']) {
      const text = `version: "1"\n${line}\n`;
      const r = P.insertOrder(text, NEW_ORDER);
      assert.equal(r.ok, false, line);
      assert.equal(r.code, 'insert_unsupported', line);
      assert.equal(r.paste, ITEM_NEW, `${line}: the paste block is the item at the default indent`);
      assert.equal(r.text, undefined, line);
    }
  });

  it('insertKeepsIndent', () => {
    const wide = 'version: "1"\norders:\n    - id: A\n      kind: invariant\n      statement: "A."\n      verification: backstop\n';
    const r = P.insertOrder(wide, NEW_ORDER);
    assert.equal(r.ok, true);
    assert.equal(r.text, wide + P.serializeOrderItem(NEW_ORDER, '    ', '\n'));
    assert.ok(r.text.includes('\n    - id: "NEW-1"\n      kind: "invariant"\n'));
    const promoted = P.promoteOrder({ text: wide, order: NEW_ORDER, maxBytes: BIG });
    assert.equal(promoted.ok, true, JSON.stringify(promoted));
  });

  it('insertKeepsCrlf', () => {
    const text = 'version: "1"\r\norders:\r\n  - id: A\r\n    kind: invariant\r\n    statement: "A."\r\n    verification: backstop\r\n';
    const r = P.insertOrder(text, NEW_ORDER);
    assert.equal(r.ok, true);
    assert.equal(r.text, text + ITEM_NEW.replace(/\n/g, '\r\n'));
    assert.ok(!/[^\r]\n/.test(r.text), 'no bare LF');
    const promoted = P.promoteOrder({ text, order: NEW_ORDER, maxBytes: BIG });
    assert.equal(promoted.ok, true, JSON.stringify(promoted));
    assert.equal(parseOrders(promoted.text).document.orders.length, 2);
  });

  it('insertIgnoresCommentAndNestedKey', () => {
    const text = 'version: "1"\n# orders: nothing here yet\nother:\n  orders: x\n';
    const r = P.insertOrder(text, NEW_ORDER);
    assert.equal(r.ok, true);
    assert.equal(r.text, text + 'orders:\n' + ITEM_NEW, 'a comment and a nested key are not the top-level key');
    assert.equal(r.text.split('\n').filter((l) => /^orders:/.test(l)).length, 1);
  });
});

describe('promote: promoteOrder', () => {
  const OLD = doc({ orders: [order({ id: 'OLD-1', statement: 'Old rule.' })] });

  it('promoteCreatesFile', () => {
    const r = P.promoteOrder({ text: null, order: NEW_ORDER, maxBytes: BIG });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.id, 'NEW-1');
    assert.equal(r.text, 'version: "1"\norders:\n' + ITEM_NEW);
    const parsed = parseOrders(r.text);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.document.orders.length, 1);
    assert.equal(parsed.document.orders[0].id, 'NEW-1');
    const snapshot = JSON.parse(JSON.stringify(NEW_ORDER));
    assert.deepEqual(NEW_ORDER, snapshot);
  });

  it('promoteAppendsAndKeepsEveryOldByte', () => {
    const r = P.promoteOrder({ text: OLD, order: NEW_ORDER, maxBytes: BIG });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.text, OLD + ITEM_NEW);
    assert.equal(r.id, 'NEW-1');
  });

  it('promoteRefusesDuplicateId', () => {
    const r = P.promoteOrder({ text: OLD, order: { ...NEW_ORDER, id: 'OLD-1' }, maxBytes: BIG });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'duplicate_id');
    assert.equal(r.text, undefined, 'nothing to write');
    assert.equal(typeof r.message, 'string');
  });

  it('promoteRefusesBrokenFile', () => {
    for (const text of ['version: "1"\norders: not-a-list\n', 'version: [unterminated\n', 'version: "9"\norders:\n']) {
      const r = P.promoteOrder({ text, order: NEW_ORDER, maxBytes: BIG });
      assert.equal(r.ok, false, text);
      assert.equal(r.code, 'orders_unusable', text);
      assert.equal(r.text, undefined, text);
    }
  });

  it('promoteRefusesInvalidOrder', () => {
    const withContexts = doc({ contexts: { c1: {} }, orders: [order({ id: 'OLD-1', statement: 'Old rule.' })] });
    const cases = [
      ['unknown key', { ...NEW_ORDER, bogus: 'x' }],
      ['variant without outcome', { id: 'V-1', kind: 'variant', statement: 'V.', operation: 'refund.amount', verification: 'backstop' }],
      ['undefined context', { ...NEW_ORDER, contexts: ['nope'] }],
      ['invalid enum', { ...NEW_ORDER, kind: 'bogus' }],
      ['missing statement', { id: 'NEW-1', kind: 'invariant', verification: 'backstop' }],
    ];
    for (const [label, bad] of cases) {
      const texts = label === 'undefined context' ? [withContexts] : [withContexts, null];
      for (const text of texts) {
        const r = P.promoteOrder({ text, order: bad, maxBytes: BIG });
        assert.equal(r.ok, false, `${label} (${text === null ? 'new file' : 'existing'})`);
        assert.equal(r.code, 'invalid_order', label);
        assert.ok(Array.isArray(r.errors) && r.errors.length > 0, `${label}: carries the parser's findings`);
        assert.equal(r.text, undefined, label);
      }
    }
    const undefinedContext = P.promoteOrder({ text: withContexts, order: { ...NEW_ORDER, contexts: ['nope'] }, maxBytes: BIG });
    assert.ok(undefinedContext.errors.some((e) => e.code === 'undefined_context'));
    for (const id of [undefined, null, '', 7, ['X']]) {
      const r = P.promoteOrder({ text: OLD, order: { ...NEW_ORDER, id }, maxBytes: BIG });
      assert.equal(r.ok, false, String(id));
      assert.equal(r.code, 'invalid_order', String(id));
    }
  });

  it('promoteRoundTripsHostileStatement', () => {
    const nonAscii = String.fromCharCode(0xe9, 0x65e5, 0x672c) + String.fromCodePoint(0x1f600);
    const statements = [
      `He said "hi": #1 \\ path 'quoted' ${nonAscii}`,
      'key: value',
      '- looks like a list item',
      '# not a comment',
      'ends with backslash \\',
      '"',
      `${nonAscii}${nonAscii}`,
      '{flow: mapping} and [seq]',
    ];
    for (const statement of statements) {
      for (const text of [null, OLD]) {
        const r = P.promoteOrder({ text, order: { id: 'HOSTILE-1', kind: 'invariant', statement, verification: 'backstop' }, maxBytes: BIG });
        assert.equal(r.ok, true, `${statement}: ${JSON.stringify(r)}`);
        const orders = parseOrders(r.text).document.orders;
        assert.equal(orders[orders.length - 1].statement, statement, 'the statement round-trips exactly');
        assert.equal(orders[orders.length - 1].id, 'HOSTILE-1');
      }
    }
  });

  it('promoteRefusesOversize', () => {
    const fits = P.promoteOrder({ text: OLD, order: NEW_ORDER, maxBytes: BIG });
    assert.equal(fits.ok, true);
    const size = Buffer.byteLength(fits.text, 'utf8');
    assert.equal(P.promoteOrder({ text: OLD, order: NEW_ORDER, maxBytes: size }).ok, true, 'exactly the cap is allowed');
    const over = P.promoteOrder({ text: OLD, order: NEW_ORDER, maxBytes: size - 1 });
    assert.equal(over.ok, false);
    assert.equal(over.code, 'file_too_large');
    assert.equal(over.text, undefined);
    assert.equal(P.promoteOrder({ text: null, order: NEW_ORDER, maxBytes: 10 }).code, 'file_too_large');
  });

  it('promoteRefusesWhatTheGuardCannotProve', () => {
    // a layout the inserter cannot extend safely is refused with a paste block, never half-written
    const r = P.promoteOrder({ text: 'version: "1"\norders: [{id: A, kind: invariant, statement: "A.", verification: backstop}]\n', order: NEW_ORDER, maxBytes: BIG });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'insert_unsupported');
    assert.equal(r.paste, ITEM_NEW);
    assert.equal(r.text, undefined);
  });

  it('exportsTheContract', () => {
    assert.deepEqual([...P.ORIGINS], ['spec-prohibition', 'context-decision']);
    assert.deepEqual({ ...P.PROMOTE_CODES }, {
      BATCH_REFUSED: 'batch_refused',
      DUPLICATE_ID: 'duplicate_id',
      INVALID_ORDER: 'invalid_order',
      INSERT_UNSUPPORTED: 'insert_unsupported',
      ORDERS_UNUSABLE: 'orders_unusable',
      FILE_TOO_LARGE: 'file_too_large',
      PHASE_FILE_SKIPPED: 'phase_file_skipped',
    });
    assert.equal(orderHash(parseOrders(P.promoteOrder({ text: null, order: NEW_ORDER, maxBytes: BIG }).text).document.orders[0]).startsWith('sha256:'), true);
  });
});
