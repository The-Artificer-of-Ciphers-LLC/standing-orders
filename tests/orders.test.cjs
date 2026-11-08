'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parseOrders, effectiveLeaves, KINDS, VERIFICATIONS, CHECK_KINDS, UNIVERSAL_CONTEXT } = require('../lib/orders.cjs');
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
    const none = parseOrders(doc({ orders: [testOrder({ check_violation_fixture: null, check_clean_fixture: null })] }));
    assert.equal(none.ok, true);
    assert.deepEqual(none.warnings.map((w) => [w.code, w.path]).sort(), [
      ['fixture_missing', '$.orders[0].check_clean_fixture'],
      ['fixture_missing', '$.orders[0].check_violation_fixture'],
    ]);
    const one = parseOrders(doc({ orders: [testOrder({ check_clean_fixture: null })] }));
    assert.deepEqual(one.warnings.map((w) => w.path), ['$.orders[0].check_clean_fixture']);
    const both = parseOrders(doc({ orders: [testOrder()] }));
    assert.deepEqual(both.warnings, []);
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
});
