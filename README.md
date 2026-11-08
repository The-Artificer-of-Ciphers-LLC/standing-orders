# Standing Orders — project-wide business rules for the GSD loop

A [GSD](https://github.com/open-gsd/gsd-core) **third-party capability** (ADR-1244) that keeps a project's business rules in one YAML file, scoped by the contexts they apply in. During the GSD loop it gives the planner only the rules that apply to the work at hand, blocks planning when rules conflict, enforces rules with checks the executing agent did not write, and records which rules each shipped phase was held to.

The name comes from the military term: a standing order stays in force across every mission until someone revokes it. A GSD phase is a mission; a standing order outlives it.

Current release: [v0.7.0](https://github.com/The-Artificer-of-Ciphers-LLC/standing-orders/releases/tag/v0.7.0).

## What it does

- **Planning:** `select` hands the planner the rules that apply; `conflicts` and `coverage` block a plan that contradicts a rule or does not cite every applicable one; `validate` checks the rules file itself.
- **Enforcement:** after every execution wave, `enforce` proves each applicable `test` rule through GSD's fail-first prover and blocks the wave when one is not proven. `mutants` hardens a check against more than one bad input.
- **Integrity:** the check files and gate inputs a plan was approved with are fenced, so a change to them forces a re-plan.
- **Tracing:** at ship, `trace` records and commits which rules the phase was held to. `impact <id>` lists every phase that shipped against a rule and whether it has changed since; `stale` lists every changed rule.
- **Promotion and review:** `promote` turns a phase's settled rules into standing orders, and `semantic` records contradictions in meaning between the orders and a spec.

## Install

Requires gsd-core 1.19.0 or newer (and below 2.0.0) and Node 22 or newer.

```bash
gsd capability install https://github.com/The-Artificer-of-Ciphers-LLC/standing-orders.git
gsd config-set standing-orders.enabled true
```

The URL has no `#ref` because released gsd-core 1.19 and 1.20 cannot install one ([open-gsd/gsd-core#5297](https://github.com/open-gsd/gsd-core/issues/5297)). The [v0.7.0 release](https://github.com/The-Artificer-of-Ciphers-LLC/standing-orders/releases/tag/v0.7.0) is the tagged source of this version. The capability is off until enabled. There are no runtime dependencies: the YAML parser is vendored under `lib/vendor/`.

## Quick start

1. Write your rules in `.planning/standing-orders/ORDERS.yaml` (start from the [schema example](references/standing-orders.md#orders)).
2. Check the file from your project root:

   ```bash
   node /path/to/standing-orders/standing-orders-router.cjs validate
   ```

3. Plan a phase as usual. Planning stops if rules conflict or the plan does not cite every applicable rule; the [gating how-to](docs/how-to/gate-planning-on-standing-orders.md) shows what each stop means and how to clear it.

## Documentation

Organized by what you need (Diátaxis). The full index is [docs/README.md](docs/README.md).

**How-to guides**

- [Gate GSD planning on your standing orders](docs/how-to/gate-planning-on-standing-orders.md)
- [Validate ORDERS.yaml](docs/how-to/validate-standing-orders.md)
- [Resolve a wave blocked by Standing Orders](docs/how-to/resolve-standing-orders-enforcement.md)
- [Find what a rule change affects](docs/how-to/find-what-a-rule-change-affects.md)
- [Promote a phase's rules to standing orders](docs/how-to/promote-phase-rules-to-standing-orders.md)
- [Review semantic conflicts between orders and a spec](docs/how-to/review-semantic-conflicts.md)
- [Harden a standing order with mutants](docs/how-to/harden-a-standing-order-with-mutants.md)

**Reference**

- [`references/standing-orders.md`](references/standing-orders.md): schema, matching rules, conflict kinds, report shape, every command and its error codes.

**Explanation**

- [ADR-0001: Standing Orders architecture](docs/adr/0001-standing-orders-architecture.md)
- [ADR-0002: Mutation hardening of standing-order checks](docs/adr/0002-mutation-hardening.md)
- [PRD-0001: Standing Orders](docs/prd/0001-standing-orders.md), what it must do and the evidence behind it

## Development

```bash
npm install          # dev dependencies only (fast-check, js-yaml for the vendor check)
npm test             # node --test + fast-check
npm run vendor:check # vendored js-yaml is byte-identical to the pinned devDependency
```

Requires Node 22 or newer (Node 20 reached end of life on 2026-04-30). Tests are authored with `node:test`; property tests use a fixed seed so a failure reproduces.

## License

MIT. The vendored js-yaml bundle is MIT (notice in `lib/vendor/js-yaml.LICENSE.txt`).
