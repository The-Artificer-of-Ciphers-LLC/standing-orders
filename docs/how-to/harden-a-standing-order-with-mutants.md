# How to harden a standing order's check with mutants

A `test` rule is proven when its check fails on one violation fixture and passes on the clean fixture. One violation is a thin sample: the check may catch only the mistake its author pictured. Mutants are more known-bad versions of the clean fixture, each breaking the rule in a different way. If the check passes on a mutant, the mutant **survives**, and Standing Orders reports the rule `flagged` until you fix it.

Mutants are optional. A `test` rule without any is enforced exactly as before; `validate` only warns `no_mutants`.

**Before you start:** Standing Orders 0.6.0 or newer, installed and enabled as in [How to gate GSD planning on your standing orders](gate-planning-on-standing-orders.md), and a `test` rule with a check and both fixtures.

## 1. See the rule's mutants

```bash
gsd-tools standing-orders mutants --order REFUND-IDEMPOTENT
```

This lists each mutant path, whether the file exists, and its last outcome (`killed`, `survived`, or none yet). It works even when Standing Orders is disabled.

## 2. Add mutants

The easy way is to let the agent propose them. Ask it to run the `gsd-standing-orders-harden` skill with the rule id. It reads the rule, its check and its clean fixture, proposes up to three mutants, and asks you about each one, showing the diff and the input on which the mutant behaves differently. Confirm only mutants that really break the rule: a mutant that behaves the same as the clean fixture (an *equivalent* mutant) can never be caught and will flag the rule for nothing. The promotion skill offers this after you promote a `test` rule. In auto mode the skill proposes but adds nothing.

To add one yourself, save the mutant file, then register it:

```bash
gsd-tools standing-orders mutants --add '{"order":"REFUND-IDEMPOTENT","path":"tests/fixtures/billing/mutants/refund-retry-after-timeout.js"}'
```

The command checks the file (inside the project, a regular file, not a link, 1 to 65536 bytes) and adds its path to the rule's `check_mutants` in `ORDERS.yaml`, keeping your comments and layout. It adds one mutant per call. It refuses a path outside the project, under `.planning/`, or equal to one of the rule's check files, and a file that does not exist (`mutant_missing`). If it cannot place the line safely (for example, `check_mutants` written as `[a, b]` on one line), it writes nothing and prints the YAML to paste by hand.

For a short mutant you can instead pass its text as `"content"`, and the command writes the file for you (it must not exist yet). Keep long content out of the command line: Windows limits a command to 32,767 characters.

You can also list paths under `check_mutants` in `ORDERS.yaml` directly.

## 3. Run them

```bash
gsd-tools standing-orders mutants --run --order REFUND-IDEMPOTENT
```

It runs the rule's check through GSD's prover, first on the normal fixtures, then once per mutant, and prints each outcome. It exits 1 when the rule is not proven or any mutant survived. The same runs happen automatically after every execution wave (`enforce`).

Run it while you author the rule, not in the middle of a planned phase. `MUTANTS.json` is a protected file, so a manual run after the phase is planned changes it. The next wave then stops with `check_file_changed` until you re-run `gsd-tools standing-orders coverage --phase N`.

## 4. Fix a survivor

| Outcome | Meaning | What to do |
|---|---|---|
| `killed` | The check failed on the mutant and passed on the clean fixture. | Nothing. |
| `survived` | The check ran, and passed on the mutant (or failed on the clean fixture). | Decide which is true. **The check is too weak:** strengthen it in its own change, outside an executing phase, since a phase may not edit check files. **The mutant is equivalent:** remove its path from `check_mutants`. |
| `error` (`mutant_missing`, `mutant_unreadable`, `host_unavailable`, `host_timeout`, `host_failed`) | No answer was obtained, so the rule is flagged rather than passed. | Restore the file, or fix what the reason names, as in [How to resolve a wave blocked by Standing Orders](resolve-standing-orders-enforcement.md). |

A wave blocked by a survivor shows the reason in the phase's `STANDING-ORDERS.md`:

```
- enforcement_flagged: REFUND-IDEMPOTENT: mutant_survived: tests/fixtures/billing/mutants/refund-retry-after-timeout.js
```

## Results are cached

Outcomes are stored in `.planning/standing-orders/MUTANTS.json`, keyed by the contents of the check, the clean fixture and the mutant, and by the current commit. So a mutant runs again after any commit, and the cache only saves repeat runs within one commit (a re-run wave, or `mutants --run` twice). With uncommitted changes outside `.planning/`, or no usable `git`, the cache is skipped and every mutant runs. A plan may not list this file, or any mutant, in `files_modified`. If you doubt the cache, run with `--no-cache`:

```bash
gsd-tools standing-orders mutants --run --order REFUND-IDEMPOTENT --no-cache
gsd-tools standing-orders enforce --phase 3 --no-cache
```

Adding or removing a mutant changes the rule's hash, so `standing-orders stale` lists the rule until the next shipped phase records it. That is expected: the check is now stricter.

Why it works this way: [ADR-0002](../adr/0002-mutation-hardening.md).
