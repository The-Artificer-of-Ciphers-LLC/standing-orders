# ADR-0002: Mutation hardening of standing-order checks

- **Status:** Accepted (2026-11-08, by the maintainer, as part of the phase 6 pull request)
- **Date:** 2026-11-08
- **Issue:** [#7](https://github.com/The-Artificer-of-Ciphers-LLC/standing-orders/issues/7), phase 6 of epic [#1](https://github.com/The-Artificer-of-Ciphers-LLC/standing-orders/issues/1)
- **Builds on:** [ADR-0001](0001-standing-orders-architecture.md) §6.4 ("a surviving mutant downgrades the order to `flagged`"), A6 (enforce gate), A7 (trace), A8 (commands write, skills propose)
- **Host contract relied on:** gsd-core `check prohibition-enforcement` (`src/prohibition-enforcement.cts`), unchanged from ADR-0001 open question 3

## Context

A `test`-tier order is proven when gsd-core's prover sees its check go RED on one violation fixture and GREEN on the clean fixture. That is a single sample. A check can pass both runs and still miss most ways the order can be broken: it may test one literal value, one branch, or the exact shape of the one violation its author thought of. ADR-0001 §6.4 reserved phase 6 for closing that gap with concern-targeted mutants.

Meta's Automated Compliance Hardening (ACH) is the model: rather than generating thousands of syntactic mutants, an LLM writes a few faults that are specific to one concern, an equivalent-mutant detector filters the ones that do not change behaviour, and the survivors show where the tests are weak (Foster, Gulati, Harman et al., *Mutation-Guided LLM-based Test Generation at Meta*, FSE Companion '25, [arXiv:2501.12862](https://arxiv.org/abs/2501.12862)). Two numbers from that paper shape this decision. Its LLM equivalence detector reached precision 0.79 and recall 0.47 on its own, so a machine filter alone lets many equivalent mutants through. And engineers accepted 73% of the tests it produced, so a human review step is affordable.

Facts read from gsd-core 1.19.0 and 1.20.1:

- The prover's request carries one `check.violationFixture` and one `check.cleanFixture`. For `node-test` it runs the check with `GSD_PROHIB_SUBJECT` set to each, and requires RED on the violation and GREEN on the clean control. For `lint-rule` it lints the violation file and requires the rule id to appear.
- So a mutant is just another violation fixture. Running the prover with `violationFixture` set to the mutant and the unchanged clean fixture asks exactly "does this check catch this fault?". Nothing has to be copied from the prover into this repository, which keeps ADR-0001's "call the public verb" decision intact.

## Decision

Confirmed by the maintainer on 2026-11-08.

### 1. Mutants are stored files listed on the order

A new optional order field, `check_mutants`, lists project-relative paths. Each file is a known-bad variant of the check's subject: for `node-test`, a copy of the clean fixture with one concern-relevant fault seeded; for `lint-rule`, a file that violates `check_rule` in a way the violation fixture does not.

```yaml
  - id: REFUND-IDEMPOTENT
    verification: test
    check_kind: node-test
    check_target: tests/billing/refund-idempotent.test.cjs
    check_violation_fixture: tests/fixtures/billing/double-refund.js
    check_clean_fixture: tests/fixtures/billing/single-refund.js
    check_mutants:
      - tests/fixtures/billing/mutants/refund-retry-after-timeout.js
      - tests/fixtures/billing/mutants/refund-key-ignores-currency.js
```

Validation (`validate`, and every command that loads `ORDERS.yaml`):

- The same path twice, or a path equal to the order's `check_target`, `check_violation_fixture` or `check_clean_fixture`, is an error.
- `check_mutants` must be a list of non-empty strings; an absolute path or one with a `..` segment is an error.
- `check_mutants` on a `backstop` order gets the existing `check_ignored_for_backstop` warning, like every other `check_*` field there; it never runs.
- A `test` order with no `check_mutants` gets the warning `no_mutants`. Hardening is opt-in: the order is enforced exactly as before.
- `check_mutants` is a set for hashing: it is sorted and de-duplicated in the canonical form behind `order_hash` (ADR-0001 A7). Adding a mutant changes the order's hash, so `stale` reports the order `changed` until the next shipped phase traces it. That is intended: the check became stricter.

### 2. Enforce runs them, and a survivor flags the order

`standing-orders enforce` (execute:wave:post) runs the order's base check exactly as today. Only when the base result is `green` and unflagged does it run the mutants, one prover call each, in path order, with the same request except `check.violationFixture = <mutant>`. Each mutant's outcome is:

| Outcome | When |
| --- | --- |
| `killed` | The host answered `status: green`, `flagged: false`. The check went RED on the mutant and GREEN on the clean fixture. |
| `survived` | The host answered with anything else. The check did not catch the fault (or the clean control failed). |
| `error` | No usable answer: the mutant file is missing or unreadable, the host CLI is absent, the call timed out, exited non-zero or printed unreadable output. |

The order's result is flagged when any mutant `survived` or ended in `error`, with reason `mutant_survived: <paths>` or `mutant_unverified: <paths>`. The result gains a `mutants` list (`path`, `outcome`, `cached`, `reason`), written to `ENFORCEMENT.json`. Nothing else in the gate changes: `evaluateEnforcement` already treats any flagged result as `enforcement: flagged`, which the blocking gate rejects, and `trace` already records a flagged order as `flagged`. Each mutant call has the same 180 s bound as the base call (ADR-0001 A6).

### 3. Results are cached by content

A mutant run's answer depends on the check, the files it reads, and any code those import. So `enforce` caches definitive answers (`killed`, `survived`; never `error`) in `.planning/standing-orders/MUTANTS.json`, keyed by `sha256` over the canonical JSON of `{check_kind, check_rule, target: sha256(check_target), clean: sha256(check_clean_fixture), mutant: sha256(mutant), code: <HEAD tree id>}`. Any edit to the check, the clean fixture or the mutant, and any new commit, changes the key, and the mutant runs again. The cache therefore saves repeated runs within one commit, such as a re-run wave, and never trusts an answer across a code change. A working tree with uncommitted changes outside `.planning/`, or a `git` that is absent, slow (10 s bound) or answers oddly, means the cache is neither read nor written for that run: every mutant runs. Git is only consulted when some order has mutants.

A mutant is `survived` only when the host located and ran the check (`located: true`) and did not answer `green` and unflagged. Any other non-green answer is `error`, so a host-side failure can never be cached as a survivor. A missing, oversized, symbolic-link or unparseable cache is treated as empty and rewritten. `enforce --no-cache` ignores what is stored, runs every mutant, and still writes fresh answers.

The cache is protected like the check files: the `plan:post` coverage rule (ADR-0001 A6, R11) also rejects a plan whose `files_modified` names a `check_mutants` path of an applicable `test` order, or `.planning/standing-orders/MUTANTS.json`.

### 4. Mutants are proposed by a skill and written by a command

Following A8, judgment lives in a skill and every write goes through a command whose rules are tested:

- **`standing-orders mutants --order <id>`** lists the order's mutants, whether each file exists, and its cached outcome. It only reads, so it answers whether or not `standing-orders.enabled` is set, like `validate`.
- **`standing-orders mutants --add '<json>'`** takes exactly one `{order, path, content?}` object and refuses a list. Paths are canonicalized (slashes, `.` and `..` segments) before any check. It refuses an order that is not `test`, a path outside the project, under `.planning/`, or equal to one of the order's check files. With `content`, the file must not exist yet and the command writes it (1 to 65536 bytes). Without `content`, the file must already exist, be a regular file inside the project and within the same size bound, and the command only registers it. The skill uses the second form so that code never travels on a command line, where Windows caps a command at 32,767 characters. It inserts the path into the order's `check_mutants` as text, so comments and layout survive, re-parses the result, and writes only if every other order's hash is unchanged and this order differs only by the added path. Otherwise it writes nothing and fails with code `manual`, returning the YAML to paste (`paste`) and the mutant file content (`content`), much as `promote --add` returns a `paste` block. Like `promote`, it writes nothing while the capability is disabled.
- **`standing-orders mutants --run --order <id>`** runs the base check and the order's mutants now, through the same code `enforce` uses, updates the cache, prints each outcome, and exits 1 when any mutant survived or errored. It lets an author see whether a new mutant is caught without waiting for an execute wave.
- **Skill `standing-orders-harden`** (named in the manifest, not wired to a loop point; the promotion skill offers it after a `test` order is added). For one order it reads the statement, the check and the clean fixture, and proposes up to three mutants: each a minimal edit of the clean fixture that breaks the order's statement in a way the violation fixture does not. For each one it states why the behavior differs with respect to the order (the equivalence argument), shows the diff, and asks the user to confirm. Only a confirmed mutant is added, one `--add` call each. In auto mode it proposes and adds nothing. After adding, it runs `mutants --run` and explains a survivor: either the check is too weak (strengthen the check, which is outside any executing phase), or the mutant is equivalent (remove it from `ORDERS.yaml`).

No new loop step or gate is declared. With `standing-orders.enabled` false, output stays byte-identical to a project without the capability (acceptance criterion 5).

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| Runtime mutation engine (Stryker-style) over the code in `scope.paths` | Adds an npm dependency the capability does not have, produces generic syntactic mutants rather than faults aimed at the order, and mutates production code the check was never written to exercise. |
| Mutants written by hand only, no skill | Workable but leaves the ACH half of §6.4 undone; the command and field still allow it, since the skill is optional. |
| A test order with no mutants is `flagged` | Fail-closed but would turn every existing project's enforcement red on upgrade. Rejected for the `no_mutants` warning. |
| Run every mutant on every wave, no cache | Nothing to forge, but N orders × M mutants × two test runs per wave for answers that cannot change while the check files are frozen. |
| Cache only between waves, re-verify at ship | Catches a forged cache entry, at the cost of a second runner at `ship:pre`, where `trace` never calls the prover. Rejected for plan-level protection plus `--no-cache`. |
| Copy the prover and loop over fixtures in-process | Two provers drift; ADR-0001 already rejected it. |

## Consequences

**Positive**
- A check that only catches the one violation its author imagined is now visible as `flagged`, with the surviving faults named.
- Reuses the host prover unchanged; no new dependency; no new loop wiring.
- Opt-in per order; existing projects see only a warning.

**Negative / known limits**
- Each mutant is one more prover call per enforce run after each commit. Because the key includes the HEAD tree (decided by the maintainer after the security review), the cache only saves re-runs within one commit; it never trusts an answer across a code change, including a change to a helper the check imports.
- `MUTANTS.json` is protected at plan level, like the check files themselves. An executor that edits files outside its plan's `files_modified` could forge a `killed` entry, exactly as it could edit a check. Review of the executed diff, or `--no-cache`, is the remedy. This is the same trust boundary ADR-0001 §6 already accepts.
- Mutants grade the check against faults seeded in its subject fixture, not in production code. They measure how sensitive the check is to the concern, not production coverage.
- Whether a mutant is equivalent is a judgment. The skill argues it and a human confirms; CI tests the command's rules, never the LLM's choice of mutants (ADR-550 D5, as in A8).

## Rollout

One pull request for issue #7, holding this ADR and its implementation: schema field and validation, hash, enforce + cache, coverage protection, the `mutants` subcommand, the `standing-orders-harden` skill, reference and how-to documentation, and manifest version 0.6.0.
