# Standing Orders — project-wide business rules for the GSD loop

A [GSD](https://github.com/open-gsd/gsd-core) **third-party capability** (ADR-1244) that keeps a project's business rules in one YAML file, scoped by the contexts they apply in. During the GSD loop it gives the planner only the rules that apply to the work at hand, blocks planning when rules conflict, enforces rules with checks the executing agent did not write, and records which rules each shipped phase was held to.

The name comes from the military term: a standing order stays in force across every mission until someone revokes it. A GSD phase is a mission; a standing order outlives it.

**Status: phase 1 of 6.** This release ships the core library and the `validate` command. The loop wiring (manifest, `plan:pre` selection, gates), enforcement, tracing and promotion follow in later phases; see the [epic](https://github.com/The-Artificer-of-Ciphers-LLC/standing-orders/issues/1).

## Documentation

| Need | Where |
| --- | --- |
| Validate a rules file right now | [How to validate ORDERS.yaml](docs/how-to/validate-standing-orders.md) |
| Exact schema, matching rules, conflict kinds, report shape, error codes | [`references/standing-orders.md`](references/standing-orders.md) |
| Why it is shaped this way | [ADR-0001](docs/adr/0001-standing-orders-architecture.md) |
| What it must do, and the evidence behind it | [PRD-0001](docs/prd/0001-standing-orders.md) |

## Install (phase 2)

Installation through `gsd capability install` arrives with the manifest in phase 2. Until then, clone the repository and run the validator directly (see the how-to). There are no runtime dependencies to install: the YAML parser is vendored under `lib/vendor/`.

## Development

```bash
npm install          # dev dependencies only (fast-check, js-yaml for the vendor check)
npm test             # node --test + fast-check, ~130 tests
npm run vendor:check # vendored js-yaml is byte-identical to the pinned devDependency
```

Requires Node 20 or newer. Tests are authored with `node:test`; property tests use a fixed seed so a failure reproduces.

## License

MIT. The vendored js-yaml bundle is MIT (notice in `lib/vendor/js-yaml.LICENSE.txt`).
