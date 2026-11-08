# Standing Orders — schema and protocol reference

This is the reference for `ORDERS.yaml` and the `standing-orders` command family. It states exact semantics; the explanation of *why* the capability is shaped this way lives in [ADR-0001](../docs/adr/0001-standing-orders-architecture.md) and the requirements in [PRD-0001](../docs/prd/0001-standing-orders.md).

The enum tables below are checked by a test against the constants the parser enforces (`tests/reference-parity.test.cjs`), so this page cannot drift from the code.

## File location

`.planning/standing-orders/ORDERS.yaml`, relative to the project root. Human-owned and reviewed in git. The capability never writes it.

## Parsing posture (untrusted input)

- Parsed with js-yaml 4.3.2 (vendored) under `FAILSAFE_SCHEMA`: **every scalar is a string**. `outcome: 1` is the string `"1"`; `statement: true` is the string `"true"`.
- **Anchors, aliases and merge keys are refused** before any expansion. A file containing `&name`, `*name` or `<<:` is rejected with `yaml_anchor_refused` and none of its content is parsed.
- A bare merge key with no alias (`<<: {…}`) has nothing to merge under `FAILSAFE_SCHEMA`; it is read as a plain key named `<<` and rejected as `unknown_key`.
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
| `source` | optional | Where the rule comes from (contract clause, decision id). |

Any `check_*` key on a `backstop` order is kept but never run (warning `check_ignored_for_backstop`).

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

A `test`-tier order whose `check_target` does not exist under the project root is reported under `missingChecks` with warning `check_target_missing`. It is not a conflict; whether it blocks planning is the `standing-orders.block_on` setting.

## APPLICABLE.md rendering

`standing-orders select` writes the applicable orders for a phase using this renderer:

- A header stating that the orders apply **in addition to** the phase's own `must_haves`, never instead of them.
- Orders in deterministic order: `test` tier before `backstop`, then by `id`.
- Whole orders are packed while the total, including the footer, stays within `standing-orders.max_bytes` (default 6000) measured in UTF-8 bytes. An order is never truncated mid-body.
- Each order block ends with a `- Project as:` line: the exact `must_haves` item the planner copies into a plan (see *Projection*).
- Every rendered scalar is one line; control characters are replaced with U+FFFD.
- A footer always states `N applicable order(s) omitted to stay within the byte cap.` (The cap value itself is not embedded, so the footer's length depends only on the count.)

## Configuration

Keys live in `.planning/config.json` as **nested** objects, the way gsd-core stores capability config: `{ "standing-orders": { "enabled": true, "block_on": "conflict" } }`. A flat key named `"standing-orders.enabled"` is not read. The workstream config (`.planning[/<GSD_PROJECT>]/workstreams/<GSD_WORKSTREAM>/config.json`) is read first, then the root `.planning/config.json`, then the default; a config file that is not valid JSON counts as not setting the key.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `standing-orders.enabled` | boolean | `false` | The capability's `activationKey`. While it is not true, every loop hook is inactive and `select`, `conflicts`, `coverage` and `enforce` write nothing. Read with gsd-core's coercion (`Boolean(value)`), so the string `"false"` counts as on. |
| `standing-orders.block_on` | enum | `conflict` | What blocks planning. An unknown value falls back to `conflict` with warning `config_invalid`. |
| `standing-orders.max_bytes` | number | `6000` | UTF-8 byte cap for `APPLICABLE.md`. Must be a whole number ≥ 0; anything else (including the string `"6000"`) falls back to `6000` with warning `config_invalid`. |

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
- **Check files.** For an applicable `test` order: its `check_target` when `check_kind` is `node-test`, and its `check_violation_fixture` and `check_clean_fixture` for either kind. A `lint-rule` order's `check_target` is the code the rule lints, so it is not a check file. Paths are compared canonically: surrounding whitespace trimmed, backslashes to `/`, `.` and `..` segments resolved, repeated and trailing `/` removed, leading `./` removed, and **case ignored** (macOS and Windows file systems ignore it, so `Tests/X.test.cjs` names the same file). Otherwise they must be equal: `tests/x.test.cjs.bak` is a different file.
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
| `check_file_modified` | A plan lists a check file of an applicable `test` order in `files_modified`. Checks are fixed before the implementing phase. |

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

## Commands: `standing-orders select | conflicts | coverage | enforce`

```
gsd-tools standing-orders select    (--phase <N> | --phase-dir <dir>) [--req-ids "A, B"] [--files a,b] [--raw]
gsd-tools standing-orders conflicts (--phase <N> | --phase-dir <dir>) [--req-ids "A, B"] [--files a,b] [--raw]
gsd-tools standing-orders coverage  (--phase <N> | --phase-dir <dir>) [--req-ids "A, B"] [--files a,b] [--raw]
gsd-tools standing-orders enforce   (--phase <N> | --phase-dir <dir>) [--req-ids "A, B"] [--files a,b] [--raw]
```

- `standing-orders select` writes `.planning/standing-orders/APPLICABLE.md`, `.planning/standing-orders/CONFLICTS.json` and the verdict (`coverage: pending`).
- `standing-orders conflicts` computes the same blocking decision and writes nothing.
- `standing-orders coverage` writes only the verdict, with `conflicts` recomputed and `coverage` decided.
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
| `path_outside_cwd` | error | The requested file resolves outside the project root. |
| `file_not_found` | error | The requested file does not exist. |
| `file_unreadable` | error | The file exists but could not be read. |
| `file_too_large` | error | The file exceeds 256 KiB. |
