# How to resolve a wave blocked by Standing Orders

After every execution wave, Standing Orders runs the check of each `test` rule that applies to the phase through GSD's own fail-first prover. If a rule is not proven, the wave stops with:

```
⚠ Wave N blocked by capability gate (standing-orders): …
```

This page tells you how to find out which rule, why, and what to do.

**Before you start:** Standing Orders 0.3.0 or newer, installed and enabled as in [How to gate GSD planning on your standing orders](gate-planning-on-standing-orders.md).

## 1. See which rules were not proven

Open the phase's `STANDING-ORDERS.md`. Its frontmatter says `enforcement: flagged` (or `error`), and the body has one line per unproven rule:

```
- enforcement_flagged: REFUND-IDEMPOTENT: test-tier prohibition has no passing wired enforcement check — flagged unverified (fail-closed; never a silent pass, ADR-550 D5d)
```

For the full host answer per rule (`status`, `located`, `kind`, `evidence`), read `.planning/standing-orders/ENFORCEMENT.json`.

To re-run the check by hand, without waiting for the next wave:

```bash
gsd-tools standing-orders enforce --phase 3
```

## 2. Match the reason to a fix

A rule is proven only when its check fails on the rule's violation fixture, passes on its clean fixture, and passes on the real code. Anything less is reported, never passed.

| What the reason says | Meaning | What to do |
|---|---|---|
| `test-tier prohibition has no passing wired enforcement check` with `located: true` | The check ran but was not proven: it failed on the real code (the code breaks the rule), or it passed on the violation fixture (the check cannot tell good from bad), or it failed on the clean fixture. | Run the check yourself, as below. If the code breaks the rule, fix the code. If the check passes on the violation fixture, the check or the fixture is wrong: fix it in its own phase. |
| the same reason with `located: false` | The rule's check is not well formed (no `check_target`, or a `lint-rule` with no `check_rule`). | Fix the rule in `ORDERS.yaml`; `gsd-tools standing-orders validate` lists what is missing. |
| `host_unavailable` | Standing Orders could not find `gsd-tools` to call. | Run through GSD (`gsd-tools standing-orders enforce …`), or set `GSD_TOOLS` to the path of `gsd-tools.cjs`. |
| `host_timeout` | No verdict within 180 s. | Make the check faster, or split it. A check that hangs is never counted as passing. |
| `host_failed` | `gsd-tools` exited with an error; the message carries its first stderr line. | Fix what that line names (often an old gsd-core: Standing Orders needs 1.19.0 or newer). |
| `host_output_invalid` | `gsd-tools` answered with something that is not a verdict. | Run the `check prohibition-enforcement` command below and read its output. |
| `check_file_changed: <paths>` | A check file, fixture, mutant or `ORDERS.yaml` changed after planning (`coverage` recorded its hash in `STANDING-ORDERS-INTEGRITY.json`). No check was run, so an edited check is never trusted. | If the change was unintended, restore the file (`git checkout -- <path>`). If it was intended, it belongs in its own change outside the executing phase: revert it here, make it separately, then re-plan so `coverage` records the new hashes. |
| `integrity_missing` | The phase has no usable integrity record (planned before Standing Orders 0.7.0, or the file is missing or damaged). | Re-run `gsd-tools standing-orders coverage --phase N`, then the wave. |
| `request_too_large` | The rule's fields are too long to pass on a command line. | Shorten the rule's paths or rule id. |

`enforcement: error` means `ORDERS.yaml` is invalid or unreadable, or the results could not be written. Run `gsd-tools standing-orders validate`.

## 3. Run one rule's check yourself

For a `node-test` rule, the prover runs the test with the subject file in `GSD_PROHIB_SUBJECT`. Run it the same way, from the project root, once per subject:

```bash
GSD_PROHIB_SUBJECT=tests/fixtures/billing/double-refund.js node --test tests/billing/refund-idempotent.test.cjs   # must FAIL
GSD_PROHIB_SUBJECT=tests/fixtures/billing/single-refund.js node --test tests/billing/refund-idempotent.test.cjs   # must PASS
node --test tests/billing/refund-idempotent.test.cjs                                                          # must PASS on the real code
```

Or ask the prover directly, with the rule's own fields:

```bash
gsd-tools check prohibition-enforcement --json '{"prohibition":{"id":"REFUND-IDEMPOTENT","verification":"test"},"check":{"kind":"node-test","target":"tests/billing/refund-idempotent.test.cjs","violationFixture":"tests/fixtures/billing/double-refund.js","cleanFixture":"tests/fixtures/billing/single-refund.js"}}'
```

`"status": "green"` with `"flagged": false` is proven; anything else is what Standing Orders reported.

## 4. Continue the phase

Once the cause is fixed, re-run `gsd-tools standing-orders enforce --phase <N>` until the verdict says `enforcement: clear`, then resume execution (`/gsd:execute-phase <N>`).

## Nothing to report versus could not look

- **No `test` rules apply to the phase** (only `backstop` rules, or none): `enforcement: clear` with nothing run.
- **No `ORDERS.yaml`:** no rules yet, `enforcement: clear`.
- **Disabled:** nothing runs and nothing is written.
- **`enforcement: pending` at the gate** means `enforce` started but did not finish (it writes `pending` before it runs any check). The gate blocks; re-run `enforce` by hand to see why.

## Known limits

- GSD's verifier does not yet receive Standing Orders' enforcement results ([open-gsd/gsd-core#5984](https://github.com/open-gsd/gsd-core/issues/5984)). It reports each projected `test` rule as flagged, so a phase with `test` rules finishes verification as `human_needed` even when every wave was `clear`. The `clear` verdicts in `STANDING-ORDERS.md` are the evidence to give the reviewer.
- Every applicable `test` rule's check runs after every wave. Many slow checks make waves slow.
- Only `files_modified` is fenced at planning. An executor that edits a check file anyway is caught here only if the edit breaks the fail-first proof.
