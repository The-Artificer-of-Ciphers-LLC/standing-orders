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

`standing-orders validate` reports, and (from phase 2) the `plan:pre` gate blocks on:

| Kind | Condition |
|---|---|
| `variant-outcome` | Two variants name the same `operation`, their effective contexts intersect, and their `outcome`s differ. Agreeing outcomes are not a conflict. |
| `prohibition-vs-variant` | A prohibition and a variant name the same `operation` and their effective contexts intersect. |
| `duplicate-id` | One `id` is used by more than one order. |

A prohibition and an invariant on one operation never conflict (both hold). Orders without an `operation` never conflict.

A `test`-tier order whose `check_target` does not exist under the project root is reported under `missingChecks` with warning `check_target_missing`. It is not a conflict; whether it blocks planning is the `standing-orders.block_on` setting (phase 2).

## APPLICABLE.md rendering

The `select` step (phase 2) writes the applicable orders for a phase using this renderer:

- A header stating that the orders apply **in addition to** the phase's own `must_haves`, never instead of them.
- Orders in deterministic order: `test` tier before `backstop`, then by `id`.
- Whole orders are packed while the total, including the footer, stays within `standing-orders.max_bytes` (default 6000) measured in UTF-8 bytes. An order is never truncated mid-body.
- Every rendered scalar is one line; control characters are replaced with U+FFFD.
- A footer always states `N applicable order(s) omitted to stay within the byte cap.` (The cap value itself is not embedded, so the footer's length depends only on the count.)

## Command: `standing-orders validate`

```
node standing-orders-router.cjs validate [file] [--raw]     # phase 1: direct CLI
gsd-tools standing-orders validate [file] [--raw]           # phase 2: through the manifest
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
