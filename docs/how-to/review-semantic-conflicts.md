# How to review semantic conflicts between orders and a spec

The `conflicts` gate blocks planning on conflicts it can compute, such as two variants of one operation with different outcomes in overlapping contexts. It cannot see a contradiction in meaning: an order that forbids storing card numbers, and a spec that requires an export containing them. An optional LLM pass looks for those and asks you about each one. Its verdict is advisory: it never blocks planning.

**Before you start:** Standing Orders 0.5.0 or newer, installed and enabled as in [How to gate GSD planning on your standing orders](gate-planning-on-standing-orders.md). The pass is most useful after `/gsd:spec-phase`, because it reads the phase `SPEC.md`.

## 1. Let discuss-phase run it, or run it yourself

After `/gsd:discuss-phase <N>` writes `CONTEXT.md`, the `discuss:post` advisory gate runs the `gsd-standing-orders-conflict-review` skill. To run it on its own:

```
/gsd-standing-orders-conflict-review 3
```

It runs `standing-orders select` to find the orders that apply to the phase, reads them with the phase `SPEC.md` and `CONTEXT.md`, drops anything the deterministic check already reports, and records what is left:

```bash
gsd-tools standing-orders semantic propose --phase 3 --findings '[{"orders":["NO-RAW-CARD-NUMBERS"],"statement":"SPEC R4 exports full card numbers, which the order forbids storing."}]'
```

## 2. Decide each finding

For each finding the skill asks **Confirm**, **Dismiss** or **Defer**:

- **Confirm** marks it `resolved`: it is a real conflict. Fix it in `ORDERS.yaml` (change the order, or narrow its contexts or scope) or in the spec. The finding itself never blocks; once the rule is encoded, the deterministic gate enforces it.
- **Dismiss** marks it `dismissed`, and needs a reason, which is kept as the audit trail:

  ```bash
  gsd-tools standing-orders semantic resolve --phase 3 --id S-1 --status dismissed --reason "R4 exports a masked number; the order allows that."
  ```

- **Defer** leaves it `unresolved`, and it comes back on the next run.

## 3. See where things stand

```bash
gsd-tools standing-orders semantic list --phase 3
```

The findings live in `STANDING-ORDERS-SEMANTIC.json` in the phase directory, next to `STANDING-ORDERS.md`.

## When nothing happens, or a decision is refused

| You see | Why | What to do |
|---|---|---|
| `advisory: nothing to review` | No order applies to the phase, or `select` failed (its message is shown). | Nothing to review; fix `ORDERS.yaml` if `select` failed. |
| `advisory: 0 confirmed, 0 dismissed, 0 unresolved` | The pass found no contradiction beyond what the deterministic check reports. | Nothing to do. The pass can miss conflicts; it is a second look, not a proof. |
| `advisory: N findings unresolved, need a human` | The phase ran with `--auto` or in an auto-chain. Auto mode proposes findings but never decides them. | Run the skill yourself, or `semantic list` and `semantic resolve`. |
| `reason_required` | A dismissal without a reason. | Give the reason; a dismissal is a recorded judgment. |
| `auto_never_dismisses` / `auto_cannot_confirm` | A decision was attempted with `--auto`. | Decide it without `--auto`. |
| `unknown_order` | A proposed finding names an order id that is not in `ORDERS.yaml`. | Re-run the skill after `ORDERS.yaml` is current. |
| `semantic_unusable` | `STANDING-ORDERS-SEMANTIC.json` was edited into an invalid state (for example a dismissal with a blank reason). It is never overwritten. | Fix or delete the file, then run the skill again. |
| `finding_not_found` | No finding has that id. | Check the ids with `semantic list`. |
