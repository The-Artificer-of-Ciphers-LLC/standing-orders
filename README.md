# Standing Orders — project-wide business rules for the GSD loop

A [GSD](https://github.com/open-gsd/gsd-core) **third-party capability** (ADR-1244) that keeps a project's business rules in one YAML file, scoped by the contexts they apply in. During the GSD loop it gives the planner only the rules that apply to the work at hand, blocks planning when rules conflict, enforces rules with checks the executing agent did not write, and records which rules each shipped phase was held to.

The name comes from the military term: a standing order stays in force across every mission until someone revokes it. A GSD phase is a mission; a standing order outlives it.

**Status: phase 4 of 6.** This release ships the core library, the capability manifest, the planning loop (`select`, `conflicts`, `coverage`, `validate`, a planner contribution that projects rules into the plan's `must_haves`, and blocking conflict and coverage gates, including a fence around each rule's check files), enforcement (after every execution wave, `enforce` proves each applicable `test` rule through GSD's fail-first prover and blocks the wave when one is not proven) and tracing: at ship, `trace` records and commits which rules the phase was held to, `impact <id>` lists every phase that shipped against a rule and whether it has changed since, and `stale` lists every changed rule. Promotion follows in a later phase; see the [epic](https://github.com/The-Artificer-of-Ciphers-LLC/standing-orders/issues/1).

## Documentation

| Need | Where |
| --- | --- |
| Install it and gate planning on your rules | [How to gate GSD planning on your standing orders](docs/how-to/gate-planning-on-standing-orders.md) |
| Validate a rules file right now | [How to validate ORDERS.yaml](docs/how-to/validate-standing-orders.md) |
| Unblock a wave that Standing Orders stopped | [How to resolve a wave blocked by Standing Orders](docs/how-to/resolve-standing-orders-enforcement.md) |
| See which shipped phases a rule change affects | [How to find what a rule change affects](docs/how-to/find-what-a-rule-change-affects.md) |
| Exact schema, matching rules, conflict kinds, report shape, error codes | [`references/standing-orders.md`](references/standing-orders.md) |
| Why it is shaped this way | [ADR-0001](docs/adr/0001-standing-orders-architecture.md) |
| What it must do, and the evidence behind it | [PRD-0001](docs/prd/0001-standing-orders.md) |

## Install

```bash
gsd capability install https://github.com/The-Artificer-of-Ciphers-LLC/standing-orders.git#v0.4.0
gsd config-set standing-orders.enabled true
```

Requires gsd-core 1.19.0 or newer (and below 2.0.0). It is off until enabled. There are no runtime dependencies: the YAML parser is vendored under `lib/vendor/`. Full steps, including what to do when planning stops, are in the [how-to](docs/how-to/gate-planning-on-standing-orders.md).

## Development

```bash
npm install          # dev dependencies only (fast-check, js-yaml for the vendor check)
npm test             # node --test + fast-check, ~130 tests
npm run vendor:check # vendored js-yaml is byte-identical to the pinned devDependency
```

Requires Node 20 or newer. Tests are authored with `node:test`; property tests use a fixed seed so a failure reproduces.

## License

MIT. The vendored js-yaml bundle is MIT (notice in `lib/vendor/js-yaml.LICENSE.txt`).
