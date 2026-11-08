# How to gate GSD planning on your standing orders

Install Standing Orders into a GSD project, turn it on, and get every phase's plans checked against the rules in `ORDERS.yaml`: the planner sees only the rules that apply to the phase, conflicting rules stop planning, and a phase whose plans do not cite every applicable rule cannot reach execution.

**Before you start:** GSD (gsd-core) 1.19.0 or newer, Node 20 or newer, and a project with a `.planning/` directory. To write the rules themselves, see [How to validate ORDERS.yaml](validate-standing-orders.md) and the [schema reference](../../references/standing-orders.md#orders).

## 1. Install the capability

From a git tag (recommended):

```bash
gsd capability install https://github.com/The-Artificer-of-Ciphers-LLC/standing-orders.git#v0.3.0
```

or from a local directory:

```bash
gsd capability install ./path/to/standing-orders --scope project
```

GSD copies the whole directory, so use a fresh clone. A development checkout where you ran `npm install` is refused, because `node_modules/.bin` holds symlinks and GSD never stages a symlink.

GSD shows what the capability ships and asks for consent before it installs anything. Standing Orders ships one executable surface, the `standing-orders` command module. Accept it, or pass `--yes` to consent up front. Then check it is listed without errors:

```bash
gsd capability list
```

## 2. Turn it on

Installing changes nothing until you enable it:

```bash
gsd config-set standing-orders.enabled true
```

or put it in `.planning/config.json` yourself, nested the way GSD stores capability settings:

```json
{ "standing-orders": { "enabled": true } }
```

Optionally choose what blocks planning (default `conflict`):

```bash
gsd config-set standing-orders.block_on conflict_or_missing
```

`conflict_or_missing` also blocks when an applicable `test`-tier rule's check file does not exist yet. `never` reports everything and blocks nothing.

## 3. Add your rules

Write `.planning/standing-orders/ORDERS.yaml` and validate it:

```bash
gsd-tools standing-orders validate
```

Give each rule a `scope` (`paths` globs and/or `requirements` ids) so it reaches only the phases that touch that code. A rule with no scope applies to every phase.

## 4. Plan a phase as usual

```bash
/gsd:plan-phase 3
```

Before writing plans, the planner runs `standing-orders select` for the phase. That writes:

- `.planning/standing-orders/APPLICABLE.md` — the rules that apply to this phase, which the planner reads;
- `.planning/standing-orders/CONFLICTS.json` — the full conflict report;
- `STANDING-ORDERS.md` in the phase directory — the verdict the gates read.

The planner copies each applicable rule into a plan's `must_haves`, using the `Project as` line `APPLICABLE.md` prints for it:

```yaml
must_haves:
  prohibitions:
    - statement: "REFUND-IDEMPOTENT: A refund for one payment is never executed more than once."
      status: resolved
      verification: test
      check_kind: node-test
      check_target: tests/billing/refund-idempotent.test.cjs
      check_violation_fixture: tests/fixtures/billing/double-refund.js
      check_clean_fixture: tests/fixtures/billing/single-refund.js
  truths:
    - statement: "INVOICE-ROUNDING: Invoice totals round half to even."
      verification: backstop
```

A `test` rule becomes a `prohibitions` item and a `backstop` rule a `truths` item; this is how the rules reach GSD's verifier, which reports a `backstop` rule as `insufficient_spec` rather than passed. The planner also keeps every check file (the rule's test, and its violation and clean fixtures) out of `files_modified`: checks are written before the phase that implements the rule.

After planning, `standing-orders coverage` re-checks the written plans, and the phase cannot proceed unless the verdict says `conflicts: clear` and `coverage: complete`. During execution, after every wave, `standing-orders enforce` proves each `test` rule's check; see [How to resolve a wave blocked by Standing Orders](resolve-standing-orders-enforcement.md).

You can run the same check yourself at any time, without writing anything:

```bash
gsd-tools standing-orders conflicts --phase 3
```

## 5. If planning stops

Open the phase's `STANDING-ORDERS.md`; each finding is one line with a reason code.

| Reason code | What to do |
|---|---|
| `conflict` | Two applicable rules contradict each other. Fix one of them in `ORDERS.yaml` (narrow its `contexts`, or correct an `outcome`), then re-run `/gsd:plan-phase`. |
| `orders_invalid` | `ORDERS.yaml` has errors. Run `gsd-tools standing-orders validate` and fix what it lists. |
| `orders_unreadable` | `ORDERS.yaml` could not be read (over 256 KiB, a link that leaves the project, or a permissions problem). |
| `missing_check` | Only with `block_on: conflict_or_missing`. Write the check file the rule names, or set the rule to `verification: backstop` until it exists. |
| `uncited` | A plan must cite that rule's id in its `must_haves`. Re-run planning, or add the rule's `Project as` item to the plan that implements it. |
| `not_projected` | The rule is mentioned but not as the structured item `APPLICABLE.md` gives. Copy its `Project as` item into the plan's `must_haves` exactly: same section, a statement starting with `<id>:`, the same `verification`, and for a `test` rule `status: resolved` and the same check fields and fixtures. |
| `check_file_modified` | A plan lists one of a rule's check files in `files_modified`. Remove it from the plan. If the check itself is wrong, fix it in its own phase first, before the phase that implements the rule. |
| `no_plans` | Rules apply but the phase has no plans yet. |
| `plan_unreadable` | A plan's frontmatter could not be parsed (for example it uses YAML anchors). Fix that plan. |

`coverage: error` means the coverage check itself failed partway; re-run `/gsd:plan-phase`.

## Nothing to report versus could not look

- **No `ORDERS.yaml`** is not an error: there are simply no rules yet, and every check passes (`orders_file_missing` warning).
- **Disabled** (`standing-orders.enabled` absent or false): the commands print that they are disabled and write nothing, and no gate runs. Your GSD output is exactly what it would be without the capability.
- **Could not look:** if a command cannot resolve the phase (`phase_unresolved`, `host_unavailable`, `phase_dir_not_found`) or cannot write its files (`write_failed`), it fails instead of reporting a verdict. The plan:post gate then finds no current verdict and blocks. Run the command by hand with `--phase-dir .planning/phases/<dir>` to see the error.

## Known limit

gsd-core 1.19 and 1.20 do not yet run a capability's own `plan:pre` step and gate ([open-gsd/gsd-core#5982](https://github.com/open-gsd/gsd-core/issues/5982)). Until they do, the `plan:pre` check is the planner running `select` as its contribution instructs; the guaranteed stop is the `plan:post` gate, before any code is executed.
