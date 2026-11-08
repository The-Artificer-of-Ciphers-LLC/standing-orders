# Standing Orders — schema and protocol reference

This is the reference for `ORDERS.yaml` and the `standing-orders` command family. It states exact semantics; the explanation of *why* the capability is shaped this way lives in [ADR-0001](../docs/adr/0001-standing-orders-architecture.md) and the requirements in [PRD-0001](../docs/prd/0001-standing-orders.md).

The enum tables below are checked by a test against the constants the parser enforces (`tests/reference-parity.test.cjs`), so this page cannot drift from the code.

## File location

`.planning/standing-orders/ORDERS.yaml`, relative to the project root. Human-owned and reviewed in git. The capability never writes it.

## Parsing posture (untrusted input)

- Parsed with js-yaml 4.3.2 (vendored) under `FAILSAFE_SCHEMA`: **every scalar is a string**. `outcome: 1` is the string `"1"`; `statement: true` is the string `"true"`.
- **Anchors and aliases are refused** (`&name`, `*name`) with `yaml_anchor_refused`, by a text scan that stops at the first one it finds and runs before any document is built: nothing is expanded, and the file is not loaded into orders. (The scan is a refusal, not a parse; it does not claim that no byte of the file was read.)
- A bare merge key with no alias (`<<: {…}`) is not an anchor and is not caught by that scan. It has nothing to merge under `FAILSAFE_SCHEMA`, so it is read as a plain key named `<<` and rejected as `unknown_key` (or `missing_field`, when the order lacks a required field).
- A NUL byte is rejected (`yaml_null_byte`). A leading BOM is stripped. CRLF and LF parse identically.
- A duplicated mapping key is a parse error (`yaml_syntax`), never last-wins: a second `orders:` key would otherwise silently replace the first.
- Unknown keys, unknown enum values and an unsupported `version` are **errors**, not warnings. Typos fail loudly. Every string field must be non-empty (`type_invalid` otherwise).
- The file must be at most 262,144 bytes (256 KiB); larger files are refused before being read (`file_too_large`).

## Document

```yaml
version: 1            # required; the string "1"
contexts:             # optional mapping of context name -> definition
  <name>:
    description: <string>          # optional
    includes: [<name>, ...]        # optional
    extends: <name>                # optional
orders:               # optional list; an empty project is valid
  - <order>
```

- **version** — one of: `1`. Any other value is `version_unsupported`.
- Allowed top-level keys: `version`, `contexts`, `orders`. Anything else is `unknown_key`.

## Contexts

A context name matches `^[a-z][a-z0-9-]*$` (`context_name_invalid` otherwise). Each definition is a mapping (`{}` for a plain context).

**Resolution.** Every context resolves to a closed set of **leaf** contexts:

- A context with no members is a leaf and resolves to `{ itself }`.
- `includes: [x, y]` makes `x` and `y` members; the context resolves to the union of their leaf sets.
- `extends: p` makes this context a member of `p`. It is the same membership edge as `p` including it, written from the child's side.
- A context that has members is **not itself a leaf**: it is exactly the union of its members. To keep a "plain" variant of a parent alongside specialisations, declare the plain variant as a member too (for example `contract-a-basic` and `contract-a-premium` both extending `contract-a`).
- Cycles (`context_cycle`) and references to undefined names (`undefined_context`) are errors. A membership chain thousands of contexts deep is refused with `context_too_deep` rather than crashing.

An order's **effective contexts** are the union of its named contexts' leaf sets, or every leaf when it names none. A document that declares no contexts has one universal context, written `*` in conflict reports, so its orders still overlap one another.

## Orders

```yaml
- id: REFUND-IDEMPOTENT
  kind: prohibition
  statement: "A refund for one payment is never executed more than once."
  operation: refund.execute
  contexts: [any-contract]
  scope:
    paths: ["src/billing/**"]
    requirements: [BILL-04]
  verification: test
  check_kind: node-test
  check_target: tests/billing/refund-idempotent.test.cjs
  check_violation_fixture: tests/fixtures/billing/double-refund.js
  check_clean_fixture: tests/fixtures/billing/single-refund.js
  source: "Contract terms §4.2"
```

| Key | Required | Meaning |
|---|---|---|
| `id` | yes | Unique within the file (`duplicate_id` otherwise). Cited by plans and by `TRACE.jsonl`. |
| `kind` | yes | See the enum below. |
| `statement` | yes | The rule in one sentence. Rendered verbatim, on one line, into `APPLICABLE.md`. |
| `operation` | variant: yes; otherwise optional | The operation the rule constrains (for example `refund.amount`). Conflicts are detected only between orders that name the same operation. |
| `outcome` | variant: yes; otherwise **forbidden** (`unknown_key_for_kind`) | What the operation produces under the order's contexts. |
| `contexts` | optional | Context names. Absent or `[]` means every context. |
| `scope` | optional | `paths` (minimal globs) and/or `requirements` (exact requirement ids). Absent, `{}`, or both lists empty means **global**: the order applies to every phase. |
| `verification` | yes | See the enum below. |
| `check_kind`, `check_target` | `test`: yes | The mechanical check, using gsd-core's field names so an order projects into a `must_haves.prohibitions` item unchanged. |
| `check_rule` | `lint-rule`: yes | The ESLint rule id the check asserts is clean. |
| `check_violation_fixture`, `check_clean_fixture` | `test`: recommended (warning `fixture_missing` if absent) | Known-bad and known-clean subjects for gsd-core's fail-first prover. Without them the prover cannot prove the check and reports it `flagged`. |
| `check_mutants` | `test`: optional (warning `no_mutants` if absent or empty) | Project-relative paths of extra violation fixtures (mutants) the check must also fail. See `standing-orders mutants`. Must be a list of non-empty relative paths without `..`, none under `.planning/`, no duplicates, none a check file of the order (`type_invalid`, `path_invalid`, `path_reserved`, `duplicate_mutant`, `mutant_is_check_file`). Every comparison (reserved, duplicate, check file) uses the canonical form of the path: `\` becomes `/`, repeated and `.` segments collapse, a trailing `/` goes, and case is ignored, so `.//.planning/x` is `.planning/x`. Order is irrelevant to the order's hash. |
| `source` | optional | Where the rule comes from (contract clause, decision id). |

Any `check_*` key (and `check_mutants`) on a `backstop` order is kept but never run (warning `check_ignored_for_backstop`).

### Enums

- **kind** — one of: `prohibition` | `invariant` | `variant`
  - A prohibition and an invariant hold across all their contexts. A variant states the outcome of an operation under its contexts.
- **verification** — one of: `test` | `backstop`
  - `test`: a mechanical check exists and is enforced fail-first.
  - `backstop`: the rule is known but has no mechanical check yet. It is legal, and the verifier reports it as `insufficient_spec`, never `passed`. gsd-core's own prohibition vocabulary is `test` or `judgment`; phase 3 maps `backstop` to `judgment` when projecting an order into a prohibition.
- **check_kind** — one of: `node-test` | `lint-rule`

## Scope matching

- `scope.paths` entries are minimal globs matched against forward-slash, project-relative paths. Backslashes are normalised to slashes on both sides, runs of slashes collapse to one, and leading `./` prefixes are ignored. Matching is segment by segment with a linear wildcard algorithm, so no pattern can make selection hang.
  - `*` matches anything within one path segment.
  - A segment that is exactly `**` matches zero or more whole segments, so a trailing `/**` matches the directory itself and anything below it. `**` inside other text (`a**b`) behaves like `*`.
  - `?` matches exactly one character within a segment.
  - Every other character is literal: `[`, `{`, `!`, `(` have no special meaning.
- `scope.requirements` match requirement ids exactly (case- and whitespace-sensitive).
- An order matches a phase when **any** path glob matches **any** phase file, **or** any requirement id matches. An order with no scope matches every phase.

## Conflicts (deterministic)

`standing-orders validate` reports, and the planning gates block on (see [Blocking rules](#blocking-rules)):

| Kind | Condition |
|---|---|
| `variant-outcome` | Two variants name the same `operation`, their effective contexts intersect, and their `outcome`s differ. Agreeing outcomes are not a conflict. |
| `prohibition-vs-variant` | A prohibition and a variant name the same `operation` and their effective contexts intersect. |
| `duplicate-id` | One `id` is used by more than one order. |

A prohibition and an invariant on one operation never conflict (both hold). Orders without an `operation` never conflict.

**Operations compare canonically.** Two `operation` values name the same operation when they are equal after Unicode compatibility decomposition (NFKD), lower-casing, and removing combining marks and zero-width characters (U+200B to U+200D, U+2060, U+FEFF) anywhere, then trimming surrounding whitespace: `refund.amount`, `Refund.Amount`, ` refund.amount `, a fullwidth `ｒefund.amount` and `refund.amount` with a zero-width space inside are one operation, and case and diacritics do not distinguish names, so `İ` (U+0130) and `i` match, as do `é` and `e` (precomposed or decomposed). The dotless `ı` (U+0131) is a distinct letter and does not match `i`. Anything else is a different operation (`refund.amounts` is not `refund.amount`).

A `test`-tier order whose `check_target` does not exist under the project root is reported under `missingChecks` with warning `check_target_missing`. It is not a conflict; whether it blocks planning is the `standing-orders.block_on` setting.

## APPLICABLE.md rendering

`standing-orders select` writes the applicable orders for a phase using this renderer:

- A header stating that the orders apply **in addition to** the phase's own `must_haves`, never instead of them.
- Orders in deterministic order: `test` tier before `backstop`, then by `id`.
- Whole orders are packed while the total, including the header and the footer, stays within `standing-orders.max_bytes` (default 6000, minimum 512) measured in UTF-8 bytes. An order is never truncated mid-body.
- Each order block ends with a `- Project as:` line: the exact `must_haves` item the planner copies into a plan (see *Projection*).
- Every rendered scalar is one line; control characters are replaced with U+FFFD.
- An applicable order that is stale (see *Trace*) gets a `- Stale: <reason> since last traced in <phase>; re-check this order before planning` line after `- Source:`, inside its block, so the byte cap counts it. With no `TRACE.jsonl`, or no stale applicable order, the output is unchanged.
- A footer always states `N applicable order(s) omitted to stay within the byte cap.` (The cap value itself is not embedded, so the footer's length depends only on the count.)

## Configuration

Keys live in `.planning/config.json` as **nested** objects, the way gsd-core stores capability config: `{ "standing-orders": { "enabled": true, "block_on": "conflict" } }`. A flat key named `"standing-orders.enabled"` is not read. The workstream config (`.planning[/<GSD_PROJECT>]/workstreams/<GSD_WORKSTREAM>/config.json`) is read first, then the root `.planning/config.json`, then the default; a config file that is not valid JSON counts as not setting the key.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `standing-orders.enabled` | boolean | `false` | The capability's `activationKey`. While it is not true, every loop hook is inactive and `select`, `conflicts`, `coverage`, `enforce` and `trace` write nothing. `impact`, `stale` and `validate` only read, and answer either way. **Only the JSON boolean `true` enables.** Any other value (the strings `"true"`, `"false"` and `"yes"`, the number `1`, `null`) leaves the capability disabled and adds warning `enabled_not_boolean`; this reader does not use gsd-core's `Boolean(value)` coercion, under which `"false"` would count as on. |
| `standing-orders.block_on` | enum | `conflict` | What blocks planning. An unknown value falls back to `conflict` with warning `config_invalid`. |
| `standing-orders.max_bytes` | number | `6000` | UTF-8 byte cap for `APPLICABLE.md`. A whole number; the **minimum is 512** (the fixed header and footer need it): a smaller whole number (0 to 511) is raised to 512 with warning `max_bytes_below_minimum`. Anything else (including the string `"6000"`) falls back to `6000` with warning `config_invalid`. |

- **block_on** — one of: `conflict` | `conflict_or_missing` | `never`

## Loop wiring

| Point | Hook | What it does |
|---|---|---|
| `plan:pre` | step `standing-orders select` | Writes `APPLICABLE.md`, `CONFLICTS.json` and the phase verdict with `coverage: pending`. |
| `plan:pre` | contribution into `planner` | Tells the planner to run `select` itself, stop on a block, read `APPLICABLE.md`, project every applicable order into a plan's `must_haves`, and never list a check file in `files_modified`. |
| `plan:pre` | gate, blocking | `conflicts == clear` in the verdict. |
| `plan:post` | step `standing-orders coverage` | Recomputes conflicts, citations, projections and check-file edits from the written plans; rewrites the verdict. |
| `plan:post` | gate, blocking | `conflicts == clear`. |
| `plan:post` | gate, blocking | `coverage == complete`. |
| `execute:wave:post` | step `standing-orders enforce` | Runs every applicable `test` order's check through gsd-core's fail-first prover; writes `ENFORCEMENT.json` and the verdict's `enforcement`. |
| `execute:wave:post` | gate, blocking | `enforcement == clear`. |
| `discuss:post` | step, skill `standing-orders-promote` | Offers each resolved `SPEC.md` prohibition and `CONTEXT.md` decision of the phase as a standing order, one question per candidate, and adds each confirmed one with `standing-orders promote --add`. Never promotes in auto mode. `onError: skip`. |
| `discuss:post` | gate, `agentVerdict` (advisory, never blocks) | The skill `standing-orders-conflict-review`: runs `select`, proposes semantic conflicts between the applicable orders and the phase `SPEC.md`, and asks the user to confirm, dismiss (with a reason) or defer each one through `standing-orders semantic`. Auto mode only proposes. `onError: skip`. |
| `ship:pre` | step `standing-orders trace` | Appends one `TRACE.jsonl` record per applicable order and commits that file alone through the host's commit tool. Sole writer of the trace (ADR-5057). `onError: skip`: a step never blocks ship. |

Every hook has `when: standing-orders.enabled`. gsd-core 1.19–1.20 does not yet run third-party `plan:pre` command steps or gates ([open-gsd/gsd-core#5982](https://github.com/open-gsd/gsd-core/issues/5982)); until it does, the planner-run `select` is the `plan:pre` check and the `plan:post` gates are the mechanical block (ADR-0001 A5). There is no `verify:pre` hook: orders reach `gsd-verifier` as projected `must_haves` (ADR-0001 A6, [open-gsd/gsd-core#5984](https://github.com/open-gsd/gsd-core/issues/5984)).

## Phase inputs

- **Phase directory and requirement ids.** `--phase-dir <dir>` (and optionally `--req-ids "A, B"`) names them directly. `--phase <N>` asks the host: the router runs gsd-core's `init plan-phase <N> --raw` (no shell, bounded by a timeout) and reads `phase_dir` and `phase_req_ids`. The directory must resolve inside the project root, also after following symlinks.
- **Files.** The backtick-quoted paths named in the phase directory's planning markdown (every `*.md` except plans, summaries and the verdict; fenced code blocks are skipped), plus every plan's `files_modified`, plus `--files a,b`. Only tokens that look like relative paths count: no whitespace, no shell metacharacters, no URL, no `..` segment, containing `/` or ending in an extension.
- **Requirements.** The phase's requirement ids plus every plan's `requirements`.
- **Plans.** `*-PLAN.md` in the phase directory. Their frontmatter is parsed like `ORDERS.yaml` (anchors and aliases refused, every scalar a string). A plan whose frontmatter cannot be read makes coverage `incomplete` (`plan_unreadable`): what cannot be read cannot be counted as covered.
- **Citation.** An order is cited when its id appears in a string anywhere under a plan's `must_haves`, as a whole token: the characters around it must not be letters, digits, `_` or `-`. `REFUND-A` is not cited by `REFUND-AB`. A citation is a mention, not a judgement: whether the plan actually honors the order is graded at verification.
- **Projection.** Every applicable order must also appear as a structured `must_haves` item in some plan, written exactly as `APPLICABLE.md`'s `Project as` line gives it:
  - a `test` order as a `prohibitions` item `{statement: "<id>: <statement>", status: resolved, verification: test, check_kind, check_target}` (plus `check_rule` for `lint-rule` and the fixtures when the order has them). It counts when the statement starts with `<id>:`, `status` is `resolved`, `verification` is `test`, `check_kind` matches, `check_target` and each fixture the order has match (paths compared as below), and for `lint-rule` `check_rule` matches;
  - a `backstop` order as a `truths` item `{statement: "<id>: <statement>", verification: backstop}`. It counts when the statement starts with `<id>:` and `verification` is `backstop`. `gsd-verifier` reports such a truth `insufficient_spec`, never passed.
- **Check files.** For **every** `test` order in `ORDERS.yaml`, applicable to this phase or not (an order that does not apply here can still be edited away): its `check_target` when `check_kind` is `node-test`, and its `check_violation_fixture` and `check_clean_fixture` for either kind. A `lint-rule` order's `check_target` is the code the rule lints, so it is not a check file. This is a documented deviation from the wording of PRD R11 (PRD-0001: "a plan never lists the order's check target"): the lint-rule target is the code under the rule, which a plan must be free to edit (ADR-0001 A6). Its `check_mutants` paths (for either kind) and `.planning/standing-orders/MUTANTS.json` (while any order has mutants) are check files too. **`.planning/standing-orders/ORDERS.yaml` is protected the same way** whenever the capability is enabled: whoever can edit it can delete the order that names a check. Paths are compared canonically: surrounding whitespace trimmed, backslashes to `/`, `.` and `..` segments resolved, repeated and trailing `/` removed, leading `./` removed, and **case ignored** (macOS and Windows file systems ignore it, so `Tests/X.test.cjs` names the same file). Otherwise they must be equal: `tests/x.test.cjs.bak` is a different file.
- **What a `files_modified` entry can cover.** An entry covers a protected file when it is:
  - the file itself, in any spelling above;
  - a **directory** that holds it: an entry ending in `/`, or one that is a directory on disk. `tests`, `tests/`, `./` and `.` cover `tests/x.test.cjs`. An entry with no trailing `/` that does not exist as a directory is a file path, never a prefix;
  - a **glob** matching it, with the same `*`, `**` and `?` as scope matching plus `{a,b}` alternatives: `tests/**`, `tests/**/`, `tests/*.cjs`, `**/*.test.cjs`, `tests/{x,y}.test.cjs`. A trailing `/` on a glob names the directory. A bracket class (`[a]`, `[!b]`, `[x-z]`) is treated as a wildcard that may over-match (safe direction), never as a literal. A glob with more than 8 brace groups or over 1024 characters is not expanded; it covers every protected file. A glob also covers a file when it matches a directory above it;
  - an **absolute** path inside the project root, which is made root-relative first. An absolute path outside the root, or a drive path such as `C:\proj\x`, names no file of this project and is ignored;
  - a **symbolic link**, or a path under a linked directory, that resolves to a protected file (compared by real path; only for entries that exist).

  An entry that covers no protected file (`src/**`, `docs/`) does not trip the rule. The reason `check_file_modified` is raised once per protected file covered and names it, and `checkFileEdits` lists the same files.
- **Unusable rules.** When `ORDERS.yaml` is invalid or unreadable, `APPLICABLE.md` says so on its own line (`ORDERS.yaml could not be used (<state>): planning is blocked until it is fixed. Run standing-orders validate.`), so the planner never reads an empty list as "no rules apply". `select` writes the verdict first, then `APPLICABLE.md`, then `CONFLICTS.json`.

## Blocking rules

`conflicts` is `blocked` when any of these holds, unless `block_on` is `never`:

| Reason code | Condition |
|---|---|
| `orders_unreadable` | `ORDERS.yaml` exists but could not be read (too large, unreadable, outside the project). |
| `orders_invalid` | `ORDERS.yaml` has errors. |
| `conflict` | A conflict involves at least one order applicable to this phase. Conflicts between orders that do not apply here are reported as `unrelatedConflicts` and do not block. |
| `missing_check` | `block_on` is `conflict_or_missing` and an applicable `test`-tier order's `check_target` was not found. |

A missing `ORDERS.yaml` is not a block: it means there are no rules yet (warning `orders_file_missing`).

`coverage` (written by `standing-orders coverage`) is `incomplete` when any of these holds, and the file has at least one order:

| Reason code | Condition |
|---|---|
| `plan_unreadable` | A plan's frontmatter could not be read. |
| `no_plans` | At least one order applies and the phase has no plans. |
| `uncited` | An applicable order is cited by no plan's `must_haves`. |
| `not_projected` | An applicable order is cited but no readable plan has its projection (see *Projection*). An uncited order is reported `uncited` only. |
| `check_file_modified` | A plan covers a check file of any `test` order, or `ORDERS.yaml`, in `files_modified` (see *Check files* for what covers). Checks are fixed before the implementing phase. |

## Verdict file: `<phase dir>/STANDING-ORDERS.md`

Machine-written; the gates read its frontmatter with gsd-core's `artifact-frontmatter-equals` predicate. Any other file in the phase directory whose name ends in `-STANDING-ORDERS.md` makes the gate ambiguous, and it blocks.

```markdown
---
schema: "1"
phase: "03-billing"
conflicts: clear
coverage: pending
enforcement: pending
generated_by: select
applicable: "REFUND-IDEMPOTENT, REFUND-AMOUNT-A"
---
```

- **conflicts** — one of: `clear` | `blocked`
- **coverage** — one of: `pending` | `complete` | `incomplete` | `error`
  - `pending`: written by `select` at the start of every planning run, so an earlier `complete` can never carry over.
  - `error`: `coverage` failed after resolving the phase; the gate blocks.
- **enforcement** — one of: `pending` | `clear` | `flagged` | `error`
  - `pending`: written by `select` and `coverage`, and by `enforce` before it runs any check, so a run that never finishes cannot leave a stale `clear`.
  - `clear`: every applicable `test` order was proven (or there are none).
  - `flagged`: at least one applicable `test` order was not proven.
  - `error`: `ORDERS.yaml` was invalid or unreadable, or `enforce` could not write its results.

The body lists one `- <reason code>: <message>` line per finding, or `- no blocking findings`.

## Enforcement

`standing-orders enforce` runs, for each applicable `test` order in applicable order, gsd-core's fail-first prover:

```
gsd-tools check prohibition-enforcement --json '{"prohibition":{"id","statement","status":"resolved","verification":"test"},"check":{"kind","target","rule"?,"violationFixture"?,"cleanFixture"?}}'
```

with the project root as working directory (no shell; the statement is cut to 500 characters). Each call is bounded at 180 s. An order is **proven** only when the host answers `status: green` and `flagged: false`. A check that passes on its violation fixture is not fail-first, and the host reports it `unverified`, `flagged` — so is it here. Every failure to get a verdict is `flagged`, never a pass:

| Reason prefix | Meaning |
|---|---|
| `host_unavailable` | No gsd-tools CLI was found (`GSD_TOOLS`, or the dispatching `gsd-tools`). |
| `host_timeout` | No verdict within 180 s. |
| `host_failed` | The host exited non-zero; the message carries the exit status and the first line of its stderr. |
| `host_output_invalid` | The host's output was not a JSON object. |
| `request_too_large` | The request would exceed 28 000 characters on the command line; it was not sent. |

Any other reason is the host's own. `.planning/standing-orders/ENFORCEMENT.json` is `{ schema: 1, phase, status, results }`; each result is `{ id, status, flagged, reason, located, kind, evidence }` as the host returned it. Each unproven order adds an `enforcement_flagged` reason to the verdict body.

`block_on` does not apply to enforcement: it decides what blocks planning only.

### Integrity of check files

`standing-orders coverage` also writes `<phase dir>/STANDING-ORDERS-INTEGRITY.json`, **before** the verdict, so no verdict stands without its record: `{ schema: 1, phase, orders: { path, sha256 }, files: { <protected path>: sha256 }, plans: { <plan file>: sha256 } }`. `sha256` is the hex SHA-256 of the file's text; `null` means the file did not exist, and a file that could not be read is recorded as `unreadable:<kind>` (never equal to a hash). `files` holds every protected file of every `test` order, applicable or not. `coverage` writes a record whenever the capability is enabled, even with no `ORDERS.yaml` and no orders (then `orders.sha256` is `null`). `standing-orders select` deletes the record, so a stale one never survives a new selection. **`coverage` never re-baselines changed check files:** when a record already exists and a protected file or `ORDERS.yaml` no longer matches it, `coverage` is `incomplete` with the reason `check_file_changed: <paths>` and leaves the old record untouched; only `select` resets the record (select, then coverage, to accept a deliberate change). A rerun with identical hashes rewrites the record, so changed plans are re-hashed. A protected file larger than 1 MiB cannot be hashed: `coverage` is `incomplete` with `check_file_too_large: <path>`, and `enforce` treats any `unreadable:*` value, recorded or current, as changed.

`standing-orders enforce` compares the record with the disk **before it runs any check**:

| Reason code | Condition | Result |
|---|---|---|
| `check_file_changed` | A recorded protected file, or `ORDERS.yaml`, changed, was deleted, or appeared where none was recorded (a missing file is recorded as `null`). | `enforcement: flagged`; every applicable `test` order's result is flagged with the changed paths; no check runs. Enforcement is flagged even when no `test` order is applicable, so a deleted `ORDERS.yaml` cannot read as clear while its record stands. An `unreadable:*` value, recorded or current, counts as changed. |
| `integrity_missing` | The record is absent, a symbolic link, unreadable, not valid JSON, not an object of the expected shape, or for another phase. | `enforcement: flagged`, no check runs. Fix: run `standing-orders coverage` (if a check file changed since an older record, `select` first). This applies to every project, including one with no `ORDERS.yaml`: without a record `enforce` is always flagged, so deleting both `ORDERS.yaml` and the record cannot read as clear. |
| `plan_changed` | A plan's hash differs from the record. | A warning only (executors may touch plans). Enforcement is not flagged for it. |

`enforce` itself writes `MUTANTS.json` (a protected file) when it learns new mutant outcomes; it records the new hash in `STANDING-ORDERS-INTEGRITY.json`, so a second wave is not flagged for its own write. Any other write to `MUTANTS.json` after `coverage` (for example `standing-orders mutants --run`) is a change: run `select`, then `coverage` again (coverage alone refuses to re-baseline it).

`ENFORCEMENT.json` gains two additive keys: each result carries `order_hash` (the `sha256:` hash of the order it proved, as in *Trace*), and `integrity: { files: { <protected path>: sha256 } }` holds the hashes `enforce` verified. `trace` uses both: a green, unflagged result counts as `proven` only if it carries an `order_hash` equal to the order's current hash **and** the report carries `integrity.files` whose hashes still match the disk. A result with another `order_hash`, a result without `order_hash`, or a report without `integrity` is `unenforced`; a protected file whose current hash differs from `integrity.files` (or is unreadable) makes the disposition `flagged`. A report written before these keys existed proves nothing.

The record is a project file: a deliberate forger who can write the check files can rewrite the record too. That is the same trust boundary as the check files themselves (ADR-0001 §6). The record closes silent, unlisted and after-the-fact edits, and the deleted-`ORDERS.yaml` hole (a missing record is itself flagged); it does not stop a determined adversary with write access.

## Trace

`.planning/standing-orders/TRACE.jsonl` is an append-only ledger: one JSON object per line, written only by `standing-orders trace` at `ship:pre` (ADR-0001 §7, A7). Each record, keys in this order:

| Key | Value |
|---|---|
| `schema` | `1` |
| `order_id` | The order's `id`. |
| `order_hash` | `sha256:<64 hex>` over canonical JSON of the normalized order: keys sorted, `contexts`, `scope.paths` and `scope.requirements` sorted and de-duplicated, null fields and empty lists omitted. Stable under key and list reordering and reformatting. |
| `contexts` | The order's effective leaf contexts, sorted (`*` when the document declares none). |
| `phase` | The phase directory relative to the project root. |
| `plans` | The phase's plans whose `must_haves` cite the order, sorted. |
| `files` | The phase's files matched by the order's `scope.paths`, sorted; `[]` when it has none. |
| `check` | `{ kind, target, rule? }` for a `test` order; `null` for `backstop`. |
| `disposition` | `proven` (this phase's `ENFORCEMENT.json` has the host's `green`, unflagged answer), `flagged` (it has any other answer), `unenforced` (no result for this phase) or `insufficient_spec` (`backstop`). |
| `commit_sha` | The last commit touching anything other than `TRACE.jsonl` (`git log -1 --format=%H -- . ':(exclude).planning/standing-orders/TRACE.jsonl'`, bounded at 10 s), or `null` with warning `commit_unresolved`. |
| `ts` | ISO-8601 time of the trace. |

- A candidate whose `(order_id, order_hash, phase, commit_sha)` is already in the file is not appended, so a ship re-run adds nothing.
- New records are appended in one write; when the file does not end in a newline, one is written first. Existing bytes are never rewritten.
- When reading, a line that is not a valid record is skipped with warning `trace_line_invalid` (its line number in the message). A valid record's `phase` matches `^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$` with no `..` segment, its `order_id` is at most 200 characters, and no line is longer than 65 536 characters. These limits keep a hand-crafted ledger from smuggling text into `APPLICABLE.md`, which the planner reads.
- `TRACE.jsonl` must be a regular file: a symbolic link there (dangling, inside the project or outside it) is refused with `trace_not_regular`, and nothing is written through it. A file over 32 MiB is refused (`trace_too_large`); an output directory resolving outside the project, also through a link, is refused (`path_outside_cwd`).
- `ENFORCEMENT.json` is read with the same guards (inside the project, not a link, at most 16 MiB); when it cannot be used, `test` orders are recorded `unenforced`.
- After appending, `trace` runs `gsd-tools commit "docs(standing-orders): trace <phase> [standing-orders trace]" --files .planning/standing-orders/TRACE.jsonl`, bounded like the other host calls. The host applies `commit_docs`; when it skips, fails, or no host CLI is found, the file stays uncommitted and `trace` warns `trace_not_committed`.
- An order is **stale** when its latest record differs from the current `ORDERS.yaml`: `changed` (different `order_hash`), `removed` (no such id) or `contexts_changed` (same hash, different effective leaf contexts). An order never traced is not stale.

Append-only is enforced by this tool, not tamper-evident: the file is tracked, and its history is git's.

## Commands: `standing-orders trace | impact | stale`

```
gsd-tools standing-orders trace  (--phase <N> | --phase-dir <dir>) [--req-ids "A, B"] [--files a,b] [--raw]
gsd-tools standing-orders impact <order-id> [--raw]
gsd-tools standing-orders stale [--raw]
```

- `standing-orders trace` selects the applicable orders exactly as `select` does and writes only `TRACE.jsonl`. With `--raw`: `{ schema: 1, subcommand: "trace", ok, disabled, phase: { dir, reqIds }, applicable, appended, skipped, commit_sha, commit: { committed, hash, reason }, warnings, written }`. No applicable order, or nothing new, writes and commits nothing. A missing `ORDERS.yaml` traces nothing (warning `orders_file_missing`); an invalid or unreadable one fails with `orders_unusable`.
- `standing-orders impact` (`<order-id>` required) reads `ORDERS.yaml` and `TRACE.jsonl`: `{ schema: 1, subcommand: "impact", ok, id, traced, status, current_hash, hash_mismatch, contexts_changed, phases, warnings }`. `phases` holds the latest record per shipped phase, sorted by phase: `{ phase, plans, files, check, disposition, commit_sha, ts, order_hash, hash_mismatch }`. `status` is `untraced`, `current`, `changed`, `removed` or `orders_unusable` (`ORDERS.yaml` could not be read, so `hash_mismatch` is `null`).
- `standing-orders stale` lists every stale order: `{ schema: 1, subcommand: "stale", ok, stale: [{ id, reason, last_phase, last_hash, current_hash }], warnings }`, sorted by id. An invalid `ORDERS.yaml` fails with `orders_unusable`.
- `impact` and `stale` write nothing and do not require `standing-orders.enabled`. A missing `ORDERS.yaml` counts as no orders, so every traced order is `removed`. `--ws <name>` is accepted and ignored; any other flag is a usage error. With `--raw`, a failure is also printed as one JSON line `{ schema: 1, subcommand, ok: false, errors: [{ code, message }], written: [] }`, because the host shows only the error text otherwise.
- `select` adds `stale` (the ids of applicable stale orders, sorted) to its result, and any ledger read problem to `warnings`.

Direct-CLI exit codes: `trace` as the loop commands below (0 ok or disabled, 1 usage, 2 could not look); `impact` 0 answered, 1 usage, 2 could not look; `stale` 0 nothing stale, 1 at least one stale order or a usage error, 2 could not look.

| Code | Severity | Meaning |
|---|---|---|
| `orders_unusable` | error | `ORDERS.yaml` is invalid or unreadable, so nothing can be traced or compared. |
| `trace_too_large` | error | `TRACE.jsonl` exceeds 32 MiB. |
| `trace_not_regular` | error | `TRACE.jsonl` is a symbolic link; it is neither read nor written. |
| `phase_name_invalid` | error | The phase directory's path does not fit the record's `phase` pattern; nothing was traced. |
| `trace_unreadable` | error / warning | `TRACE.jsonl` could not be read; an error for `impact` and `stale`, a warning for `select` (which then marks nothing stale). |
| `trace_line_invalid` | warning | A `TRACE.jsonl` line is not a valid record and was skipped. |
| `commit_unresolved` | warning | git could not name the shipped commit; records carry `commit_sha: null`. |
| `trace_not_committed` | warning | `TRACE.jsonl` was written but not committed; the message says why. |

## Commands: `standing-orders promote` and `standing-orders semantic`

```
gsd-tools standing-orders promote --candidates (--phase <N> | --phase-dir <dir>) [--raw]
gsd-tools standing-orders promote --add '<order JSON>' [--raw]
gsd-tools standing-orders semantic propose (--phase <N> | --phase-dir <dir>) --findings '<JSON list>' [--auto] [--raw]
gsd-tools standing-orders semantic resolve (--phase <N> | --phase-dir <dir>) --id <S-n> --status <resolved|dismissed|unresolved> [--reason <text>] [--auto] [--raw]
gsd-tools standing-orders semantic list    (--phase <N> | --phase-dir <dir>) [--raw]
```

These are the commands the two `discuss:post` skills call (ADR-0001 A8). Either can also be run by hand.

- `standing-orders promote --candidates` reads the phase directory's `*-SPEC.md` (not `UI-SPEC.md` or `AI-SPEC.md`) and `*-CONTEXT.md` and lists what could become an order: every `resolved` row of the SPEC `## Prohibitions` table (origin `spec-prohibition`; `verification` `test` when the row says test, otherwise `backstop`; requirement ids from the Requirement cell), and every `- **D-NN:**` line inside `<decisions>` (origin `context-decision`). Each candidate has `{ origin, source, statement, requirements, verification, already_promoted, promoted_as }`. `source` is a label such as `.planning/phases/03-billing/03-SPEC.md prohibition 2` or `.planning/phases/03-billing/03-CONTEXT.md D-04`. A candidate is `already_promoted` when an order carries that `source`, or the same statement; it is `null` when `ORDERS.yaml` is invalid (warning `orders_unusable`). At most 200 candidates (`truncated`). A phase file that is a link outside the project, over 1 MiB or unreadable is skipped (warning `phase_file_skipped`). It writes nothing and does not require `standing-orders.enabled`.
- `standing-orders promote --add` adds **exactly one** order, given as a JSON object with the keys of an order in `ORDERS.yaml`. A list, or `--add` given twice, is refused (`batch_refused`): each order is confirmed on its own. The order is inserted as text at the end of the `orders:` block, so comments and layout survive; a missing `ORDERS.yaml` is created, a missing `orders:` key is added, and `orders: []` is replaced. The whole file is then re-parsed. Nothing is written when the existing file is invalid (`orders_unusable`), the id exists (`duplicate_id`), the new order is invalid (`invalid_order`, with the parser's findings), the layout cannot take a text insertion or an existing order would change (`insert_unsupported`, with a `paste` block to add by hand), or the result exceeds 256 KiB (`file_too_large`). Requires `standing-orders.enabled`. Result: `{ schema: 1, subcommand: "promote", ok, mode: "add", added, written }`.
- `standing-orders semantic` keeps the LLM conflict pass's findings in `<phase dir>/STANDING-ORDERS-SEMANTIC.json`: `{ schema: 1, phase, findings: [{ id, orders, statement, status, reason, proposed_by, resolved_by, ts }] }`. `status` is one of `unresolved`, `resolved` (a human confirmed the conflict) or `dismissed` (a human ruled it out, with a non-empty `reason`). The file is validated on every read; an invalid one (for example a dismissed finding with a blank reason) is refused (`semantic_unusable`) and never overwritten.
  - `propose` adds findings as `unresolved` with ids `S-1`, `S-2`, ...: 1 to 50 per call (`too_many_findings`, `invalid_finding`), each naming orders that exist in `ORDERS.yaml` (`unknown_order`) and a statement of at most 1000 characters. A finding already on file (same orders, same statement) is skipped and reported in `duplicates`. `--auto` is allowed: proposing is not deciding.
  - `resolve` records a human decision; a later `resolve` may change it (the last decision stands, with its `ts`). `--auto` is a label the caller sets: the command enforces that an unattended run that says so cannot decide, and the skill sets it whenever auto mode is on; it cannot tell a human from an agent that omits it. `dismissed` needs `--reason` with text (`reason_required`). With `--auto` every decision is refused: dismissing gives `auto_never_dismisses`, and confirming or deferring gives `auto_cannot_confirm`. An unknown id gives `finding_not_found`. `unresolved` defers a finding and clears its reason.
  - `list` prints the findings and their counts; it does not require `standing-orders.enabled`.
  - Findings are advisory: a `resolved` finding never blocks planning. It is fixed by editing `ORDERS.yaml`, and the deterministic `conflicts` gate then enforces the change.
- `propose`, `resolve` and `promote --add` require `standing-orders.enabled`; disabled, they report `disabled` and write nothing. `--ws <name>` is accepted and ignored. With `--raw`, a failure is also printed as one JSON line `{ schema: 1, subcommand, ok: false, errors: [{ code, message }], written }`.

Direct-CLI exit codes: 0 done (or disabled); 1 a usage error or a refusal; 2 a file could not be read (`path_outside_cwd`, `file_not_found`, `file_unreadable`, `file_too_large`).

| Code | Severity | Meaning |
|---|---|---|
| `batch_refused` | error | `promote --add` was given more than one order. |
| `duplicate_id` | error | `promote --add`: an order with that id already exists. |
| `invalid_order` | error | `promote --add`: the order is not valid; the parser's findings are attached. |
| `insert_unsupported` | error | `promote --add`: the `orders:` layout cannot take a text insertion, or an existing order would have changed; add the returned `paste` block by hand. |
| `orders_unusable` | error / warning | `ORDERS.yaml` is invalid or unreadable: an error for `promote --add` and `semantic propose`, a warning for `promote --candidates`. |
| `phase_file_skipped` | warning | `promote --candidates` skipped a SPEC or CONTEXT file it could not read safely. |
| `reason_required` | error | A dismissal without a reason. |
| `auto_never_dismisses` | error | `semantic resolve --auto --status dismissed`: auto mode never dismisses a finding. |
| `auto_cannot_confirm` | error | `semantic resolve --auto` with any other status: findings need a human. |
| `finding_not_found` | error | No finding with that id. |
| `unknown_order` | error | A proposed finding names an order that is not in `ORDERS.yaml`. |
| `too_many_findings` | error | More than 50 findings in one `propose`. |
| `invalid_finding` | error | A proposed finding is malformed (no orders, empty or over-long statement, unknown key, or none at all). |
| `semantic_unusable` | error | `STANDING-ORDERS-SEMANTIC.json` is invalid, a link, or over 4 MiB; it is not overwritten. |

## Command: `standing-orders mutants`

```
gsd-tools standing-orders mutants --order <id> [--raw]
gsd-tools standing-orders mutants --add '<json>' [--raw]
gsd-tools standing-orders mutants --run --order <id> [--no-cache] [--raw]
```

A mutant is an extra violation fixture for a `test` order (`check_mutants`): a plausible wrong implementation the check must also reject. `standing-orders mutants` lists, adds and runs them. The skill `standing-orders-harden` drives it.

- `--order <id>` lists the order's mutants as `{ path, exists, cached_outcome }` (`cached_outcome` is `killed`, `survived` or `null`). Read-only; it works while `standing-orders.enabled` is false. Result: `{ schema: 1, subcommand: "mutants", ok, disabled, mode: "list", order, mutants, written }`.
- `--add` adds **exactly one** mutant, given as `{"order": <id>, "path": <project-relative path>}` with an optional `"content": <text>`. A list, or `--add` given twice, is refused (`batch_refused`); anything that is not that object (or a `content` that is not text) is a `usage` error. Disabled, it reports `disabled` before reading the argument. The path is first reduced to its canonical form (`\` to `/`, repeated and `.` segments collapsed, trailing `/` removed); every check below, and the path written to `ORDERS.yaml` and reported, use that form. The new `ORDERS.yaml` text is built and verified in memory first (re-parsed; every other order's hash unchanged; the target order differs only by the added path). With `content`, the mutant file must not exist: it is written (parent directories only inside the project), then `ORDERS.yaml` atomically; if that write fails the mutant file is removed. Without `content` (use this for a file already written, so a large file never travels in the command line, which is limited to 32,767 characters on Windows), the file must already exist, be a regular file inside the project (not a link) of 1 to 65536 bytes; the command only registers it in `ORDERS.yaml` and never deletes it. Nothing is written when the order is not found (`order_not_found`) or not `test` (`order_not_test`), the path is absolute or contains `..` (`path_invalid`), resolves outside the project, also through a symbolic link (`path_outside_project`), is under `.planning/` in any spelling (`path_reserved`), names a check file of the order (`mutant_is_check_file`), is already a mutant (`mutant_exists`), `content` is given and the file already exists (`mutant_exists`), `content` is omitted and the file does not exist (`mutant_missing`), or the content (or the existing file) is empty or over 65536 bytes (`content_invalid`). When the `ORDERS.yaml` layout cannot take the insertion safely (for example a flow-style `check_mutants: [a]`), nothing is written and the refusal is `manual`, with the YAML to paste (and the content to save, when given). Line endings are preserved. Result: `{ schema: 1, subcommand: "mutants", ok, disabled, mode: "add", order, path, created, written }`; `created` is `true` when the command wrote the mutant file (then `written` lists it before `ORDERS.yaml`), `false` when it registered an existing one.
- `--order`, `--run` and `--add` on an `ORDERS.yaml` that is invalid refuse with `orders_unusable`; the failure `errors` (and message) then also carry the first 10 validation errors as `{ code, path, message }`, as `validate` reports them.
- `--run --order <id>` proves the base check and then every mutant through the same call `enforce` uses, writes `MUTANTS.json` when the cache changed, and prints `{ schema: 1, subcommand: "mutants", ok, disabled, mode: "run", order, base, mutants, verdict, written }`. `verdict` is `clear` or `flagged`. Disabled, it writes nothing. `--no-cache` ignores stored outcomes (fresh answers are still stored).

Direct-CLI exit codes: 0 done (or disabled); 1 a usage error, a refusal, or `--run` with `verdict: flagged`; 2 a file could not be read.

### Mutant enforcement

`standing-orders enforce` (and `mutants --run`) runs a `test` order's mutants only when its base result is `green` and not `flagged`, in sorted path order, one at a time. Each call is the base request with only `check.violationFixture` replaced by the mutant path. A result with mutants gains `mutants: [{ path, outcome, cached, reason }]`; an order without mutants has no such key and its result is unchanged.

| Outcome | Meaning |
|---|---|
| `killed` | The host answered `green`, not flagged: the check fails the mutant, as it should. |
| `survived` | The host located and ran the check (it answered `located: true`) and the answer is not green and unflagged: the check passes the mutant. The order is flagged `mutant_survived: <paths>`. |
| `error` | Anything else: the host did not locate the check, answered without saying so, or the call failed; or the mutant file is missing (`mutant_missing`), unreadable, a link, or outside the project (`mutant_unreadable`). The order is flagged `mutant_unverified: <paths>`. An `error` is never cached. |

The rule is fail-closed: `killed` needs `status: green` and `flagged: false`; `survived` needs `located: true`; everything else is `error`, whatever the wording of its reason.

When both occur the reason is `mutant_survived: ...; mutant_unverified: ...`; the status stays the host's base status.

`.planning/standing-orders/MUTANTS.json` is the outcome cache, `{ schema: 1, entries: { <key>: { outcome, ts } } }`, written only when a mutant was run and only holding `killed` and `survived`. The key is a SHA-256 over the check kind, the rule, the contents of the check target, the clean fixture and the mutant, and the **code**: the HEAD tree id (`git rev-parse HEAD^{tree}`), so a changed file or a changed commit is a cache miss. The tree id is resolved once per `enforce` or `mutants --run`, and only when some order has mutants (an order set with no mutants makes no git call). If git is unavailable, times out (10 s), prints something that is not a tree id, or the working tree has any change outside `.planning/` (`git status --porcelain -- . ":(exclude).planning"` prints anything), the cache is neither read nor written for that run: every mutant runs, outcomes are still reported, and nothing blocks. `mutants --order` lists a cached outcome only when it is valid for the current tree. When the target or clean fixture cannot be read (a link, outside the project, not a regular file, or over 1 MiB) the mutant still runs but is not cached. The mutant files (65536 bytes) and the cache (4 MiB) are read with the same containment: no links, regular files, real path inside the project. At most 2000 entries are kept (newest `ts`). A cache that is missing, a link, outside the project, over 4 MiB, not JSON or malformed is treated as empty, never as `killed`. A project with no mutants gets no `MUTANTS.json`. The cache does not see helpers the check imports. `enforce --no-cache` ignores stored outcomes.

### Mutants in coverage

Every `check_mutants` path of an applicable `test` order is a check file (a `lint-rule` order's included, unlike its `check_target`), and so is `.planning/standing-orders/MUTANTS.json` while such an order has mutants: a plan that lists either in `files_modified` is rejected like any other check-file edit.

| Code | Severity | Meaning |
|---|---|---|
| `order_not_found` | error | `mutants`: no order with that id. |
| `order_not_test` | error | `mutants`: the order is not a `test` order. |
| `path_outside_project` | error | `mutants --add`: the path resolves outside the project. |
| `path_reserved` | error | `mutants --add`: the path is under `.planning/`. |
| `mutant_exists` | error | `mutants --add`: the path is already a mutant, or `content` was given and the file already exists. |
| `mutant_missing` | error | `mutants --add`: no `content` was given and the file does not exist. |
| `content_invalid` | error | `mutants --add`: the content is empty or over 65536 bytes. |
| `manual` | error | `mutants --add`: `ORDERS.yaml` cannot take the insertion safely; add the returned lines by hand. |
| `mutant_survived` | flag reason | A mutant passed the check. |
| `mutant_unverified` | flag reason | A mutant could not be proven. |
| `mutant_missing` | flag reason | A mutant file does not exist. |
| `mutant_unreadable` | flag reason | A mutant file is a link, outside the project, not a regular file, too large, or unreadable. |

`path_invalid`, `mutant_is_check_file`, `batch_refused`, `usage`, `write_failed` and `orders_unusable` are as above and in the code tables.

## Commands: `standing-orders select | conflicts | coverage | enforce`

```
gsd-tools standing-orders select    (--phase <N> | --phase-dir <dir>) [--req-ids "A, B"] [--files a,b] [--raw]
gsd-tools standing-orders conflicts (--phase <N> | --phase-dir <dir>) [--req-ids "A, B"] [--files a,b] [--raw]
gsd-tools standing-orders coverage  (--phase <N> | --phase-dir <dir>) [--req-ids "A, B"] [--files a,b] [--raw]
gsd-tools standing-orders enforce   (--phase <N> | --phase-dir <dir>) [--req-ids "A, B"] [--files a,b] [--raw]
```

- `standing-orders select` writes `.planning/standing-orders/APPLICABLE.md`, `.planning/standing-orders/CONFLICTS.json` and the verdict (`coverage: pending`).
- `standing-orders conflicts` computes the same blocking decision and writes nothing.
- `standing-orders coverage` writes the integrity record (see *Integrity of check files*) and then the verdict, with `conflicts` recomputed and `coverage` decided.
- `standing-orders enforce` writes the verdict (`enforcement: pending` first, then the result, with `conflicts` and `coverage` recomputed) and `.planning/standing-orders/ENFORCEMENT.json`.
- `--ws <name>` is accepted and ignored (the host has already applied it through `GSD_WORKSTREAM`). Any other flag, a positional argument, a flag without its value, or giving both or neither of `--phase` and `--phase-dir` is a usage error.
- Writes are atomic (temporary file, then rename).
- With `--raw`, one JSON line: `{ schema: 1, subcommand, ok, disabled, phase: { dir, reqIds }, conflicts, coverage, enforcement, reasons, applicable, omitted, uncited, notProjected, checkFileEdits, unrelatedConflicts, errors, warnings, written }`, plus `results` for `enforce`. `enforcement` is `null` for `conflicts` and `pending` for `select` and `coverage`. `ok` false means the command could not look (codes below), not that it blocked. Disabled: `{ schema: 1, subcommand, ok: true, disabled: true, message, written: [] }`.
- `CONFLICTS.json` is `{ schema: 1, phase, status, reasons, conflicts, missingChecks, errors, warnings }`; each conflict and missing check carries `applicable: true|false`.

Direct-CLI exit codes for these four: 0 clear (or disabled); 1 blocked, coverage `incomplete` or `error`, enforcement `flagged` or `error`, or a usage error; 2 could not look (phase unresolved, path outside the project, write failed).

| Code | Severity | Meaning |
|---|---|---|
| `usage` | error | Bad or missing flags. |
| `phase_dir_not_found` | error | The phase directory does not exist. |
| `host_unavailable` | error | `--phase` was given but no gsd-tools CLI was found (`GSD_TOOLS`, or the dispatching `gsd-tools`); pass `--phase-dir`. |
| `phase_unresolved` | error | The host could not resolve the phase (not found, failed, timed out, or unparseable output). |
| `write_failed` | error | An output file could not be written. |
| `internal_error` | error | An unexpected failure inside the router; nothing is assumed to be written. |
| `orders_file_missing` | warning | No `ORDERS.yaml`; treated as no rules. |
| `config_invalid` | warning | A config value was rejected and its default used. |
| `enabled_not_boolean` | warning | `standing-orders.enabled` is set but is not a boolean; the capability stays disabled. |
| `max_bytes_below_minimum` | warning | `standing-orders.max_bytes` is below 512; 512 is used. |
| `plan_changed` | warning | A plan changed since `coverage` recorded it (`enforce`). |
| `check_file_changed` | verdict reason | A recorded check file or `ORDERS.yaml` changed since `coverage` (`enforce`). |
| `integrity_missing` | verdict reason | `enforce` found no usable integrity record for the phase. |
| `phase_dir_unreadable` | warning | The phase directory could not be listed; no files or plans were read. |
| `doc_unreadable` | warning | A planning document could not be read and was skipped. |
| `doc_too_large` | warning | A planning document over 1 MiB was skipped. |

## Command: `standing-orders validate`

```
node standing-orders-router.cjs validate [file] [--raw]     # direct CLI
gsd-tools standing-orders validate [file] [--raw]           # through the installed capability
```

- `file` defaults to `.planning/standing-orders/ORDERS.yaml` and must resolve inside the current project root, both as written and after following symlinks. `--raw` is the only flag; any other `-`/`--` token is a usage error.
- Without `--raw`: one summary line followed by one line per error, conflict and warning.
- With `--raw`: a single-line JSON report.

### Report (`schema: 1`)

```json
{
  "schema": 1,
  "ok": true,
  "file": ".planning/standing-orders/ORDERS.yaml",
  "errors":   [ { "code": "...", "path": "$.orders[1].id", "message": "..." } ],
  "warnings": [ { "code": "...", "path": "...", "message": "..." } ],
  "conflicts": [ { "kind": "variant-outcome", "orders": ["A", "B"], "operation": "refund.amount", "contexts": ["contract-a"], "message": "..." } ],
  "missingChecks": [ { "id": "A", "check_target": "tests/x.test.cjs" } ],
  "summary": { "orders": 3, "contexts": 3, "byKind": { "prohibition": 1, "invariant": 0, "variant": 2 }, "byVerification": { "test": 2, "backstop": 1 } }
}
```

`ok` is true only when there are no errors **and** no conflicts. Warnings never make a file invalid.

### Exit codes (direct CLI)

| Code | Meaning |
|---|---|
| 0 | Valid: no errors, no conflicts. |
| 1 | Invalid (errors or conflicts), or a usage error (unknown subcommand or flag). |
| 2 | The file could not be read: `path_outside_cwd` (including through a symlink), `file_not_found`, `file_unreadable`, `file_too_large`. |

### Error and warning codes

| Code | Severity | Meaning |
|---|---|---|
| `input_not_string` | error | The content handed to the parser was not a string. |
| `yaml_anchor_refused` | error | An anchor, alias or merge key was present; nothing was parsed. |
| `yaml_null_byte` | error | A NUL byte was present. |
| `yaml_syntax` | error | Not valid YAML; the message carries the parser's reason. |
| `root_not_mapping` | error | The document is empty or its root is not a mapping. |
| `version_unsupported` | error | `version` is missing or not `1`. |
| `unknown_key` | error | A key not in this reference, at the path given. |
| `unknown_key_for_kind` | error | `outcome` on a non-variant. |
| `contexts_not_mapping` | error | `contexts` is not a mapping. |
| `context_name_invalid` | error | A context name fails `^[a-z][a-z0-9-]*$`. |
| `undefined_context` | error | A context name that is not declared. |
| `context_cycle` | error | `includes`/`extends` form a cycle; the error lists `members`. |
| `context_too_deep` | error | The membership chain is too deep to resolve (thousands of nested contexts). |
| `orders_not_list` | error | `orders` is not a list. |
| `missing_field` | error | A required key is absent for this kind/verification. |
| `duplicate_id` | error | An `id` already used by an earlier order. |
| `enum_invalid` | error | A value outside its closed vocabulary. |
| `type_invalid` | error | A value of the wrong shape (list where a string is expected, and so on). |
| `fixture_missing` | warning | A test-tier order lacks a violation or clean fixture. |
| `check_ignored_for_backstop` | warning | A `check_*` key on a backstop order. |
| `check_target_missing` | warning | A test-tier `check_target` was not found under the project root. |
| `no_mutants` | warning | A test-tier order has no `check_mutants`: its check is proven by one violation fixture only. |
| `path_invalid` | error | A `check_mutants` entry is absolute, has a drive prefix, or contains a `..` segment. |
| `path_reserved` | error | A `check_mutants` entry is under `.planning/` (any spelling, any case). |
| `duplicate_mutant` | error | A `check_mutants` entry repeats an earlier one (after canonicalisation, case ignored). |
| `mutant_is_check_file` | error | A `check_mutants` entry is the order's own `check_target`, violation fixture or clean fixture. |
| `path_outside_cwd` | error | The requested file resolves outside the project root. |
| `file_not_found` | error | The requested file does not exist. |
| `file_unreadable` | error | The file exists but could not be read. |
| `file_too_large` | error | The file exceeds 256 KiB. |
