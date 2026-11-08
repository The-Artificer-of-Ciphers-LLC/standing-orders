# How to promote a phase's rules to standing orders

A phase discussion often settles a rule that should hold everywhere: a prohibition the spec resolved, or a decision recorded in `CONTEXT.md`. Promoting it makes it a standing order in `.planning/standing-orders/ORDERS.yaml`, so every later phase it applies to is planned, enforced and traced against it.

**Before you start:** Standing Orders installed and enabled as in [How to gate GSD planning on your standing orders](gate-planning-on-standing-orders.md).

## 1. Discuss the phase as usual

Run `/gsd:discuss-phase <N>`. When it has written `CONTEXT.md`, the `discuss:post` step runs the `gsd-standing-orders-promote` skill. You can also run it yourself at any time, for example after `/gsd:spec-phase`:

```
/gsd-standing-orders-promote 3
```

The skill lists the candidates with:

```bash
gsd-tools standing-orders promote --candidates --phase 3
```

A candidate is a `resolved` row of the phase SPEC's `## Prohibitions` table, or a `- **D-NN:**` decision in `CONTEXT.md`. Rows that are dismissed or unresolved are never offered, and neither is anything already promoted.

## 2. Answer one question per candidate

For each candidate the skill shows a drafted order (id, kind, statement, `source`, scope, `verification: backstop`) and asks **Promote** or **Skip**. One answer covers one order. Edit the draft in your answer if the id, kind or scope is wrong. Give a check (`check_kind`, `check_target` and the violation and clean fixtures) if you want a `test` order; otherwise it stays `backstop` until you add one.

Each **Promote** adds that single order:

```bash
gsd-tools standing-orders promote --add '{"id":"NO-RAW-CARD-NUMBERS","kind":"prohibition","statement":"Card numbers are never written to logs.","verification":"backstop","source":".planning/phases/03-billing/03-SPEC.md prohibition 1"}'
```

The order is added at the end of the `orders:` list. Your comments and layout are kept.

## 3. Check the result

```bash
gsd-tools standing-orders validate
```

The next `/gsd:plan-phase` for any phase in the order's scope now carries the order. Running the skill again marks promoted candidates `already_promoted` instead of offering them twice.

## When nothing happens, or an order is refused

| You see | Why | What to do |
|---|---|---|
| No candidates | The phase has no resolved prohibitions or `D-NN` decisions, or the SPEC/CONTEXT files are named differently (`*-SPEC.md`, `*-CONTEXT.md`). | Nothing to promote; add an order by hand if you meant to. |
| "none were promoted in auto mode" | The phase ran with `--auto` or in an auto-chain. Promotion needs your answer per order. | Run `/gsd-standing-orders-promote <N>` yourself. |
| `orders_unusable` | `ORDERS.yaml` is invalid, so nothing is added to it. | Fix the errors `standing-orders validate` lists, then promote again. |
| `duplicate_id` | An order with that id exists. | Choose another id. |
| `invalid_order` | The drafted order breaks the schema (for example an undefined context, or a `test` order without `check_target`). The parser's findings are attached. | Correct the draft; define a context in `ORDERS.yaml` before naming it. |
| `insert_unsupported` | `orders:` is written as a non-empty inline list (`orders: [...]`), or the insertion would have changed another order. | Paste the returned `paste` block under `orders:` yourself. |
| `batch_refused` | More than one order in one `--add`. | Add them one call at a time. |
| `phase_file_skipped` (warning) | A SPEC or CONTEXT file is a link outside the project, over 1 MiB, or unreadable. | Fix that file; the others were still read. |
| `disabled` | `standing-orders.enabled` is not true. | Enable it as in the install how-to. |
