'use strict';

// Phase 5 (#6): the two skills are shipped prose that is installed verbatim into the agent's context.
// Rows 59 (manifest <-> files) and 61 (the confirmation rules the skills state).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SKILLS_DIR = path.join(ROOT, 'skills');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'capability.json'), 'utf8'));
const PROMOTE = 'standing-orders-promote';
const REVIEW = 'standing-orders-conflict-review';
const HARDEN = 'standing-orders-harden';

function skillStems() {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(SKILLS_DIR, e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort();
}

// The SKILL.md is the product: reading it as data is the behavioral check (#6).
const skillText = (stem) => fs.readFileSync(path.join(SKILLS_DIR, stem, 'SKILL.md'), 'utf8');

/** The `---` frontmatter of a SKILL.md as { key: value } (single-line values only). */
function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assert.ok(m, 'the skill starts with a --- frontmatter block');
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

/** Every command a skill tells the agent to run: fenced-block lines and backticked spans that start with a runner. */
function commandsIn(text) {
  const found = [];
  const fenced = text.matchAll(/```[a-z]*\r?\n([\s\S]*?)```/g);
  for (const block of fenced) {
    for (const line of block[1].split(/\r?\n/)) if (line.trim() !== '') found.push(line.trim());
  }
  const stripped = text.replace(/```[a-z]*\r?\n[\s\S]*?```/g, '');
  for (const span of stripped.matchAll(/`([^`\n]+)`/g)) {
    if (/^(gsd_run|gsd-tools)\b/.test(span[1])) found.push(span[1]);
  }
  return found;
}

describe('skills: manifest and files agree', () => {
  it('manifestSkillsMatchFiles', () => {
    const stems = skillStems();
    assert.deepEqual([...MANIFEST.skills].sort(), stems, 'capability.json skills equals the directories under skills/ that hold a SKILL.md');
    assert.deepEqual(stems, [REVIEW, PROMOTE, HARDEN].sort());

    for (const stem of stems) {
      const fm = frontmatter(skillText(stem));
      assert.equal(fm.name, `gsd-${stem}`, `${stem}: frontmatter name`);
      assert.ok(typeof fm.description === 'string' && fm.description.trim().length > 20, `${stem}: a description line`);
    }

    const declared = new Set(MANIFEST.skills);
    const stepSkills = MANIFEST.steps.filter((s) => s.ref && s.ref.skill !== undefined);
    assert.ok(stepSkills.length >= 1, 'a step runs a skill');
    for (const s of stepSkills) assert.ok(declared.has(s.ref.skill), `step skill ${s.ref.skill} is declared in skills`);

    const verdictGates = MANIFEST.gates.filter((g) => g.check && g.check.agentVerdict !== undefined);
    assert.ok(verdictGates.length >= 1, 'a gate asks for an agent verdict');
    for (const g of verdictGates) {
      assert.ok(declared.has(g.check.agentVerdict.ref), `agentVerdict ref ${g.check.agentVerdict.ref} is a declared skill`);
      assert.equal(g.blocking, false, 'the semantic review is advisory: it never blocks');
      assert.equal(g.when, 'standing-orders.enabled');
      assert.equal(g.onError, 'skip');
      assert.equal(typeof g.check.agentVerdict.prompt, 'string');
      assert.ok(g.check.agentVerdict.prompt.length > 0);
    }

    const promoteStep = MANIFEST.steps.find((s) => s.ref && s.ref.skill === PROMOTE);
    assert.ok(promoteStep, 'the promote skill has a step');
    assert.equal(promoteStep.point, 'discuss:post');
    assert.equal(promoteStep.when, 'standing-orders.enabled');
    assert.equal(promoteStep.onError, 'skip');
    const reviewGate = verdictGates.find((g) => g.check.agentVerdict.ref === REVIEW);
    assert.ok(reviewGate, 'the conflict-review skill has a gate');
    assert.equal(reviewGate.point, 'discuss:post');
  });

  it('manifestAddsNoUngatedPhase5Hooks', () => {
    // every hook that mentions a phase-5 skill is gated on the activation key, so a disabled project is unchanged (AC5)
    const hooks = [...MANIFEST.steps, ...MANIFEST.gates];
    const skillHooks = hooks.filter((h) => JSON.stringify(h).includes('standing-orders-promote') || JSON.stringify(h).includes('standing-orders-conflict-review'));
    assert.equal(skillHooks.length, 2);
    for (const h of skillHooks) assert.equal(h.when, MANIFEST.activationKey);
  });
});

describe('skills: the confirmation rules', () => {
  it('skillsStateTheConfirmationRules', () => {
    const promote = skillText(PROMOTE);
    assert.match(promote, /one question per candidate/i, 'one question per candidate');
    assert.match(promote, /promote --candidates/, 'lists candidates through the CLI');
    assert.match(promote, /promote --add/, 'writes through the CLI');
    assert.match(promote, /exactly one order per call/i, 'one --add per Promote');
    assert.match(promote, /never (promote|edit)/i);
    assert.match(promote, /auto mode never promotes/i, 'unattended runs promote nothing');
    assert.match(promote, /check auto-mode --pick auto_chain_active/, 'detects auto mode the way the host does');
    assert.match(promote, /batch_refused/, 'knows a list is refused');
    assert.match(promote, /standing-orders validate/, 'ends by pointing at validate');
    assert.match(promote, /Never edit ORDERS\.yaml yourself/i);

    const review = skillText(REVIEW);
    assert.match(review, /never dismisses/i, 'never dismisses without the human');
    assert.match(review, /never confirm or dismiss/i, 'auto mode never decides');
    assert.match(review, /semantic propose/);
    assert.match(review, /semantic resolve/);
    assert.match(review, /semantic list/);
    assert.match(review, /--auto/, 'proposals made unattended are marked');
    assert.match(review, /--reason/, 'a dismissal carries a reason');
    assert.match(review, /blank reason is not a dismissal/i, 'a blank reason is not a dismissal');
    assert.match(review, /advisory:/, 'ends with the advisory verdict line');
    assert.match(review, /never (block|report a block)/i, 'never blocks');
    assert.match(review, /never edits ORDERS\.yaml/i);
    assert.match(review, /select --phase/, 'refreshes the applicable orders first');
    assert.match(review, /CONFLICTS\.json/, 'does not repeat what the deterministic check reports');
    assert.match(review, /recall/i);
    assert.match(review, /precision/i);
    assert.match(review, /check auto-mode --pick auto_chain_active/);
  });

  it('skillsRunOnlyTheStandingOrdersCommands', () => {
    const allowed = [
      /^gsd_run standing-orders (promote|semantic|select|validate|mutants)\b/,
      /^gsd-tools standing-orders (promote|semantic|select|validate|mutants)\b/,
      /^gsd_run query check auto-mode --pick auto_chain_active$/,
      /^gsd-tools query check auto-mode --pick auto_chain_active$/,
    ];
    for (const stem of [PROMOTE, REVIEW, HARDEN]) {
      const commands = commandsIn(skillText(stem));
      assert.ok(commands.length > 0, `${stem} tells the agent to run something`);
      for (const c of commands) assert.ok(allowed.some((re) => re.test(c)), `${stem}: ${c} is not a standing-orders or auto-mode command`);
    }
  });
});

// Phase 6 (#7), ADR-0002 section 4. Rows 53 (the harden skill), 54 (manifest) and the promote hand-off (K3).
describe('skills: the harden skill', () => {
  const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  // row 53
  it('hardenSkillShipped', () => {
    assert.ok(skillStems().includes(HARDEN), 'skills/standing-orders-harden/SKILL.md exists');
    const text = skillText(HARDEN);
    const fm = frontmatter(text);
    assert.equal(fm.name, `gsd-${HARDEN}`);
    assert.ok(fm.description.trim().length > 20);
    assert.match(fm.description, /mutant/i);

    assert.match(text, /up to three mutants/i, 'proposes a handful, not a flood');
    assert.match(text, /equivalence argument/i, 'argues each mutant is not equivalent');
    assert.match(text, /never add a mutant the user did not confirm/i, 'adds nothing unconfirmed');
    assert.match(text, /own confirmation|one question per mutant|about that mutant only/i, 'one confirmation per mutant');
    assert.match(text, /auto mode never adds a mutant/i, 'unattended runs add nothing');
    assert.match(text, /check auto-mode --pick auto_chain_active/, 'detects auto mode the way the host does');
    assert.match(text, /mutants --order/, 'reads the current state through the CLI');
    assert.match(text, /mutants --add/, 'writes through the CLI');
    assert.match(text, /mutants --run/, 'runs them');
    assert.match(text, /batch_refused/, 'knows a list is refused');
    assert.match(text, /Never edit ORDERS\.yaml/i, 'never edits the rules file itself');
    assert.ok(text.indexOf('mutants --run') > text.indexOf('mutants --add'), 'the run comes after the adds');
    assert.ok(text.lastIndexOf('mutants --run') > text.lastIndexOf('mutants --add'), 'the skill ends by running them');

    // shell-safe JSON: single quotes around the argument, and every apostrophe inside written as '\'' (as the promote skill does)
    assert.ok(text.includes("--add '{"), 'the JSON argument is single-quoted');
    assert.ok(text.includes("'\\''"), 'apostrophes inside the JSON are escaped as \'\\\'\'');
    assert.ok(skillText(PROMOTE).includes("'\\''"), 'the same convention as the promote skill');
    for (const code of ['path_invalid', 'path_outside_project', 'path_reserved', 'mutant_is_check_file', 'mutant_exists', 'content_invalid', 'order_not_test', 'manual']) {
      assert.ok(text.includes(code), `the skill knows the refusal ${code}`);
    }
  });

  // K3
  it('promoteSkillOffersHardening', () => {
    const promote = skillText(PROMOTE);
    assert.match(promote, /offer the `?gsd-standing-orders-harden`? skill/i, 'after adding a test order, the promotion skill offers it');
    assert.match(promote, /\btest\b[^.]*\bgsd-standing-orders-harden/i, 'and only for test orders');
  });

  // row 54, K2
  it('manifestPhase6', () => {
    assert.equal(MANIFEST.version, '0.6.0');
    assert.equal(PACKAGE.version, '0.6.0');
    assert.deepEqual(MANIFEST.skills, [PROMOTE, REVIEW, HARDEN]);
    assert.deepEqual(MANIFEST.commands[0].subcommands, ['select', 'conflicts', 'coverage', 'enforce', 'trace', 'impact', 'stale', 'validate', 'promote', 'semantic', 'mutants']);
    // no new loop wiring: the same five steps, five gates and one contribution, none of them naming the new skill or command
    assert.equal(MANIFEST.steps.length, 5);
    assert.equal(MANIFEST.gates.length, 5);
    assert.equal(MANIFEST.contributions.length, 1);
    for (const hook of [...MANIFEST.steps, ...MANIFEST.gates, ...MANIFEST.contributions]) {
      assert.ok(!JSON.stringify(hook).includes(HARDEN), 'the harden skill is run by hand, not wired to a loop point');
      assert.ok(!JSON.stringify(hook).includes('standing-orders mutants'), 'the mutants command is not a loop step');
    }
    assert.deepEqual(MANIFEST.steps.map((s) => s.point), ['discuss:post', 'plan:pre', 'plan:post', 'execute:wave:post', 'ship:pre']);
  });
});
