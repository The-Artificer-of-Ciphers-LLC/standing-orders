# Standing Orders documentation

Organized by what you need (Diátaxis). New here? Start with the [README](../README.md) for what Standing Orders is, how to install it, and a quick start.

## How-to guides

Goal-oriented steps for a task you already have.

- [How to gate GSD planning on your standing orders](how-to/gate-planning-on-standing-orders.md)
- [How to validate ORDERS.yaml](how-to/validate-standing-orders.md)
- [How to resolve a wave blocked by Standing Orders](how-to/resolve-standing-orders-enforcement.md)
- [How to find what a rule change affects](how-to/find-what-a-rule-change-affects.md)
- [How to promote a phase's rules to standing orders](how-to/promote-phase-rules-to-standing-orders.md)
- [How to review semantic conflicts between orders and a spec](how-to/review-semantic-conflicts.md)
- [How to harden a standing order's check with mutants](how-to/harden-a-standing-order-with-mutants.md)

## Reference

Exact facts to look up.

- [`references/standing-orders.md`](../references/standing-orders.md): schema, matching rules, conflict kinds, configuration, loop wiring, blocking rules, the verdict file, enforcement, the trace ledger, promotion and semantic findings, every command and its codes

## Explanation

Why it is shaped this way, and what it must do.

- [ADR-0001: Standing Orders architecture](adr/0001-standing-orders-architecture.md)
- [ADR-0002: Mutation hardening of standing-order checks](adr/0002-mutation-hardening.md)
- [PRD-0001: Standing Orders](prd/0001-standing-orders.md) and its [source research](prd/research/2026-11-07-crespo-article-review.md)
- [Research: which `#ref` forms gsd-core's install accepts](research/2026-11-07-gsd-core-git-install-refs.md)
