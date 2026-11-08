'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parseOrders, effectiveLeaves, KINDS, VERIFICATIONS, CHECK_KINDS, UNIVERSAL_CONTEXT, ERROR_CODES, ORDER_KEYS } = require('../lib/orders.cjs');
const { ADR_EXAMPLE, doc, order, testOrder, variant, codes } = require('./helpers/fixtures.cjs');

describe('parseOrders — happy path', () => {
  it('parsesTheAdrExampleIntoThreeOrdersAndResolvedLeafSets', () => {
    const r = parseOrders(ADR_EXAMPLE);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(codes(r.errors), []);
    assert.equal(r.document.version, '1');
    assert.deepEqual(Object.keys(r.document.contexts).sort(), ['any-contract', 'contract-a', 'contract-b']);
    assert.deepEqual(r.document.leafSets['any-contract'], ['contract-a', 'contract-b']);
    assert.deepEqual(r.document.leafSets['contract-a'], ['contract-a']);
    assert.deepEqual(r.document.allLeaves, ['contract-a', 'contract-b']);
    assert.deepEqual(r.document.orders.map((o) => o.id), ['REFUND-IDEMPOTENT', 'REFUND-AMOUNT-A', 'REFUND-AMOUNT-B']);
    const first = r.document.orders[0];
    assert.equal(first.kind, 'prohibition');
    assert.equal(first.operation, 'refund.execute');
    assert.deepEqual(first.contexts, ['any-contract']);
    assert.deepEqual(first.scope, { paths: ['src/billing/**'], requirements: ['BILL-04'] });
    assert.equal(first.check_kind, 'node-test');
    assert.equal(first.check_target, 'tests/billing/refund-idempotent.test.cjs');
    assert.equal(first.check_violation_fixture, 'tests/fixtures/billing/double-refund.js');
    assert.equal(first.check_clean_fixture, 'tests/fixtures/billing/single-refund.js');
    assert.equal(first.source, 'Contract terms §4.2; phase 3 CONTEXT.md D-12');
    assert.equal(r.document.orders[1].outcome, 'full');
    assert.equal(r.document.orders[2].verification, 'backstop');
    // REFUND-AMOUNT-A is test-tier with no fixtures: two warnings, still ok.
    const warn = r.warnings.filter((w) => w.code === 'fixture_missing');
    assert.equal(warn.length, 2);
    assert.ok(warn.every((w) => w.path.startsWith('$.orders[1].')));
  });

  it('exportsClosedEnums', () => {
    assert.deepEqual([...KINDS], ['prohibition', 'invariant', 'variant']);
    assert.deepEqual([...VERIFICATIONS], ['test', 'backstop']);
    assert.deepEqual([...CHECK_KINDS], ['node-test', 'lint-rule']);
  });

  it('acceptsNoOrders', () => {
    assert.equal(parseOrders(doc({})).ok, true);
    const r = parseOrders(doc({ orders: [] }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.document.orders, []);
  });

  it('acceptsVersionOneQuotedOrBare', () => {
    assert.equal(parseOrders('version: 1\n').ok, true);
    assert.equal(parseOrders('version: "1"\n').ok, true);
    assert.equal(parseOrders('version: 1\n').document.version, '1');
  });
});

describe('parseOrders — YAML boundary (hostile input)', () => {
  it('refusesAnchorsAndAliasesBeforeParsingContent', () => {
    const text = `version: 1\nbase: &b { x: y }\norders:\n  - id: SECRET-ORDER\n    kind: invariant\n    statement: s\n    verification: backstop\n    extra: *b\n`;
    const r = parseOrders(text);
    assert.equal(r.ok, false);
    assert.deepEqual(codes(r.errors), ['yaml_anchor_refused']);
    assert.equal(r.document, null);
    assert.equal(JSON.stringify(r).includes('SECRET-ORDER'), false);
  });

  it('refusesMergeKeys', () => {
    const text = `version: 1\ndefaults: &d { verification: backstop }\norders:\n  - <<: *d\n    id: A\n    kind: invariant\n    statement: s\n`;
    const r = parseOrders(text);
    assert.equal(r.ok, false);
    assert.deepEqual(codes(r.errors), ['yaml_anchor_refused']);
  });

  it('refusesBillionLaughsWithoutExpanding', () => {
    let text = 'version: 1\na: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]\n';
    const letters = 'bcdefghij';
    let prev = 'a';
    for (const l of letters) {
      text += `${l}: &${l} [*${prev},*${prev},*${prev},*${prev},*${prev},*${prev},*${prev},*${prev},*${prev}]\n`;
      prev = l;
    }
    const r = parseOrders(text);
    assert.equal(r.ok, false);
    assert.deepEqual(codes(r.errors), ['yaml_anchor_refused']);
    assert.ok(JSON.stringify(r).length < 2000, 'result must not carry expanded content');
  });

  it('treatsAnchorLikeTextInCommentsAsProse', () => {
    const r = parseOrders('version: 1 # see &alias and *ref in docs\norders: []\n');
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  });

  it('treatsMergeLikeTextInQuotedScalarAsProse', () => {
    const r = parseOrders(doc({ orders: [order({ statement: 'a << b and *not* an alias' })] }));
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.document.orders[0].statement, 'a << b and *not* an alias');
  });

  it('refusesNullBytes', () => {
    const r = parseOrders('version: 1\norders: []\n\u0000');
    assert.equal(r.ok, false);
    assert.deepEqual(codes(r.errors), ['yaml_null_byte']);
  });

  it('rejectsDuplicateMappingKeys', () => {
    // A second `orders:` key would otherwise silently replace the first (adversarial review).
    const r = parseOrders('version: 1\norders:\n  - id: A\n    kind: invariant\n    statement: s\n    verification: backstop\norders: []\n');
    assert.equal(r.ok, false);
    assert.deepEqual(codes(r.errors), ['yaml_syntax']);
    assert.ok(/duplicated mapping key/.test(r.errors[0].message));
    const dupField = parseOrders('version: 1\norders:\n  - id: A\n    kind: invariant\n    statement: first\n    statement: second\n    verification: backstop\n');
    assert.deepEqual(codes(dupField.errors), ['yaml_syntax']);
  });

  it('treatsBareMergeKeyAsUnknownKey', () => {
    // Without an anchor there is nothing to merge: FAILSAFE reads `<<` as a plain key, which the strict whitelist rejects.
    const r = parseOrders('version: 1\norders:\n  - <<: { id: A }\n');
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.code === 'unknown_key' && e.path === '$.orders[0].<<'));
    assert.equal(r.document, null);
  });

  it('reportsYamlSyntaxErrors', () => {
    const r = parseOrders('version: 1\norders: [unclosed\n');
    assert.equal(r.ok, false);
    assert.deepEqual(codes(r.errors), ['yaml_syntax']);
    assert.equal(r.document, null);
    assert.ok(r.errors[0].message.length > 0);
  });

  it('rejectsNonMappingRoots', () => {
    for (const text of ['0\n', '"str"\n', '[]\n', 'null\n', 'true\n', '', '   \n\n']) {
      const r = parseOrders(text);
      assert.equal(r.ok, false, JSON.stringify(text));
      assert.deepEqual(codes(r.errors), ['root_not_mapping'], JSON.stringify(text));
    }
  });

  it('rejectsNonStringInputWithoutThrowing', () => {
    for (const input of [undefined, null, 42, Buffer.from('version: 1'), {}]) {
      const r = parseOrders(input);
      assert.equal(r.ok, false);
      assert.deepEqual(codes(r.errors), ['input_not_string']);
    }
  });

  it('parsesCrlfIdenticallyToLf', () => {
    const lf = parseOrders(ADR_EXAMPLE);
    const crlf = parseOrders(ADR_EXAMPLE.replace(/\n/g, '\r\n'));
    assert.deepEqual(crlf, lf);
  });

  it('stripsLeadingBom', () => {
    const lf = parseOrders(ADR_EXAMPLE);
    const bom = parseOrders('﻿' + ADR_EXAMPLE);
    assert.deepEqual(bom, lf);
  });
});

describe('parseOrders — document shape', () => {
  it('requiresVersion', () => {
    const r = parseOrders('orders: []\n');
    assert.deepEqual(codes(r.errors), ['version_unsupported']);
  });

  it('rejectsOtherVersions', () => {
    for (const v of ['2', '1.0', 'one']) {
      const r = parseOrders(`version: ${v}\n`);
      assert.deepEqual(codes(r.errors), ['version_unsupported'], v);
    }
  });

  it('rejectsUnknownTopLevelKeys', () => {
    const r = parseOrders(doc({ extra: { rules: [] } }));
    assert.deepEqual(r.errors.map((e) => [e.code, e.path]), [['unknown_key', '$.rules']]);
  });

  it('rejectsNonListOrders', () => {
    assert.deepEqual(codes(parseOrders('version: 1\norders: {}\n').errors), ['orders_not_list']);
    assert.deepEqual(codes(parseOrders('version: 1\norders: x\n').errors), ['orders_not_list']);
  });

  it('rejectsNonMappingContexts', () => {
    assert.deepEqual(codes(parseOrders('version: 1\ncontexts: [a]\n').errors), ['contexts_not_mapping']);
  });
});

describe('parseOrders — contexts', () => {
  it('resolvesIncludesAndExtendsTogether', () => {
    const r = parseOrders(doc({
      contexts: { a: {}, b: {}, c: { extends: 'all' }, all: { includes: ['a', 'b'] } },
    }));
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.document.leafSets.all, ['a', 'b', 'c']);
    assert.deepEqual(r.document.leafSets.c, ['c']);
    assert.deepEqual(r.document.allLeaves, ['a', 'b', 'c']);
  });

  it('resolvesIncludesAndExtendsOnOneContext', () => {
    // `mid` both includes a leaf and extends a parent: it is a member of `top` and the union of its own members.
    const r = parseOrders(doc({ contexts: { leaf: {}, other: {}, top: {}, mid: { includes: ['leaf', 'other'], extends: 'top' } } }));
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.document.leafSets.mid, ['leaf', 'other']);
    assert.deepEqual(r.document.leafSets.top, ['leaf', 'other']);
    assert.deepEqual(r.document.allLeaves, ['leaf', 'other']);
  });

  it('survivesAVeryDeepMembershipChainWithoutThrowing', () => {
    const contexts = { c0: {} };
    for (let i = 1; i < 6000; i++) contexts[`c${i}`] = { includes: [`c${i - 1}`] };
    let r;
    assert.doesNotThrow(() => { r = parseOrders(doc({ contexts })); });
    assert.equal(typeof r.ok, 'boolean');
    if (!r.ok) assert.deepEqual(codes(r.errors), ['context_too_deep']);
    else assert.deepEqual(r.document.leafSets.c5999, ['c0']);
  });

  it('extendsMakesChildAMemberOfParent', () => {
    const r = parseOrders(doc({ contexts: { parent: {}, child: { extends: 'parent' } } }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.document.leafSets.parent, ['child']);
    assert.deepEqual(r.document.leafSets.child, ['child']);
  });

  it('reportsUndefinedIncludedContext', () => {
    const r = parseOrders(doc({ contexts: { a: { includes: ['missing'] } } }));
    assert.deepEqual(r.errors.map((e) => [e.code, e.path]), [['undefined_context', '$.contexts.a.includes[0]']]);
  });

  it('reportsUndefinedExtendedContext', () => {
    const r = parseOrders(doc({ contexts: { a: { extends: 'missing' } } }));
    assert.deepEqual(r.errors.map((e) => [e.code, e.path]), [['undefined_context', '$.contexts.a.extends']]);
  });

  it('reportsUndefinedContextOnOrderWhenNoContextsDeclared', () => {
    const r = parseOrders(doc({ orders: [order({ contexts: ['x'] })] }));
    assert.deepEqual(r.errors.map((e) => [e.code, e.path]), [['undefined_context', '$.orders[0].contexts[0]']]);
  });

  it('reportsTwoNodeCycle', () => {
    const r = parseOrders(doc({ contexts: { a: { includes: ['b'] }, b: { includes: ['a'] } } }));
    assert.equal(r.ok, false);
    const cyc = r.errors.filter((e) => e.code === 'context_cycle');
    assert.equal(cyc.length, 1);
    assert.deepEqual(cyc[0].members, ['a', 'b']);
  });

  it('reportsSelfCycle', () => {
    const r = parseOrders(doc({ contexts: { a: { extends: 'a' } } }));
    const cyc = r.errors.filter((e) => e.code === 'context_cycle');
    assert.equal(cyc.length, 1);
    assert.deepEqual(cyc[0].members, ['a']);
  });

  it('reportsMixedEdgeCycle', () => {
    const r = parseOrders(doc({ contexts: { a: { includes: ['b'] }, b: { includes: ['c'] }, c: { includes: ['a'] } } }));
    assert.equal(r.errors.filter((e) => e.code === 'context_cycle').length, 1);
  });

  it('rejectsInvalidContextNames', () => {
    for (const name of ['Contract_A', '1a', '', 'has space']) {
      const r = parseOrders(doc({ contexts: { [name]: {} } }));
      assert.ok(codes(r.errors).includes('context_name_invalid'), JSON.stringify(name));
    }
  });

  it('rejectsUnknownContextKeysAndTypes', () => {
    assert.ok(codes(parseOrders(doc({ contexts: { a: { color: 'red' } } })).errors).includes('unknown_key'));
    assert.ok(codes(parseOrders(doc({ contexts: { a: { includes: 'b' } } })).errors).includes('type_invalid'));
    assert.ok(codes(parseOrders(doc({ contexts: { a: 'x' } })).errors).includes('type_invalid'));
  });
});

describe('parseOrders — orders', () => {
  it('reportsEachMissingRequiredField', () => {
    for (const field of ['id', 'kind', 'statement']) {
      const r = parseOrders(doc({ orders: [order({ [field]: null })] }));
      assert.ok(r.errors.some((e) => e.code === 'missing_field' && e.path === `$.orders[0].${field}`), field);
    }
  });

  it('reportsDuplicateIdOnSecondOccurrence', () => {
    const r = parseOrders(doc({ orders: [order({ id: 'A' }), order({ id: 'A' })] }));
    assert.deepEqual(r.errors.map((e) => [e.code, e.path]), [['duplicate_id', '$.orders[1].id']]);
    assert.equal(r.document, null);
  });

  it('reportsEveryLaterDuplicate', () => {
    const r = parseOrders(doc({ orders: [order({ id: 'A' }), order({ id: 'A' }), order({ id: 'A' })] }));
    assert.deepEqual(r.errors.map((e) => e.path), ['$.orders[1].id', '$.orders[2].id']);
  });

  it('rejectsUnknownKind', () => {
    const r = parseOrders(doc({ orders: [order({ kind: 'rule' })] }));
    assert.deepEqual(r.errors.map((e) => [e.code, e.path]), [['enum_invalid', '$.orders[0].kind']]);
  });

  it('variantRequiresOperationAndOutcome', () => {
    const noOp = parseOrders(doc({ orders: [order({ kind: 'variant', outcome: 'x' })] }));
    assert.deepEqual(noOp.errors.map((e) => [e.code, e.path]), [['missing_field', '$.orders[0].operation']]);
    const noOut = parseOrders(doc({ orders: [order({ kind: 'variant', operation: 'op' })] }));
    assert.deepEqual(noOut.errors.map((e) => [e.code, e.path]), [['missing_field', '$.orders[0].outcome']]);
  });

  it('rejectsOutcomeOnNonVariant', () => {
    const r = parseOrders(doc({ orders: [order({ kind: 'prohibition', outcome: 'x' })] }));
    assert.deepEqual(r.errors.map((e) => [e.code, e.path]), [['unknown_key_for_kind', '$.orders[0].outcome']]);
  });

  it('treatsAbsentOrEmptyContextsAsAll', () => {
    const r = parseOrders(doc({ contexts: { a: {}, b: {} }, orders: [order({ id: 'X' }), order({ id: 'Y', contexts: [] })] }));
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.document.orders[0].contexts, []);
    assert.deepEqual(r.document.orders[1].contexts, []);
    assert.deepEqual(effectiveLeaves(r.document.orders[0], r.document), ['a', 'b']);
    assert.deepEqual(effectiveLeaves(r.document.orders[1], r.document), ['a', 'b']);
  });

  it('effectiveLeavesWithoutDeclaredContextsIsTheUniversalContext', () => {
    // Blocker from the adversarial review: an empty leaf set made every conflict undetectable.
    const r = parseOrders(doc({ orders: [order({ id: 'X' })] }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.document.allLeaves, []);
    assert.deepEqual(effectiveLeaves(r.document.orders[0], r.document), [UNIVERSAL_CONTEXT]);
    assert.equal(UNIVERSAL_CONTEXT, '*');
  });

  it('rejectsEmptyRequiredStrings', () => {
    for (const field of ['id', 'statement']) {
      const r = parseOrders(doc({ orders: [order({ [field]: '' })] }));
      assert.deepEqual(r.errors.map((e) => [e.code, e.path]), [['type_invalid', `$.orders[0].${field}`]], field);
    }
    const blankPath = parseOrders(doc({ orders: [order({ scope: { paths: [''] } })] }));
    assert.deepEqual(blankPath.errors.map((e) => [e.code, e.path]), [['type_invalid', '$.orders[0].scope.paths[0]']]);
  });

  it('effectiveLeavesUnionsNamedContexts', () => {
    const r = parseOrders(ADR_EXAMPLE);
    assert.deepEqual(effectiveLeaves(r.document.orders[0], r.document), ['contract-a', 'contract-b']);
    assert.deepEqual(effectiveLeaves(r.document.orders[1], r.document), ['contract-a']);
  });

  it('rejectsUnknownVerification', () => {
    const r = parseOrders(doc({ orders: [order({ verification: 'judgment' })] }));
    assert.deepEqual(r.errors.map((e) => [e.code, e.path]), [['enum_invalid', '$.orders[0].verification']]);
  });

  it('testTierRequiresCheckDescriptor', () => {
    const r = parseOrders(doc({ orders: [order({ verification: 'test' })] }));
    assert.deepEqual(r.errors.map((e) => [e.code, e.path]).sort(), [
      ['missing_field', '$.orders[0].check_kind'],
      ['missing_field', '$.orders[0].check_target'],
    ]);
  });

  it('rejectsUnknownCheckKind', () => {
    const r = parseOrders(doc({ orders: [testOrder({ check_kind: 'pytest' })] }));
    assert.deepEqual(r.errors.map((e) => [e.code, e.path]), [['enum_invalid', '$.orders[0].check_kind']]);
  });

  it('lintRuleRequiresCheckRule', () => {
    const r = parseOrders(doc({ orders: [testOrder({ check_kind: 'lint-rule' })] }));
    assert.deepEqual(r.errors.map((e) => [e.code, e.path]), [['missing_field', '$.orders[0].check_rule']]);
    const ok = parseOrders(doc({ orders: [testOrder({ check_kind: 'lint-rule', check_rule: 'no-double-refund' })] }));
    assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  });

  it('warnsPerMissingFixture', () => {
    // phase 6 adds the separate `no_mutants` warning for a test order without mutants: this test is about fixtures only
    const fixtureWarnings = (r) => r.warnings.filter((w) => w.code === 'fixture_missing');
    const none = parseOrders(doc({ orders: [testOrder({ check_violation_fixture: null, check_clean_fixture: null })] }));
    assert.equal(none.ok, true);
    assert.deepEqual(fixtureWarnings(none).map((w) => [w.code, w.path]).sort(), [
      ['fixture_missing', '$.orders[0].check_clean_fixture'],
      ['fixture_missing', '$.orders[0].check_violation_fixture'],
    ]);
    const one = parseOrders(doc({ orders: [testOrder({ check_clean_fixture: null })] }));
    assert.deepEqual(fixtureWarnings(one).map((w) => w.path), ['$.orders[0].check_clean_fixture']);
    const both = parseOrders(doc({ orders: [testOrder()] }));
    assert.deepEqual(fixtureWarnings(both), []);
  });

  it('warnsWhenBackstopCarriesCheckKeys', () => {
    const r = parseOrders(doc({ orders: [order({ verification: 'backstop', check_target: 'x.test.cjs' })] }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.warnings.map((w) => [w.code, w.path]), [['check_ignored_for_backstop', '$.orders[0].check_target']]);
    assert.equal(r.document.orders[0].check_target, 'x.test.cjs');
  });

  it('rejectsUnknownOrderKeys', () => {
    const r = parseOrders(doc({ orders: [order({ statment: 'typo' })] }));
    assert.deepEqual(r.errors.map((e) => [e.code, e.path]), [['unknown_key', '$.orders[0].statment']]);
  });

  it('keepsEveryScalarAString', () => {
    const r = parseOrders('version: 1\norders:\n  - id: 007\n    kind: variant\n    operation: op\n    outcome: 1\n    statement: true\n    verification: backstop\n');
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const o = r.document.orders[0];
    assert.equal(o.id, '007');
    assert.equal(o.outcome, '1');
    assert.equal(o.statement, 'true');
  });

  it('rejectsNonScalarWhereScalarExpected', () => {
    const r = parseOrders(doc({ orders: [order({ id: ['a'], statement: { x: 'y' } })] }));
    assert.deepEqual(r.errors.map((e) => [e.code, e.path]).sort(), [
      ['type_invalid', '$.orders[0].id'],
      ['type_invalid', '$.orders[0].statement'],
    ]);
  });

  it('rejectsNonListScopeFields', () => {
    const r = parseOrders(doc({ orders: [order({ scope: { paths: 'src/**' } })] }));
    assert.deepEqual(r.errors.map((e) => [e.code, e.path]), [['type_invalid', '$.orders[0].scope.paths']]);
  });

  it('normalizesOptionalFieldsToNullAndScopeToLists', () => {
    const r = parseOrders(doc({ orders: [order()] }));
    const o = r.document.orders[0];
    assert.equal(o.operation, null);
    assert.equal(o.outcome, null);
    assert.equal(o.source, null);
    assert.equal(o.check_kind, null);
    assert.deepEqual(o.scope, { paths: [], requirements: [] });
  });

  it('duplicateKeyCannotHideAnAnchor', () => {
    const r = parseOrders('version: "1"\nversion: "2"\nx: &x [a, b]\ny: *x\n');
    assert.equal(r.ok, false);
    assert.deepEqual(codes(r.errors), ['yaml_anchor_refused']);
  });
});

// Phase 6 (#7), ADR-0002 section 1: the `check_mutants` field. Rows 1-11 of .gsd/phase/feat-7-mutation-hardening/50-test-matrix.md.
describe('parseOrders: check_mutants', () => {
  const P0 = '$.orders[0]';
  const at = (i) => `${P0}.check_mutants[${i}]`;
  const pairs = (list) => list.map((x) => [x.code, x.path]);
  const withMutants = (mutants, extra = {}) => parseOrders(doc({ orders: [testOrder({ check_mutants: mutants, ...extra })] }));
  /** An order document written by hand, so a value the dumper would normalize can be seen as the parser sees it. */
  const raw = (lines) =>
    [
      'version: 1',
      'orders:',
      '  - id: T-1',
      '    kind: prohibition',
      '    statement: s',
      '    verification: test',
      '    check_kind: node-test',
      '    check_target: tests/x.test.cjs',
      '    check_violation_fixture: tests/fixtures/bad.js',
      '    check_clean_fixture: tests/fixtures/good.js',
      ...lines.map((l) => '    ' + l),
      '',
    ].join('\n');

  it('exportsTheMutantCodes', () => {
    assert.equal(ERROR_CODES.PATH_INVALID, 'path_invalid');
    assert.equal(ERROR_CODES.DUPLICATE_MUTANT, 'duplicate_mutant');
    assert.equal(ERROR_CODES.MUTANT_IS_CHECK_FILE, 'mutant_is_check_file');
    assert.equal(ERROR_CODES.NO_MUTANTS, 'no_mutants');
    assert.ok(ORDER_KEYS.includes('check_mutants'));
  });

  // row 1
  it('noMutantsWarns', () => {
    const r = parseOrders(doc({ orders: [testOrder()] }));
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(pairs(r.warnings), [['no_mutants', P0]]);
    assert.deepEqual(r.document.orders[0].check_mutants, []);
    const backstop = parseOrders(doc({ orders: [order()] }));
    assert.deepEqual(backstop.warnings, [], 'hardening is for test orders: a backstop has nothing to harden');
    assert.deepEqual(backstop.document.orders[0].check_mutants, []);
    // hardening is opt-in: the order is as valid as it was
    assert.equal(r.document.orders[0].id, 'TEST-1');
  });

  // row 2
  it('acceptsCheckMutants', () => {
    const r = withMutants(['tests/fixtures/mutants/b.js', 'tests/fixtures/mutants/a.js']);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.warnings, [], 'a hardened test order has nothing to warn about');
    assert.deepEqual(r.document.orders[0].check_mutants, ['tests/fixtures/mutants/b.js', 'tests/fixtures/mutants/a.js'], 'kept as written, in order');
    const five = parseOrders(raw(['check_mutants:', '  - 5']));
    assert.equal(five.ok, true, JSON.stringify(five.errors));
    assert.deepEqual(five.document.orders[0].check_mutants, ['5'], 'every scalar stays a string');
  });

  // row 3
  it('checkMutantsMustBeList', () => {
    for (const lines of [['check_mutants: tests/m.js'], ['check_mutants: {a: b}'], ['check_mutants:'], ['check_mutants: ""']]) {
      const r = parseOrders(raw(lines));
      assert.equal(r.ok, false, lines.join('|'));
      assert.deepEqual(pairs(r.errors), [['type_invalid', `${P0}.check_mutants`]], lines.join('|'));
      assert.equal(r.document, null);
    }
  });

  // row 4
  it('mutantEntriesMustBeText', () => {
    const cases = [
      [['check_mutants:', '  - ""'], 0],
      [['check_mutants:', '  - ok.js', '  - ""'], 1],
      [['check_mutants:', '  - ok.js', '  - "   "'], 1],
      [['check_mutants:', '  - ok.js', '  -'], 1],
      [['check_mutants:', '  - {a: b}'], 0],
      [['check_mutants:', '  - ok.js', '  - [x, y]'], 1],
    ];
    for (const [lines, index] of cases) {
      const r = parseOrders(raw(lines));
      assert.equal(r.ok, false, lines.join('|'));
      assert.deepEqual(pairs(r.errors), [['type_invalid', at(index)]], lines.join('|'));
    }
  });

  // row 5
  it('mutantPathMustBeRelative', () => {
    const hostile = ['/abs/m.js', '/', 'C:\\x\\m.js', 'c:/x/m.js', 'C:/x/m.js', '\\\\srv\\x\\m.js', 'a/../b.js', 'a\\..\\b.js', '..', '../m.js', 'a/..', './../x.js'];
    for (const p of hostile) {
      const r = withMutants(['fine.js', p]);
      assert.equal(r.ok, false, p);
      assert.deepEqual(pairs(r.errors), [['path_invalid', at(1)]], p);
    }
  });

  // row 6
  it('dotsInNamesAreFine', () => {
    const fine = ['a..b/c.js', '..foo', 'dir/..foo/x.js', 'x/y..', 'a/.../b.js', '.hidden/m.js', './m.js'];
    const r = withMutants(fine);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.document.orders[0].check_mutants, fine);
  });

  // row 7
  it('duplicateMutant', () => {
    const cases = [
      [['a/b.js', 'a/b.js'], 1],
      [['a\\b.js', 'a/b.js'], 1],
      [['a/b.js', 'x.js', 'a/b.js'], 2],
    ];
    for (const [list, index] of cases) {
      const r = withMutants(list);
      assert.equal(r.ok, false, list.join('|'));
      assert.deepEqual(pairs(r.errors), [['duplicate_mutant', at(index)]], list.join('|'));
    }
  });

  // row 8
  it('mutantCannotBeCheckFile', () => {
    const same = ['tests/x.test.cjs', 'tests/fixtures/bad.js', 'tests/fixtures/good.js', 'Tests/X.test.cjs', 'tests\\fixtures\\bad.js', 'TESTS/FIXTURES/GOOD.JS'];
    for (const p of same) {
      const r = withMutants([p]);
      assert.equal(r.ok, false, p);
      assert.deepEqual(pairs(r.errors), [['mutant_is_check_file', at(0)]], p);
    }
    const second = withMutants(['fine.js', 'tests/fixtures/good.js']);
    assert.deepEqual(pairs(second.errors), [['mutant_is_check_file', at(1)]]);
    const lint = withMutants(['src/refund.js'], { check_kind: 'lint-rule', check_rule: 'local/no-x', check_target: 'src/refund.js' });
    assert.deepEqual(pairs(lint.errors), [['mutant_is_check_file', at(0)]], 'a lint-rule target is a check file too');
    assert.equal(withMutants(['tests/fixtures/good.js.bak', 'tests/x.test.cjs.js']).ok, true, 'only an exact match is the check file');
  });

  // row 9
  it('emptyListWarns', () => {
    const r = withMutants([]);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(pairs(r.warnings), [['no_mutants', P0]]);
    assert.deepEqual(r.document.orders[0].check_mutants, []);
  });

  // row 10
  it('backstopMutantsIgnored', () => {
    const r = parseOrders(doc({ orders: [order({ verification: 'backstop', check_mutants: ['a.js'] })] }));
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(pairs(r.warnings), [['check_ignored_for_backstop', `${P0}.check_mutants`]]);
  });

  // row 11
  it('lintRuleMutants', () => {
    const lint = withMutants(['tests/fixtures/mutants/lint-1.js'], { check_kind: 'lint-rule', check_rule: 'local/no-double-refund' });
    assert.equal(lint.ok, true, JSON.stringify(lint.errors));
    assert.deepEqual(lint.warnings, []);
    assert.deepEqual(lint.document.orders[0].check_mutants, ['tests/fixtures/mutants/lint-1.js']);
    // S11: a node-test order with mutants but no clean fixture adds no new requirement; the existing warning says it all
    const noClean = withMutants(['m.js'], { check_clean_fixture: null });
    assert.equal(noClean.ok, true, JSON.stringify(noClean.errors));
    assert.deepEqual(pairs(noClean.warnings), [['fixture_missing', `${P0}.check_clean_fixture`]]);
  });

  it('mutantsOfOtherOrdersDoNotCollide', () => {
    // the duplicate rule is per order: two orders may name the same mutant file
    const r = parseOrders(doc({ orders: [testOrder({ id: 'T-1', check_mutants: ['m.js'] }), testOrder({ id: 'T-2', check_mutants: ['m.js'] })] }));
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  });
});
