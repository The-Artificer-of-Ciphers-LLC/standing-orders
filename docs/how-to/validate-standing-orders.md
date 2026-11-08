# How to validate ORDERS.yaml

Check a project's standing orders for schema errors, undefined or cyclic contexts, and conflicting rules before planning depends on them.

**Before you start:** Node 20 or newer, and a clone of this repository (phase 1 has no installer yet). The rules file lives at `.planning/standing-orders/ORDERS.yaml` in *your* project.

## 1. Write a rules file

Start from the example in [`references/standing-orders.md`](../../references/standing-orders.md#orders) and save it as `.planning/standing-orders/ORDERS.yaml` in your project. Every string must be non-empty, and `version: 1` is required.

## 2. Run the validator from your project root

```bash
node /path/to/standing-orders/standing-orders-router.cjs validate
```

Pass a different file as the first argument if yours is elsewhere; it must be inside your project:

```bash
node /path/to/standing-orders/standing-orders-router.cjs validate rules/ORDERS.yaml
```

## 3. Read the result

A clean file prints one line and exits 0:

```
standing-orders validate: .planning/standing-orders/ORDERS.yaml — OK: 3 order(s), 3 context(s), 0 conflict(s), 2 warning(s)
  warning fixture_missing at $.orders[1].check_violation_fixture: ...
```

Warnings do not fail validation. Errors and conflicts do (exit 1), one line each with a code and a JSONPath-style location:

```
standing-orders validate: .planning/standing-orders/ORDERS.yaml — INVALID: 2 order(s), 3 context(s), 1 conflict(s), 0 warning(s)
  conflict variant-outcome: variants REFUND-AMOUNT-A and REFUND-AMOUNT-B on refund.amount both apply in contract-a but require different outcomes ("full" vs "prorated")
```

Exit 2 means the file could not be read at all (missing, unreadable, over 256 KiB, or outside the project root). Nothing to report and could not look are therefore distinguishable by exit code.

## 4. Get machine-readable output

```bash
node /path/to/standing-orders/standing-orders-router.cjs validate --raw
```

prints a single-line JSON report (`schema: 1`) with `ok`, `errors`, `warnings`, `conflicts`, `missingChecks` and a `summary`. The full shape and every code are in the [reference](../../references/standing-orders.md#report-schema-1).

## If a rule you expected to conflict does not

- Both orders must name the **same `operation`**. Orders without an `operation` never conflict.
- Their contexts must **overlap after resolution**. Check the `contexts:` section: a context with members is exactly the union of its members, so `contract-a` with a child `premium` resolves to `premium`, not to itself.
- Two variants with the **same outcome** agree; only differing outcomes conflict.
- A prohibition and an invariant never conflict with each other.

## If a `test`-tier order is reported `check_target_missing`

The check file does not exist under your project root yet. The order is still valid; write the check (before the implementing phase, per ADR-0001 §6) or change the order to `verification: backstop` until it exists.
