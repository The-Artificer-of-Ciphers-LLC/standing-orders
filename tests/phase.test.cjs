'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { extractPathTokens, splitReqIds, parsePlanFrontmatter, normalizePlan, isCited, collectPhaseInputs, MAX_DOC_BYTES } = require('../lib/phase.cjs');
const { memfs } = require('./helpers/memfs.cjs');

const PLAN_TEXT = '---\nfiles_modified:\n  - src/a.js\nrequirements: [BILL-04]\nmust_haves:\n  truths:\n    - "REFUND-A holds"\n---\nbody text\n';

describe('phase', () => {
  it('extractsPathTokens', () => {
    assert.deepEqual(extractPathTokens('See `src/a.js`, `x.cjs` and `./b/c`.'), ['src/a.js', 'x.cjs', 'b/c']);
    assert.deepEqual(extractPathTokens('`src/a.js:12` and `src/a.js:12:3` and `src/b.js`'), ['src/a.js', 'src/b.js']);
    assert.deepEqual(extractPathTokens('`.//lib///x.js` `././y/z.md`'), ['lib/x.js', 'y/z.md']);
    assert.deepEqual(extractPathTokens(42), []);
    assert.deepEqual(extractPathTokens(undefined), []);
  });

  it('ignoresNonPathSpans', () => {
    const md = ['`npm test`', '`a && b`', '`https://x/y`', '`{x}`', '`$(rm)`', '`` ``', '`foo`', '`-rf/x.js`', '`../up/x.js`', '`/etc/passwd`', '`C:/x/y.js`', '`a/../b.js`'].join('\n');
    assert.deepEqual(extractPathTokens(md), []);
    assert.deepEqual(extractPathTokens('```\n`src/in/fence.js`\n```\n'), []);
    assert.deepEqual(extractPathTokens('`' + 'a/'.repeat(200) + 'x.js`'), []);
  });

  it('normalizesBackslashAndCrlf', () => {
    assert.deepEqual(extractPathTokens('`src\\win\\a.js`'), ['src/win/a.js']);
    const lf = '`a/b.js`\n`c/d.js`\n';
    const crlf = '`a/b.js`\r\n`c/d.js`\r\n';
    const cr = '`a/b.js`\r`c/d.js`\r';
    assert.deepEqual(extractPathTokens(crlf), ['a/b.js', 'c/d.js']);
    assert.deepEqual(extractPathTokens(cr), extractPathTokens(lf));
    assert.deepEqual(extractPathTokens('`a/b.js` `a/b.js` `./a/b.js`'), ['a/b.js']);
  });

  it('parsesPlanFrontmatter', () => {
    const r = parsePlanFrontmatter(PLAN_TEXT);
    assert.equal(r.ok, true);
    assert.deepEqual(r.data.files_modified, ['src/a.js']);
    assert.deepEqual(normalizePlan(r.data), {
      files_modified: ['src/a.js'],
      requirements: ['BILL-04'],
      must_haves: { truths: ['REFUND-A holds'] },
    });
  });

  it('planBomAndCrlf', () => {
    const bom = String.fromCharCode(0xfeff);
    const plain = parsePlanFrontmatter(PLAN_TEXT);
    const crlf = parsePlanFrontmatter(PLAN_TEXT.replace(/\n/g, '\r\n'));
    const withBom = parsePlanFrontmatter(bom + PLAN_TEXT);
    const both = parsePlanFrontmatter(bom + PLAN_TEXT.replace(/\n/g, '\r\n'));
    assert.equal(plain.ok, true);
    assert.deepEqual(crlf, plain);
    assert.deepEqual(withBom, plain);
    assert.deepEqual(both, plain);
  });

  it('planAnchorsRefused', () => {
    const anchors = '---\nfiles_modified: &a\n  - x\nother: *a\n---\n';
    assert.deepEqual(parsePlanFrontmatter(anchors), { ok: false, error: 'anchors or aliases refused' });
  });

  it('planWithoutUsableFrontmatter', () => {
    assert.deepEqual(parsePlanFrontmatter('just text\n'), { ok: false, error: 'no frontmatter' });
    assert.deepEqual(parsePlanFrontmatter(''), { ok: false, error: 'no frontmatter' });
    assert.deepEqual(parsePlanFrontmatter('---\na: b\n'), { ok: false, error: 'unterminated frontmatter' });
    assert.deepEqual(parsePlanFrontmatter('---\n- a\n- b\n---\n'), { ok: false, error: 'frontmatter is not a mapping' });
    const bad = parsePlanFrontmatter('---\na: [unclosed\n---\n');
    assert.equal(bad.ok, false);
    assert.ok(bad.error.startsWith('invalid YAML: '), bad.error);
  });

  it('scalarFilesModifiedBecomesList', () => {
    assert.deepEqual(normalizePlan({ files_modified: './src/a.js' }).files_modified, ['src/a.js']);
    assert.deepEqual(normalizePlan({ files_modified: ['.\\src\\b.js', 7, 'c/d.js'] }).files_modified, ['src/b.js', 'c/d.js']);
    assert.deepEqual(normalizePlan({ requirements: ' BILL-04 ' }).requirements, ['BILL-04']);
    assert.deepEqual(normalizePlan({ requirements: ['A', ' ', ' B '] }).requirements, ['A', 'B']);
    const empty = normalizePlan({ files_modified: { not: 'a list' }, requirements: null });
    assert.deepEqual(empty.files_modified, []);
    assert.deepEqual(empty.requirements, []);
    assert.equal(empty.must_haves, undefined);
  });

  it('citesWholeTokenInMustHaves', () => {
    assert.equal(isCited('REFUND-A', { truths: ['REFUND-A: holds'] }), true);
    assert.equal(isCited('REFUND-A', { artifacts: [{ path: 'x', note: ['see (REFUND-A)'] }] }), true);
    assert.equal(isCited('REFUND-A', { truths: ['first', 'REFUND-A'] }), true);
    assert.equal(isCited('REFUND-A', { truths: ['REFUND-A, REFUND-B'] }), true);
  });

  it('substringIsNotCitation', () => {
    assert.equal(isCited('REFUND-A', { truths: ['REFUND-AB holds'] }), false);
    assert.equal(isCited('REFUND-A', { truths: ['xREFUND-A holds'] }), false);
    assert.equal(isCited('REFUND-A', { truths: ['_REFUND-A and REFUND-A-2'] }), false);
    assert.equal(isCited('REFUND-A', { truths: ['MY-REFUND-A'] }), false);
  });

  it('citationOutsideMustHavesIgnored', () => {
    assert.equal(isCited('A-1', undefined), false);
    assert.equal(isCited('A-1', null), false);
    assert.equal(isCited('A-1', {}), false);
    assert.equal(isCited('A-1', { 'A-1': ['nothing here'] }), false);
    assert.equal(isCited('A-1', { count: 5 }), false);
  });

  it('idIsMatchedLiterally', () => {
    assert.equal(isCited('A.B', { t: ['AxB'] }), false);
    assert.equal(isCited('A.B', { t: ['A.B ok'] }), true);
    assert.equal(isCited('A+', { t: ['AAA'] }), false);
    assert.equal(isCited('', { t: ['anything'] }), false);
    assert.equal(isCited(5, { t: ['5'] }), false);
  });

  it('splitsRequirementIds', () => {
    assert.deepEqual(splitReqIds('A, B'), ['A', 'B']);
    assert.deepEqual(splitReqIds('[A, B]'), ['A', 'B']);
    assert.deepEqual(splitReqIds(''), []);
    assert.deepEqual(splitReqIds('A  B'), ['A', 'B']);
    assert.deepEqual(splitReqIds('A,A,B'), ['A', 'B']);
    assert.deepEqual(splitReqIds(undefined), []);
    assert.deepEqual(splitReqIds(['A']), []);
  });

  it('duplicateKeyCannotHideAnAlias', () => {
    const r = parsePlanFrontmatter('---\na: 1\na: 2\nx: &x [a, b]\ny: *x\n---\n');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'anchors or aliases refused');
  });

  describe('collectPhaseInputs', () => {
    const PHASE_REL = '.planning/phases/03-billing';

    it('collectsDocsAndPlans', () => {
      const fs = memfs({
        files: {
          [`${PHASE_REL}/03-CONTEXT.md`]: 'Touches `src/ui/x.js` and `src/billing/refund.js`.\n',
          [`${PHASE_REL}/03-01-PLAN.md`]: '---\nfiles_modified:\n  - src/billing/refund.js\n  - lib/new.js\nrequirements: [BILL-04]\nmust_haves:\n  truths:\n    - "REFUND-A holds"\n---\n',
          [`${PHASE_REL}/03-02-PLAN.md`]: 'no frontmatter at all\n',
          [`${PHASE_REL}/03-01-SUMMARY.md`]: 'Summary mentions `src/summary/only.js`.\n',
          [`${PHASE_REL}/STANDING-ORDERS.md`]: 'Verdict mentions `src/verdict/only.js`.\n',
          [`${PHASE_REL}/03-STANDING-ORDERS.md`]: 'Stray verdict mentions `src/stray/only.js`.\n',
          [`${PHASE_REL}/notes.txt`]: 'Not markdown `src/txt/only.js`.\n',
        },
      });
      const phaseDir = path.resolve(fs.cwd, PHASE_REL);
      const r = collectPhaseInputs({ phaseDir, deps: { listDir: fs.deps.listDir, readFile: fs.deps.readFile } });
      assert.deepEqual(r.files, ['src/ui/x.js', 'src/billing/refund.js', 'lib/new.js']);
      assert.deepEqual(r.planRequirements, ['BILL-04']);
      assert.deepEqual(r.warnings, []);
      assert.equal(r.plans.length, 2);
      assert.deepEqual(r.plans[0], {
        file: '03-01-PLAN.md',
        ok: true,
        files_modified: ['src/billing/refund.js', 'lib/new.js'],
        requirements: ['BILL-04'],
        must_haves: { truths: ['REFUND-A holds'] },
      });
      assert.equal(r.plans[1].file, '03-02-PLAN.md');
      assert.equal(r.plans[1].ok, false);
      assert.equal(r.plans[1].error, 'no frontmatter');
      assert.deepEqual(r.plans[1].files_modified, []);
      assert.deepEqual(r.plans[1].requirements, []);
    });

    it('unreadablePhaseDirWarns', () => {
      const fs = memfs({});
      const r = collectPhaseInputs({ phaseDir: path.resolve(fs.cwd, 'no/such/dir'), deps: { listDir: fs.deps.listDir, readFile: fs.deps.readFile } });
      assert.deepEqual(r.files, []);
      assert.deepEqual(r.plans, []);
      assert.deepEqual(r.planRequirements, []);
      assert.deepEqual(
        r.warnings.map((w) => w.code),
        ['phase_dir_unreadable'],
      );
    });

    it('oversizedDocIsSkippedWithWarning', () => {
      const big = 'a'.repeat(MAX_DOC_BYTES + 1);
      const fs = memfs({
        files: {
          [`${PHASE_REL}/03-CONTEXT.md`]: big + ' `src/never/seen.js`',
          [`${PHASE_REL}/03-RESEARCH.md`]: 'See `src/ok/seen.js`.\n',
        },
      });
      const r = collectPhaseInputs({ phaseDir: path.resolve(fs.cwd, PHASE_REL), deps: { listDir: fs.deps.listDir, readFile: fs.deps.readFile } });
      assert.deepEqual(r.files, ['src/ok/seen.js']);
      assert.deepEqual(
        r.warnings.map((w) => w.code),
        ['doc_too_large'],
      );
    });

    it('unreadableDocIsSkippedWithWarning', () => {
      const fs = memfs({ files: { [`${PHASE_REL}/03-CONTEXT.md`]: 'x `src/a/b.js`' } });
      const failing = (p) => {
        if (p.endsWith('03-CONTEXT.md')) throw new Error('EIO');
        return fs.deps.readFile(p);
      };
      const r = collectPhaseInputs({ phaseDir: path.resolve(fs.cwd, PHASE_REL), deps: { listDir: fs.deps.listDir, readFile: failing } });
      assert.deepEqual(r.files, []);
      assert.deepEqual(
        r.warnings.map((w) => w.code),
        ['doc_unreadable'],
      );
    });

    it('planOverSizeCapIsUnreadable', () => {
      const fs = memfs({ files: { [`${PHASE_REL}/03-01-PLAN.md`]: PLAN_TEXT } });
      const deps = { listDir: fs.deps.listDir, readFile: fs.deps.readFile, realpath: fs.deps.realpath, statSize: () => MAX_DOC_BYTES + 1 };
      const r = collectPhaseInputs({ phaseDir: path.resolve(fs.cwd, PHASE_REL), deps });
      assert.equal(r.plans.length, 1);
      assert.equal(r.plans[0].ok, false);
      assert.equal(r.plans[0].error, 'plan too large');
      assert.deepEqual(fs.calls.readFile, []);
    });

    it('symlinkedDocOutsidePhaseSkipped', () => {
      const fs = memfs({
        files: { [`${PHASE_REL}/03-RESEARCH.md`]: 'See `src/ok/seen.js`.\n' },
        links: { [`${PHASE_REL}/03-CONTEXT.md`]: '/elsewhere/secret.md', [`${PHASE_REL}/03-01-PLAN.md`]: '/elsewhere/plan.md' },
      });
      const deps = { listDir: fs.deps.listDir, readFile: fs.deps.readFile, realpath: fs.deps.realpath, statSize: () => 10 };
      const r = collectPhaseInputs({ phaseDir: path.resolve(fs.cwd, PHASE_REL), deps });
      assert.ok(r.warnings.some((w) => w.code === 'doc_outside_phase'));
      assert.deepEqual(r.files, ['src/ok/seen.js']);
      assert.equal(r.plans.length, 1);
      assert.equal(r.plans[0].ok, false);
      assert.equal(r.plans[0].error, 'outside phase directory');
      assert.ok(!fs.calls.readFile.some((p) => p.endsWith('03-CONTEXT.md') || p.endsWith('-PLAN.md')));
    });
  });
});

const { projectionOf, isProjected, protectedFiles, normalizeToken } = require('../lib/phase.cjs');
const { testOrder, order } = require('./helpers/fixtures.cjs');

describe('phase projection', () => {
  const FULL = testOrder({
    id: 'T-1',
    statement: 'Never double refund.',
    check_target: 'tests/x.test.cjs',
    check_violation_fixture: 'tests/fixtures/bad.js',
    check_clean_fixture: 'tests/fixtures/good.js',
  });
  const BACKSTOP = order({ id: 'B-1', statement: 'Be fair.' });

  it('exportsNormalizeToken', () => {
    assert.equal(typeof normalizeToken, 'function');
    assert.equal(normalizeToken('./a//b\\c'), 'a/b/c');
  });

  it('projectionOfTestOrder', () => {
    assert.deepEqual(projectionOf(FULL), {
      section: 'prohibitions',
      item: {
        statement: 'T-1: Never double refund.',
        status: 'resolved',
        verification: 'test',
        check_kind: 'node-test',
        check_target: 'tests/x.test.cjs',
        check_violation_fixture: 'tests/fixtures/bad.js',
        check_clean_fixture: 'tests/fixtures/good.js',
      },
    });
    const lint = testOrder({ id: 'L-1', statement: 'No eval.', check_kind: 'lint-rule', check_target: 'src/billing/refund.js', check_rule: 'local/no-eval' });
    assert.deepEqual(projectionOf(lint).item, {
      statement: 'L-1: No eval.',
      status: 'resolved',
      verification: 'test',
      check_kind: 'lint-rule',
      check_target: 'src/billing/refund.js',
      check_rule: 'local/no-eval',
      check_violation_fixture: 'tests/fixtures/bad.js',
      check_clean_fixture: 'tests/fixtures/good.js',
    });
  });

  it('projectionOfOmitsEmptyOptionals', () => {
    const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    const bare = testOrder({ id: 'T-2', statement: 'S.', check_violation_fixture: null, check_clean_fixture: null });
    assert.deepEqual(projectionOf(bare).item, {
      statement: 'T-2: S.',
      status: 'resolved',
      verification: 'test',
      check_kind: 'node-test',
      check_target: 'tests/x.test.cjs',
    });
    const stray = testOrder({ id: 'T-3', statement: 'S.', check_rule: 'local/stray', check_violation_fixture: '', check_clean_fixture: 7 });
    const item = projectionOf(stray).item;
    assert.equal(has(item, 'check_rule'), false, 'a node-test never carries a rule');
    assert.equal(has(item, 'check_violation_fixture'), false);
    assert.equal(has(item, 'check_clean_fixture'), false);
    const emptyRule = testOrder({ id: 'L-2', statement: 'S.', check_kind: 'lint-rule', check_rule: '' });
    assert.equal(has(projectionOf(emptyRule).item, 'check_rule'), false);
    const noTarget = testOrder({ id: 'T-4', statement: 'S.', check_target: null });
    assert.equal(projectionOf(noTarget).item.check_target, '');
  });

  it('projectionOfBackstop', () => {
    assert.deepEqual(projectionOf(BACKSTOP), { section: 'truths', item: { statement: 'B-1: Be fair.', verification: 'backstop' } });
    assert.equal(projectionOf({ id: 'X-1', statement: 'S.', verification: 'judgment' }).section, 'truths');
    assert.doesNotThrow(() => projectionOf({}));
  });

  it('isProjectedTestMatch', () => {
    assert.equal(isProjected(FULL, { prohibitions: [projectionOf(FULL).item] }), true);
    assert.equal(isProjected(FULL, { truths: ['x'], prohibitions: ['y', projectionOf(FULL).item] }), true);
  });

  it('isProjectedNormalizesTarget', () => {
    for (const spelled of ['./tests/x.test.cjs', 'tests\\x.test.cjs', 'tests//x.test.cjs']) {
      const item = { ...projectionOf(FULL).item, check_target: spelled };
      assert.equal(isProjected(FULL, { prohibitions: [item] }), true, spelled);
    }
  });

  it('isProjectedRejectsMismatches', () => {
    const good = projectionOf(FULL).item;
    assert.equal(isProjected(FULL, { prohibitions: [{ ...good, verification: 'judgment' }] }), false);
    assert.equal(isProjected(FULL, { prohibitions: [{ ...good, check_kind: 'lint-rule' }] }), false);
    assert.equal(isProjected(FULL, { prohibitions: [{ ...good, check_target: 'tests/other.test.cjs' }] }), false);
    assert.equal(isProjected(FULL, { prohibitions: [{ ...good, statement: 'T-1-X: Never double refund.' }] }), false);
    assert.equal(isProjected(FULL, { prohibitions: [{ ...good, statement: 'XT-1: Never double refund.' }] }), false);
    assert.equal(isProjected(FULL, { prohibitions: [{ ...good, statement: 'T-2: Never double refund.' }] }), false);
    assert.equal(isProjected(FULL, { truths: [good] }), false, 'a test order is projected into prohibitions, not truths');
  });

  it('isProjectedHostileShapes', () => {
    const good = projectionOf(FULL).item;
    const shapes = [null, undefined, 'text', 7, [], [good], {}, { prohibitions: 'x' }, { prohibitions: {} }, { prohibitions: null }, { prohibitions: [1, 'T-1: x', null, [], undefined] }];
    for (const mustHaves of shapes) {
      assert.doesNotThrow(() => isProjected(FULL, mustHaves));
      assert.equal(isProjected(FULL, mustHaves), false, JSON.stringify(mustHaves));
    }
    assert.equal(isProjected(FULL, { prohibitions: [{ ...good, statement: 5 }] }), false);
    assert.equal(isProjected(FULL, { prohibitions: [{ ...good, statement: undefined }] }), false);
    const numeric = testOrder({ id: '12', statement: 'S.' });
    assert.equal(isProjected(numeric, { prohibitions: [projectionOf(numeric).item] }), true, 'a number-like id still projects');
  });

  it('isProjectedBackstop', () => {
    const item = projectionOf(BACKSTOP).item;
    assert.equal(isProjected(BACKSTOP, { truths: [item] }), true);
    assert.equal(isProjected(BACKSTOP, { truths: ['B-1: Be fair.'] }), false, 'a plain string citation is not a projection');
    assert.equal(isProjected(BACKSTOP, { truths: [{ statement: 'B-1: Be fair.' }] }), false);
    assert.equal(isProjected(BACKSTOP, { truths: [{ statement: 'B-1: Be fair.', verification: 'judgment' }] }), false);
    assert.equal(isProjected(BACKSTOP, { prohibitions: [item] }), false);
    assert.equal(isProjected(BACKSTOP, { truths: [{ statement: 'B-10: Be fair.', verification: 'backstop' }] }), false);
  });

  it('protectedFilesNodeTest', () => {
    assert.deepEqual(protectedFiles(FULL), ['tests/x.test.cjs', 'tests/fixtures/bad.js', 'tests/fixtures/good.js']);
    const spelled = testOrder({
      id: 'T-5',
      check_target: './tests/x.test.cjs',
      check_violation_fixture: 'tests\\fixtures\\bad.js',
      check_clean_fixture: './tests/fixtures/bad.js',
    });
    assert.deepEqual(protectedFiles(spelled), ['tests/x.test.cjs', 'tests/fixtures/bad.js']);
    const sparse = testOrder({ id: 'T-6', check_violation_fixture: '', check_clean_fixture: 'tests/fixtures/good.js' });
    assert.deepEqual(protectedFiles(sparse), ['tests/x.test.cjs', 'tests/fixtures/good.js']);
  });

  it('protectedFilesLintRuleExcludesTarget', () => {
    const lint = testOrder({ id: 'L-1', check_kind: 'lint-rule', check_target: 'src/billing/refund.js', check_rule: 'local/r' });
    assert.deepEqual(protectedFiles(lint), ['tests/fixtures/bad.js', 'tests/fixtures/good.js']);
    const lintNoFixtures = testOrder({ id: 'L-2', check_kind: 'lint-rule', check_target: 'src/a.js', check_rule: 'local/r', check_violation_fixture: null, check_clean_fixture: null });
    assert.deepEqual(protectedFiles(lintNoFixtures), []);
  });

  it('protectedFilesBackstopEmpty', () => {
    const backstop = order({ id: 'B-2', check_kind: 'node-test', check_target: 'tests/x.test.cjs', check_violation_fixture: 'tests/fixtures/bad.js', check_clean_fixture: 'tests/fixtures/good.js' });
    assert.deepEqual(protectedFiles(backstop), []);
    assert.deepEqual(protectedFiles({ id: 'J', verification: 'judgment', check_target: 'x' }), []);
    assert.deepEqual(protectedFiles({}), []);
  });
});

describe('phase canonical paths and strict projection', () => {
  const { canonicalPath, projectionOf: projOf, isProjected: isProj } = require('../lib/phase.cjs');
  const SPELLINGS = ['./tests/a.test.cjs', 'tests/./a.test.cjs', 'tests/x/../a.test.cjs', 'Tests/A.test.cjs', 'tests/a.test.cjs/', ' tests/a.test.cjs ', 'tests\\a.test.cjs', 'tests//a.test.cjs'];

  it('canonicalPathCases', () => {
    const want = canonicalPath('tests/a.test.cjs');
    assert.equal(want, 'tests/a.test.cjs');
    for (const s of SPELLINGS) assert.equal(canonicalPath(s), want, s);
    assert.notEqual(canonicalPath('tests/a.test.cjs.bak'), want);
    assert.notEqual(canonicalPath('tests/b.test.cjs'), want);
    assert.equal(canonicalPath(''), '');
    assert.equal(canonicalPath('.'), '');
  });

  describe('isProjectedIsStrict', () => {
    const T = testOrder({ id: 'T-1', statement: 'Never double refund.', check_target: 'tests/a.test.cjs', check_violation_fixture: 'tests/fixtures/bad.js', check_clean_fixture: 'tests/fixtures/good.js' });
    const good = projOf(T).item;
    const ok = (item, o = T) => isProj(o, { prohibitions: [item] });

    it('requiresIdPrefix', () => {
      assert.equal(ok(good), true);
      assert.equal(ok({ ...good, statement: 'we do not follow T-1 at all' }), false);
      assert.equal(ok({ ...good, statement: '  T-1: Never double refund.' }), true);
      const b = order({ id: 'B-1', statement: 'Be fair.' });
      assert.equal(isProj(b, { truths: [{ statement: 'we do not follow B-1 at all', verification: 'backstop' }] }), false);
    });

    it('requiresResolvedStatus', () => {
      assert.equal(ok({ ...good, status: 'pending' }), false);
      const { status, ...noStatus } = good;
      assert.equal(ok(noStatus), false);
    });

    it('requiresFixtures', () => {
      const { check_violation_fixture: v, ...noViolation } = good;
      const { check_clean_fixture: c, ...noClean } = good;
      assert.equal(ok(noViolation), false);
      assert.equal(ok(noClean), false);
      assert.equal(ok({ ...good, check_violation_fixture: 'tests/fixtures/other.js' }), false);
      assert.equal(ok({ ...good, check_clean_fixture: 'tests/fixtures/other.js' }), false);
    });

    it('requiresRule', () => {
      const L = testOrder({ id: 'L-1', statement: 'No eval.', check_kind: 'lint-rule', check_target: 'src/a.js', check_rule: 'local/no-eval' });
      const item = projOf(L).item;
      assert.equal(ok(item, L), true);
      assert.equal(ok({ ...item, check_rule: 'local/other' }, L), false);
    });

    it('acceptsEquivalentSpellings', () => {
      for (const s of SPELLINGS) {
        assert.equal(ok({ ...good, check_target: s }), true, s);
        const fx = s.replace(/a\.test\.cjs/i, 'fixtures/bad.js');
        assert.equal(ok({ ...good, check_violation_fixture: fx }), true, fx);
      }
    });
  });
});
