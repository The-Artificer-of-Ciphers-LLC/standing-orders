# How to find what a rule change affects

Every time you ship a phase, Standing Orders records which rules that phase was held to, in `.planning/standing-orders/TRACE.jsonl`. When you later edit or remove a rule in `ORDERS.yaml`, two commands read that record: `impact` lists every phase that shipped against one rule and whether the rule has changed since, and `stale` lists every rule that has changed since it was last shipped against.

**Before you start:** Standing Orders installed and enabled as in [How to gate GSD planning on your standing orders](gate-planning-on-standing-orders.md). The record only exists for phases shipped with `/gsd:ship` after you upgraded.

## 1. Ship as usual

Nothing to run by hand. When `/gsd:ship` runs, Standing Orders appends one line to `TRACE.jsonl` for each rule that applies to the phase, then commits that file on its own (`docs(standing-orders): trace <phase> [standing-orders trace]`), so the record travels with the pull request.

If your project sets `commit_docs` to `false`, or `.planning/` is git-ignored, GSD will not make that commit. Ship prints `trace_not_committed`, the record stays on disk, and the next ship will ask you to commit it first. Commit it yourself:

```bash
git add .planning/standing-orders/TRACE.jsonl
git commit -m "docs(standing-orders): trace phase 3"
```

Shipping the same phase again at the same code commit adds nothing; a line is only added for a rule (or a rule version) that phase has not recorded yet.

## 2. Ask what a rule touched

```bash
gsd-tools standing-orders impact REFUND-IDEMPOTENT
```

```
standing-orders impact: REFUND-IDEMPOTENT — changed; 2 phase(s) traced
  .planning/phases/03-billing: proven, order changed since; commit 1a2b3c4; plans 03-01-PLAN.md; files src/billing/refund.js
  .planning/phases/07-refunds: flagged, order changed since; commit 9f8e7d6; plans 07-02-PLAN.md; files src/billing/ledger.js, src/billing/refund.js
```

The first line gives the rule's status: `current`, `changed` (its text is no longer the text those phases were held to), `removed`, or `untraced`. Each following line is one shipped phase: how the rule's check came out (`proven`, `flagged`, `unenforced` when no check ran for that phase, or `insufficient_spec` for a `backstop` rule), whether the rule changed since, the commit the phase shipped at, the plans that cited the rule and the phase files it matched. Add `--raw` for JSON, which also carries the old and current hashes.

## 3. List every rule that changed

```bash
gsd-tools standing-orders stale
```

```
standing-orders stale: 1 stale order(s)
  REFUND-IDEMPOTENT: changed since last traced in .planning/phases/07-refunds
```

It prints one line per changed rule, with its reason, and exits `1` when there is at least one, so you can use it in CI:

| Reason | Meaning | What to do |
|---|---|---|
| `changed` | The rule's content differs from the version last shipped against. | Run `impact` on it and decide whether the listed phases still meet the new rule. If not, plan a phase to bring them in line. |
| `removed` | The rule is no longer in `ORDERS.yaml`. | Nothing is checking those phases for it any more; confirm that was intended. |
| `contexts_changed` | The rule's own text is unchanged, but a context it names now covers different leaf contexts. | Same as `changed`: the rule now applies in different places. |

Reordering keys or list entries, reformatting, or adding comments does not count as a change.

The next time a phase plans, `APPLICABLE.md` marks each applicable stale rule with a `- Stale:` line, so the planner sees it too.

## If nothing comes back

| What you see | Meaning |
|---|---|
| `impact` says `not traced` | No shipped phase has recorded this rule yet, or the id is misspelled. Check `gsd-tools standing-orders validate`. |
| `stale` lists nothing, but you edited a rule | No phase has shipped against that rule yet; there is nothing to be stale against. |
| `orders_unusable` from `impact` or `stale` | `ORDERS.yaml` does not parse, so nothing can be compared. Run `gsd-tools standing-orders validate` and fix it. (A missing `ORDERS.yaml` is not an error: every traced rule is reported `removed`.) |
| `trace_too_large` or `trace_not_regular` | `TRACE.jsonl` is over 32 MiB, or it is a symbolic link. Standing Orders refuses to read or write it; replace it with the real file. |
| `orders_unusable` from `trace` | `ORDERS.yaml` does not parse, so ship recorded nothing for this phase. Fix it, then run `gsd-tools standing-orders trace --phase <N>` yourself. |
| a `trace_line_invalid` warning | A line in `TRACE.jsonl` is not a valid record (for example after a bad merge). It is skipped, never rewritten; fix or delete that line by hand. |

`TRACE.jsonl` is append-only by convention, not tamper-proof: it is a tracked file, and its history is git's.
