# ADR-0001: Standing Orders architecture — a third-party GSD capability over existing seams

- **Status:** Proposed
- **Date:** 2026-11-07
- **Amended:** 2026-11-07 (phase 1, [#2](https://github.com/The-Artificer-of-Ciphers-LLC/standing-orders/issues/2)) — open questions 1–3 answered from gsd-core source and by the maintainer; rollout table corrected after the phase-coverage check; §3 semantics made exact; see *Amendments*. Amended again 2026-11-07 (phase 2, [#3](https://github.com/The-Artificer-of-Ciphers-LLC/standing-orders/issues/3)) — A5, the `plan:pre` host dispatch gap. Amended again 2026-11-08 (phase 3, [#4](https://github.com/The-Artificer-of-Ciphers-LLC/standing-orders/issues/4)) — A6, verification by projection instead of a `verify:pre` contribution, and the `engines.gsd` pin. Amended again 2026-11-08 (phase 4, [#5](https://github.com/The-Artificer-of-Ciphers-LLC/standing-orders/issues/5)) — A7, the trace step commits its own ledger. Amended again 2026-11-08 (phase 5, [#6](https://github.com/The-Artificer-of-Ciphers-LLC/standing-orders/issues/6)) — A8, the LLM conflict pass moves to `discuss:post`, and promotion writes through a command.amp; Amended again 2026-11-08 (phase 7, [#15](https://github.com/The-Artificer-of-Ciphers-LLC/standing-orders/issues/15)) — A9, integrity of check files and gate inputs. Tracking epic: [#1](https://github.com/The-Artificer-of-Ciphers-LLC/standing-orders/issues/1).
- **Requirements:** [PRD-0001](../prd/0001-standing-orders.md)
- **Host contracts relied on (gsd-core):** ADR-857 (Capability system, Loop Extension Points), ADR-894 (declaration format), ADR-1244 (third-party capabilities: versioned manifest, runtime overlay, consent), ADR-550 (spec-phase probe contract), ADR-5057 (one owner per workflow verdict)
- **Sibling pattern:** [`projects-sync-capability`](https://github.com/The-Artificer-of-Ciphers-LLC/projects-sync-capability) `capability.json`

## Context

PRD-0001 asks for project-wide, context-scoped business rules that bind every GSD phase, block planning on conflicts, are enforced by independent checks, and leave a trace. Section 3 of the PRD records the evidence.

gsd-core already has the mechanisms at phase scope: `SPEC.md` prohibitions, the edge and prohibition probes (recall then precision, dismissals need a reason), wired check descriptors (`check_kind`, `check_target`, violation and clean fixtures), a fail-first prover behind `gsd-tools check prohibition-enforcement`, exogenous verifier grading with `insufficient_spec` abstention, and decision-coverage gates. The gaps are scope and lifetime, not mechanism.

Standing Orders is a **third-party** capability. That fixes several constraints, all verified against gsd-core on 2026-11-07:

| Constraint | Source |
| --- | --- |
| Ids starting `gsd-`, `gsd-core-`, `anthropic-` are reserved; first-party ids win any collision. | ADR-1244 D2, D5 rule 6 |
| May ship skills, agents, hooks, MCP servers, and command modules; every executable surface is disclosed and consented at install; install never runs capability code. | ADR-1244 D5 |
| Command modules are `require()`d only from the capability's install root. A module name must match `/^[A-Za-z0-9._-]+\.cjs$/`. | ADR-1244 D5 rule 5; `capability-validator.cjs:459-466` |
| Contribution and step fragments are **static**: `{ path }` or `{ inline }`, path relative with no `..`. A `path` fragment is read into `inline` at install, bounded in size and confined to the capability directory. There is no query-rendered fragment. | `capability-validator.cjs:2828-2857, 2872-2898`; `loop-resolver.cts:250-256` |
| A gate `check` has exactly one of `query`, `predicate`, `agentVerdict`. `agentVerdict` gates cannot block. | `capability-validator.cjs:3050-3071` |
| Config keys are namespaced by capability id and gated by an `activationKey`. | `projects-sync-capability/capability.json` |
| Hooks declare `produces` / `consumes`; order is their topological sort, and data flows through files that survive `/clear`. | ADR-857 D6 |

## Decision

Ship Standing Orders as a declarative capability plus one command family, `standing-orders`, whose module reuses gsd-core's public verbs instead of copying their logic.

### 1. Repository layout

```
capability.json                       # manifest (ADR-894 + ADR-1244 fields)
standing-orders-router.cjs            # command family router (the only executable entry)
lib/
  orders.cjs                          # parse, validate, resolve contexts (pure)
  select.cjs                          # applicable-rule selection (pure)
  conflicts.cjs                       # deterministic conflict + missing-check detection (pure)
  trace.cjs                           # TRACE.jsonl append/read, impact, stale
fragments/
  plan-pre-planner.md                 # static contribution: tells the planner to read APPLICABLE.md
  verify-pre-verifier.md              # static contribution: tells the verifier to grade against it
references/
  standing-orders.md                  # schema + protocol, read lazily by agents
skills/                               # (phase 5) promotion skill
tests/
docs/adr, docs/prd
```

### 2. Project files written by the capability

```
.planning/standing-orders/
  ORDERS.yaml       # the rules (human-owned)
  APPLICABLE.md     # per-phase rendering of applicable rules (machine-written at plan:pre)
  CONFLICTS.json    # last conflict report (machine-written at plan:pre)
  TRACE.jsonl       # append-only rule→phase→check→result ledger (machine-written at ship:pre)
```

### 3. Rule schema (`ORDERS.yaml`)

The check fields are **the same names** gsd-core's `projectProhibitions` emits, so a standing order projects into a phase `must_haves.prohibitions` item unchanged.

```yaml
version: 1
contexts:
  contract-a: { description: "Standard subscription contract" }
  contract-b: { description: "Annual prepaid contract" }
  any-contract: { includes: [contract-a, contract-b] }

orders:
  - id: REFUND-IDEMPOTENT
    kind: prohibition              # prohibition | invariant | variant
    statement: "A refund for one payment is never executed more than once."
    operation: refund.execute
    contexts: [any-contract]
    scope:
      paths: ["src/billing/**"]
      requirements: [BILL-04]
    verification: test             # test | backstop
    check_kind: node-test          # node-test | lint-rule
    check_target: tests/billing/refund-idempotent.test.cjs
    check_violation_fixture: tests/fixtures/billing/double-refund.js
    check_clean_fixture: tests/fixtures/billing/single-refund.js
    source: "Contract terms §4.2; phase 3 CONTEXT.md D-12"

  - id: REFUND-AMOUNT-A
    kind: variant
    operation: refund.amount
    contexts: [contract-a]
    outcome: full
    statement: "Refund equals the full paid amount."
    verification: test
    check_kind: node-test
    check_target: tests/billing/refund-amount.test.cjs

  - id: REFUND-AMOUNT-B
    kind: variant
    operation: refund.amount
    contexts: [contract-b]
    outcome: prorated
    statement: "Refund is prorated by unused days."
    verification: backstop
```

Semantics:

- A `variant` must carry `outcome`. Two variants for one `operation` whose resolved contexts overlap and whose outcomes differ are a **conflict**. This is the source article's "contextual divergence" made checkable.
- `prohibition` and `invariant` hold across all their contexts.
- `backstop` means "known rule, no mechanical check yet". It is legal, and it never passes verification.
- Contexts resolve through `includes` / `extends` to a closed set. A cycle or an undefined name is a validation error.
- Parsing refuses YAML anchors, aliases and merge keys and keeps every scalar a string, matching gsd-core's `parseMustHavesBlock` posture.

### 4. Loop integration

Because fragments are static, dynamic content moves through files: a **step** computes and writes a file, and a static **contribution** tells the agent to read it.

| Point | Hook | Behaviour |
| --- | --- | --- |
| `discuss:post` | `step` (skill) | Offer to promote resolved phase prohibitions and project-wide CONTEXT.md decisions into `ORDERS.yaml`, one confirmation each. Writes through `standing-orders promote --add`, one order per call (A8). |
| `discuss:post` | `gate` `agentVerdict` (non-blocking) | The LLM semantic-conflict pass (§5), at this point rather than `plan:pre` (A8). |
| `plan:pre` | `step` → `standing-orders select <phase-dir>` | Writes `APPLICABLE.md` (applicable orders only, byte-capped, omitted count stated) and `CONFLICTS.json`. `produces` both. |
| `plan:pre` | `contribution` into `planner` | Static fragment: read `APPLICABLE.md`; cite each order id in `must_haves`; never list a check target in `files_modified`. `consumes` `APPLICABLE.md`. |
| `plan:pre` | `gate` `query: standing-orders conflicts` | Blocks on validation errors, deterministic conflicts, undefined contexts, and (per `block_on`) unlocatable `test`-tier checks. |
| `plan:post` | `gate` `query: standing-orders coverage` | Every applicable order cited by a plan; no plan modifies a check target. |
| `execute:wave:post` | `gate` `query: standing-orders enforce` | For each applicable `test`-tier order, calls `gsd-tools check prohibition-enforcement --json` with the order projected as a prohibition. Reuses gsd-core's fail-first prover; no prover is copied into this repo. |
| `verify:pre` | `contribution` into `verifier` | Static fragment: grade applicable orders from `APPLICABLE.md` as exogenous predicates; a `backstop` order is `insufficient_spec`. **Superseded by A6:** not declared; orders reach the verifier as projected `must_haves`. |
| `ship:pre` | `step` → `standing-orders trace <phase-dir>` | Appends one `TRACE.jsonl` record per applicable order. Sole writer of the trace (ADR-5057). |

### 5. Conflict detection: deterministic first, LLM second

Research (PRD §3) shows pure-LLM contradiction detection has low recall. So:

- **Deterministic (`lib/conflicts.cjs`, pure):** overlapping-context variants with different outcomes; duplicate ids; prohibition versus required variant on one operation and context; undefined contexts; unlocatable check targets. These alone may block.
- **LLM (phase 5, optional):** a skill that reads `APPLICABLE.md` plus the phase `SPEC.md` and proposes semantic conflicts. It follows ADR-550's recall-then-precision protocol: findings are confirmed by a human, dismissals need a reason, and `--auto` never dismisses. Its gate uses `agentVerdict`, which gsd-core forces to non-blocking. It runs at `discuss:post`, because no `plan:*` workflow evaluates an `agentVerdict` gate (A8).

### 6. Independence of checks

1. A `test`-tier check is written when the order is created or promoted, before the implementing phase, not by the executor.
2. The executor may not modify a check target (`plan:post` coverage gate).
3. The check must go RED on the violation fixture and GREEN on the clean fixture (gsd-core's existing prover).
4. Phase 6 may add concern-targeted mutants (Meta ACH style); a surviving mutant downgrades the order to `flagged`.

### 7. Trace and change impact

Each `TRACE.jsonl` record: `{ order_id, order_hash, contexts, phase, plans, check, disposition, commit_sha, ts }`. `order_hash` is a hash of the order's canonicalized YAML, stable under key reordering. The file is append-only.

- `standing-orders impact <id>` lists phases, plans, files, checks and last disposition for an order, plus whether its hash changed since.
- `standing-orders stale` lists orders whose current hash differs from their last trace. The `plan:pre` select step includes stale orders as a warning in `APPLICABLE.md`.

### 8. Manifest

```json
{
  "id": "standing-orders",
  "role": "feature",
  "version": "0.1.0",
  "title": "Standing Orders",
  "description": "Project-wide, context-scoped business rules: conflict-gated planning, independent fail-first checks, and rule-to-check traceability.",
  "tier": "full",
  "requires": [],
  "engines": { "gsd": ">=1.6.0" },
  "runtimeCompat": { "supported": ["*"], "unsupported": [] },
  "author": { "name": "The Artificer of Ciphers LLC", "url": "https://github.com/The-Artificer-of-Ciphers-LLC" },
  "homepage": "https://github.com/The-Artificer-of-Ciphers-LLC/standing-orders",
  "repository": "https://github.com/The-Artificer-of-Ciphers-LLC/standing-orders",
  "license": "MIT",
  "skills": [],
  "agents": [],
  "hooks": [],
  "activationKey": "standing-orders.enabled",
  "config": {
    "standing-orders.enabled": { "type": "boolean", "default": false, "description": "Enable Standing Orders. Hooks and commands are inert until true." },
    "standing-orders.block_on": { "type": "enum", "values": ["conflict", "conflict_or_missing", "never"], "default": "conflict", "description": "What blocks planning at plan:pre." },
    "standing-orders.max_bytes": { "type": "number", "default": 6000, "description": "Byte cap for APPLICABLE.md." }
  },
  "commands": [
    {
      "family": "standing-orders",
      "module": "standing-orders-router.cjs",
      "router": "routeStandingOrdersCommand",
      "subcommands": ["select", "conflicts", "coverage", "enforce", "trace", "impact", "stale", "validate"]
    }
  ],
  "steps": [
    {
      "point": "plan:pre",
      "ref": { "command": "standing-orders select" },
      "produces": [".planning/standing-orders/APPLICABLE.md", ".planning/standing-orders/CONFLICTS.json"],
      "consumes": [],
      "when": "standing-orders.enabled",
      "onError": "halt"
    },
    {
      "point": "ship:pre",
      "ref": { "command": "standing-orders trace" },
      "produces": [".planning/standing-orders/TRACE.jsonl"],
      "consumes": [".planning/standing-orders/APPLICABLE.md"],
      "when": "standing-orders.enabled",
      "onError": "skip"
    }
  ],
  "contributions": [
    {
      "point": "plan:pre",
      "into": "planner",
      "fragment": { "path": "fragments/plan-pre-planner.md" },
      "produces": [],
      "consumes": [".planning/standing-orders/APPLICABLE.md"],
      "when": "standing-orders.enabled",
      "onError": "skip"
    },
    {
      "point": "verify:pre",
      "into": "verifier",
      "fragment": { "path": "fragments/verify-pre-verifier.md" },
      "produces": [],
      "consumes": [".planning/standing-orders/APPLICABLE.md"],
      "when": "standing-orders.enabled",
      "onError": "skip"
    }
  ],
  "gates": [
    { "point": "plan:pre", "check": { "query": "standing-orders conflicts" }, "when": "standing-orders.enabled", "blocking": true, "onError": "halt" },
    { "point": "plan:post", "check": { "query": "standing-orders coverage" }, "when": "standing-orders.enabled", "blocking": false, "onError": "skip" },
    { "point": "execute:wave:post", "check": { "query": "standing-orders enforce" }, "when": "standing-orders.enabled", "blocking": true, "onError": "halt" }
  ]
}
```

The `plan:pre` step's `onError` is `halt` because the gate depends on its output; a silent skip would let planning run against no rules.

## Open questions (answered 2026-11-07; evidence from gsd-core `next` @ 59508eb999)

1. **Gate `query` dispatch to a third-party family — No.** The workflows run a gate as `gsd_run check ${hook.check.query}` (`gsd-core/workflows/plan-phase.md:1487`), and `src/check-command-router.cts:148-238` is a hardcoded `switch` over first-party check verbs; a `query` naming the `standing-orders` family is never dispatched through the installed command module. **Decision:** every blocking gate in §4 becomes a `step` that writes a verdict artifact plus a `predicate` gate over it. The only implemented predicate kinds are `command-exit-zero` and `artifact-frontmatter-equals` (`src/gate-predicate-evaluator.cts:43`); the `artifact-exists` / `config-equals` kinds named in ADR-894 do not exist. Phase 2 chooses between the two at design time. The manifest in §8 is superseded on this point: its three `query` gates are illustrative only.
2. **Predicate-rail altitude — No breach, with two recorded conditions.** ADR-857's rule ("gates run against the spec = hook; predicate-generation defines the spec's reach = core") exists so that the verifier's *floor* of reach never depends on an optional plug-in. Standing Orders does not touch that floor: off, GSD is byte-identical and the core probes still generate every per-phase predicate; on, it only *adds* predicates above the floor, projected into the `must_haves.prohibitions` shape the core generator emits and graded by the unchanged core verifier. Its blocking hooks are gates run against the spec, which the rule places at hook altitude. The maintainer confirmed this reading on 2026-11-07. **Conditions:** (a) the planner contribution says the orders apply *in addition to* the phase's own predicates, never *instead of*; (b) the verifier contribution grades only the added predicates and never alters the grading of core ones. If gsd-core later wants cross-phase rules in core, this capability's `lib/` is the migration candidate (the "contribute to gsd-core as first-party" alternative below).
3. **Public stability of `check prohibition-enforcement` — interface read from source; pin in phase 3.** The request is `{ prohibition, check: { kind, target, rule?, violationFixture?, cleanFixture? }, mode? }`, passed as `<request.json>` or `--json '<inline>'`, and the result is an `advisory` `GateVerdict` whose payload is an `EnforcementResult` (`src/gate-prohibition-enforcement.cts:17-19,48-105`). It is documented in gsd-core's `docs/CLI-TOOLS.md` and governed by ADR-1606. Phase 3 pins `engines.gsd` to the range in which this shape holds and adds a request-shape contract test.

## Amendments (2026-11-07, phase 1)

**A1 — gsd-core's prohibition vocabulary has no `backstop`.** `src/probe-core.cts:317` defines `ProhibitionVerification = 'test' | 'judgment'`. `backstop` is this capability's term. When phase 3 projects an order into a `must_haves.prohibitions` item it maps `backstop` → `judgment`; a `backstop` order is otherwise handed only to the verifier contribution, which reports it `insufficient_spec`.

**A2 — §3 semantics made exact (confirmed by the maintainer).**
- *Context resolution.* Every context resolves to a closed set of **leaf** contexts. A context with no members is a leaf resolving to `{ itself }`. `includes: [x, y]` is the union of x's and y's leaf sets. `extends: p` makes this context a member of `p`: the same membership edge as `p` including it, written from the child's side. A context with members is exactly the union of its members and is not itself a leaf. An order's effective contexts are the union of its named contexts' leaf sets, or every leaf when it names none. Two orders' contexts *overlap* when their effective leaf sets intersect. Cycles and undefined names are errors.
- *Scope.* `scope.paths` are minimal globs (`*` within one segment, `**` zero or more segments, `?` one non-slash character; everything else literal) over forward-slash paths, backslashes normalised unconditionally. `scope.requirements` match exactly. An order with no scope is **global**: it applies to every phase.
- *Strictness.* `version` must be `1`; unknown keys, unknown enum values, duplicate ids and a `variant` without `operation`/`outcome` are errors. A `test`-tier order lacking `check_violation_fixture` or `check_clean_fixture` is a **warning**, because gsd-core's prover requires both to prove a node-test check (`src/prohibition-enforcement.cts:76-86`) and will otherwise report it `flagged`.
- *Byte cap.* `APPLICABLE.md` packs **whole** orders, `test` tier before `backstop` then by id, into `standing-orders.max_bytes` measured in UTF-8 bytes, with a header stating the orders apply in addition to the phase's own `must_haves` and a footer that always states the omitted count.
- *Conflicts (deterministic).* `variant-outcome` (same operation, overlapping contexts, different outcomes), `prohibition-vs-variant` (same operation, overlapping contexts), `duplicate-id`. A prohibition and an invariant never conflict. An unlocatable `test`-tier `check_target` is reported separately (`missingChecks`), and whether it blocks is `standing-orders.block_on`.
- The exact schema, codes and report shape are in [`references/standing-orders.md`](../../references/standing-orders.md), which a test keeps in parity with the code.

**A3 — Rollout corrected by the phase-coverage check.** As first written, the `verify:pre` verifier contribution (PRD R12, acceptance criterion 4) and the schema reference document were owned by no phase, and phase 1's `standing-orders validate` had no reachable surface before the phase 2 manifest. Corrected: the verifier contribution moves to **phase 3**; the reference document lands in **phase 1**; `validate` is reachable in phase 1 as a direct CLI (`node standing-orders-router.cjs validate [file] [--raw]`) and through `gsd_run` from phase 2. The corrected trace passes the coverage check with zero gaps.

**A4 — Dependencies.** Install is copy-only (ADR-1244 D5 rule 1; `src/capability-source.cts:786`), so the capability has no runtime npm dependencies. js-yaml 4.3.2 (`dist/js-yaml.js`, MIT) is vendored at `lib/vendor/js-yaml.cjs`, byte-identical to gsd-core's own vendored copy, with the same `FAILSAFE_SCHEMA` + anchor-refusing listener posture as `src/frontmatter.cts:240-263`; `scripts/check-vendored.cjs` guards drift against the pinned devDependency.

## Amendments (2026-11-07, phase 2)

**A5 — The host does not dispatch third-party `plan:pre` steps or gates; the block moves to `plan:post`, with a planner-run select in front of it.** gsd-core 1.19–1.20 `workflows/plan-phase.md` §5.6 runs a `plan:pre` step only when it is a `ref.skill` (and only under auto-chain) or a `ref.agent`, and evaluates only its hardcoded UI and drift gates. A `ref.command` step or a `predicate` gate at `plan:pre` is validated, rendered by `loop render-hooks`, and never run. `plan:post` (§13e) dispatches every step and every gate per `references/loop-hook-dispatch.md`. A `plan:pre` contribution cannot reach the orchestrator either: that point's roles are `researcher`, `planner` and `checker`. Reported upstream as [open-gsd/gsd-core#5982](https://github.com/open-gsd/gsd-core/issues/5982) (sibling of #5960). Decision, confirmed by the maintainer on 2026-11-07:

- The manifest still declares the `plan:pre` step (`standing-orders select`) and a blocking `plan:pre` predicate gate, so both start running once the host dispatches them. `select` is idempotent, so a host-run and a planner-run select cannot disagree.
- The `plan:pre` planner contribution tells the planner to run `standing-orders select` itself before writing plans and to stop on `"conflicts": "blocked"`. This is defense in depth, not the mechanical block.
- The mechanical block is at `plan:post`: a `standing-orders coverage` step recomputes conflicts and citations, and two blocking `artifact-frontmatter-equals` gates read the verdict it writes. A conflict therefore always stops the phase before execution; until #5982 is fixed it may not stop the planner from running first.

Gate shape (open question 1): every gate is `artifact-frontmatter-equals` over `<phase dir>/STANDING-ORDERS.md` (`conflicts == clear`, `coverage == complete`). `command-exit-zero` was rejected because `gsd_run` is a shell function in the workflows, not a binary on the bounded `sh` PATH the predicate runs in.

Phase resolution: a `ref.command` step receives only `--phase <N>`. The router resolves the phase directory and requirement ids through the host's public `init plan-phase <N> --raw`, the call plan-phase itself makes, in a bounded subprocess. It does not reimplement gsd-core's phase locator (custom, bracket and workstream naming).

Selection scope at `plan:pre`: a phase's files are the paths its planning documents name plus any existing plans' `files_modified`. `coverage` at `plan:post` recomputes from the plans' actual `files_modified` and `requirements`, so an order that becomes applicable only once the plans exist must still be cited. A conflict blocks only when at least one of its orders applies to the phase; an invalid or unreadable `ORDERS.yaml` always blocks unless `block_on` is `never`.

## Amendments (2026-11-08, phase 3)

**A6 — Orders reach the verifier through the plan, not through a `verify:pre` contribution.** Read from gsd-core 1.19.0, 1.20.1 and `next`:

- `verify:pre` belongs to `workflows/verify-work.md`, whose loop-host marker declares `agent-roles: orchestrator` (line 4). Under the role partition gsd-core made normative in #4740, a contribution `into: verifier` there is invalid.
- `verifier` is admitted at the `execute:*` points (`workflows/execute-phase.md:4`), but the only place `gsd-verifier` is spawned, `execute-phase/steps/verify-phase-goal.md:128-158`, has no contribution block, so such a fragment is never delivered. Reported upstream as [open-gsd/gsd-core#5984](https://github.com/open-gsd/gsd-core/issues/5984).
- `gsd-verifier` already grades the plan's `must_haves`: a `truths` item `{statement, verification: backstop}` is `insufficient_spec` and becomes a human-verification item (`agents/gsd-verifier.md:210`); a `prohibitions` item with `verification: test` and no enforcement evidence is flagged, never green (`:159-164`).

Decision, confirmed by the maintainer on 2026-11-08:

- The `plan:pre` planner contribution tells the planner to **project** every applicable order into a plan's `must_haves`: a `test` order as a `prohibitions` item `{statement: "<id>: …", status: resolved, verification: test, check_kind, check_target, …}` (gsd-core's own field names), a `backstop` order as a `truths` item `{statement: "<id>: …", verification: backstop}`. `APPLICABLE.md` prints the exact item for each order.
- `standing-orders coverage` at `plan:post` rejects a phase whose plans cite an order without projecting it (`not_projected`), so the projection is mechanical, not advisory.
- No `verify:pre` contribution is declared. It returns, as an `execute:post` contribution `into: verifier`, once #5984 gives the verifier a landing site.
- This supersedes A1's `backstop` → `judgment` mapping: a `backstop` order is never a prohibition item and is never sent to the prover. A `judgment` prohibition would route to judgment review rather than `insufficient_spec`; the `backstop` truth is the host's own tier for "known rule, no mechanical check".
- Open question 2's condition (b) still holds: projection only adds `must_haves` items; it changes nothing about how the verifier grades the phase's own predicates.

Cost, stated rather than hidden: `gsd-verifier` receives no enforcement evidence for a projected `test` prohibition, so it reports it flagged and the phase verifies `human_needed`. The mechanical proof that a `test` order holds is the `execute:wave:post` enforce gate (below). Delivering that evidence to the verifier also depends on #5984.

**Enforce gate.** As with A5, the gate is a step plus a predicate: `standing-orders enforce` at `execute:wave:post` (which the host dispatches for every `ref.command` step, `execute-phase.md:993`) runs `gsd-tools check prohibition-enforcement --json <request>` once per applicable `test` order, with the project root as working directory (the prover resolves relative paths against the process cwd), each call bounded at 180 s. It writes `enforcement` into `STANDING-ORDERS.md`; a blocking `artifact-frontmatter-equals` gate requires `enforcement == clear`. An order counts as proven only when the host answers `status: green` **and** `flagged: false`; a timeout, a non-zero exit, unreadable output or a missing host CLI is `flagged`. `select` and `coverage` reset the field to `pending`, and `enforce` writes `pending` before it runs any check, so a run that never finishes cannot leave a stale `clear`.

**Check-file edit rule (R11).** `coverage` rejects a plan whose `files_modified` names a check file of an applicable `test` order: the `check_target` of a `node-test` order, and the violation and clean fixtures of either kind. A `lint-rule` order's `check_target` is the code under the rule, which the phase is expected to change, so it is not protected.

**Open question 3, pinned.** The request/response shape is byte-identical in gsd-core 1.19.0, 1.20.1 and `next`. `engines.gsd` is `>=1.19.0 <2.0.0`; the `host-contract` CI job runs a request-shape contract test against 1.19.0 and 1.20.1, and a minor release that changes the shape fails that test.

## Amendments (2026-11-08, phase 4)

**A7 — The trace step commits its own ledger; the record gains `files`; the hash covers the normalized order.** Read from gsd-core 1.19–1.20 `workflows/ship.md`: preflight step 2 requires a clean working tree, step 6 dispatches `ship:pre` gates and then every `ship:pre` step (`gsd_run <ref.command> --phase <n> --raw`, per `references/loop-hook-dispatch.md`), and the push follows. Ship's own later commit names only `.planning/STATE.md`. A `TRACE.jsonl` written by the step and left on disk would therefore never reach the pull request, and would fail the next phase's clean-tree check.

Decision, confirmed by the maintainer on 2026-11-08:

- `standing-orders trace` appends its records and then commits **only** `.planning/standing-orders/TRACE.jsonl` through the host's own commit tool (`gsd-tools commit "<message>" --files <path>`), which applies the project's `commit_docs` policy. When the host skips the commit (`commit_docs` false, or `.planning/` ignored), the file stays written but uncommitted and the step warns; a step never blocks ship. The step declares `onError: skip`, which is how the host treats every `ship:pre` step anyway.
- `commit_sha` is the last commit that touches anything other than `TRACE.jsonl` (`git log -1 --format=%H -- . ':(exclude).planning/standing-orders/TRACE.jsonl'`, bounded at 10 s). A ship re-run after the trace commit resolves to the same code commit.
- A re-run appends nothing it has already recorded: a candidate whose `(order_id, order_hash, phase, commit_sha)` already appears is skipped. The file is only ever appended to; an unreadable line is skipped when reading and never rewritten.
- Each record also carries `files`, the phase's files that matched the order's `scope.paths`, because R14 asks `impact` to list files. `plans` lists the plans whose `must_haves` cite the order. `disposition` is `proven` (the host answered `green` and unflagged in this phase's `ENFORCEMENT.json`), `flagged`, `unenforced` (no enforcement result for this phase) or `insufficient_spec` (`backstop`).
- `order_hash` is `sha256:` over canonical JSON of the **normalized** order: keys sorted, the set-valued lists (`contexts`, `scope.paths`, `scope.requirements`) sorted and de-duplicated, null fields and empty lists omitted. It is stable under key reordering, list reordering and reformatting, and a later optional field with no value does not re-hash existing orders. A redefinition of a context the order names does not change its hash; `stale` and `impact` report it as `contexts_changed` by comparing the record's effective leaf contexts.
- `impact` and `stale` only read, so they answer whether or not `standing-orders.enabled` is set, like `validate`. `stale` exits 1 when any order is stale.

Known limit, stated: append-only is a convention enforced by this tool, not tamper evidence. The ledger is a tracked file, and its history is git's.

## Amendments (2026-11-08, phase 5)

**A8 — The LLM conflict pass runs at `discuss:post`; promotion and findings go through commands.** Read from gsd-core 1.19.0: no `plan:*` or `ship:*` workflow evaluates an `agentVerdict` gate. `plan-phase.md` dispatches gates by `query` or `predicate` and skips any other shape with a warning, and `ship.md` states that `agentVerdict` "has no runner at `ship:pre`". `plan:pre` also dispatches skill steps only when auto-chaining. A `plan:pre` `agentVerdict` gate, as §5 first described it, would validate and then never run. `discuss-phase.md` dispatches `discuss:post` through the generic `references/loop-hook-dispatch.md` contract, which dispatches every step (a `ref.skill` step through the Skill tool as `gsd-<stem>`) and evaluates every gate, `agentVerdict` included, treating `blocking: false` as advisory.

Decision, confirmed by the maintainer on 2026-11-08:

- The LLM pass is the skill `standing-orders-conflict-review`, named by a non-blocking `agentVerdict` gate at `discuss:post`. `APPLICABLE.md` is not yet written at that point, so the skill runs `standing-orders select` itself, then reads `APPLICABLE.md`, `CONFLICTS.json`, the phase `SPEC.md` and `CONTEXT.md`. It can also be run by hand with a phase number.
- Its findings are recorded with `standing-orders semantic` in `<phase dir>/STANDING-ORDERS-SEMANTIC.json`, using ADR-550's lifecycle: `unresolved`, `resolved` (confirmed by a human), or `dismissed` (with a required non-empty reason). The command refuses a dismissal without a reason, and refuses any decision made with `--auto`: in auto mode findings can be proposed but stay `unresolved`. These rules are what CI tests; the quality of the LLM's recall and precision is not (ADR-550 D5).
- A confirmed finding stays advisory, as §5 requires. It is fixed by editing `ORDERS.yaml`, after which the deterministic gate enforces it.
- Promotion (`standing-orders-promote`, a `discuss:post` skill step) writes only through `standing-orders promote --add`, which adds exactly one order per call and refuses a list. "One confirmation each" is therefore a property of the command, not only of the skill's wording. The order is inserted into `ORDERS.yaml` as text, so comments and layout survive, and the result is re-parsed: if it does not parse, or any existing order's hash changed, nothing is written and the command returns the YAML to paste by hand. `promote --candidates` lists the phase's resolved `SPEC.md` prohibitions and `CONTEXT.md` decisions, and marks the ones already promoted by their `source`.

Known limit, stated: how an orchestrator evaluates an `agentVerdict` gate is host prose, not code; gsd-core ships no deterministic runner for it.

## Amendments (2026-11-08, phase 7)

**A9 — Integrity of check files and gate inputs.** An adversarial review of `main` at the end of phase 6 ([#15](https://github.com/The-Artificer-of-Ciphers-LLC/standing-orders/issues/15)) found four gaps:

- The R11 check-file rule (A6) matched `files_modified` entries only as exact paths. A plan listing a directory, a glob, an absolute path or a symlink that covered a check file still passed.
- A deleted `ORDERS.yaml` read as "zero orders", which cleared every gate.
- Nothing noticed an executor editing a check file that it had not listed.
- `trace` trusted `ENFORCEMENT.json` by phase alone.

Decision, confirmed by the maintainer on 2026-11-08:

- **Protected set.** The protected set is, for every `test` order in `ORDERS.yaml` (applicable to the phase or not): a `node-test` order's `check_target`, the violation and clean fixtures, every `check_mutants` path, and `MUTANTS.json` when any order has mutants. `ORDERS.yaml` itself is in the set whenever the capability is enabled. A `lint-rule` order's `check_target` stays outside it: that file is the code under the rule (A6), a deliberate narrowing of PRD R11's wording.
- **Plan entries are read the safe way.** A `files_modified` entry counts as an edit of every protected file it could cover:
  - an exact path, in any spelling;
  - a directory, written with a trailing `/` or existing on disk as one;
  - a glob, using the same glob rules as `scope.paths`;
  - an absolute path inside the project;
  - an existing path whose real location is a protected file.
- **Integrity record.** Before writing the verdict, `coverage` writes `<phase dir>/STANDING-ORDERS-INTEGRITY.json`. It records the `sha256` of every protected file (or `null` when the file is absent) and of each graded plan. `select` resets it. Before running any check, `enforce` re-hashes the protected files:
  - Any difference flags every applicable `test` order with `check_file_changed: <paths>`, and no check is run, so an edited check is never executed. This includes a deleted or newly created `ORDERS.yaml`.
  - A missing, unreadable or wrong-phase record is `integrity_missing`, which is flagged. This holds even when `ORDERS.yaml` is missing too, because `coverage` always writes a record when the capability is enabled.
  - A protected file larger than the hash bound (1 MiB) is never treated as unchanged. `coverage` reports it `check_file_too_large`.
  - A changed plan only adds the warning `plan_changed`, because executors legitimately touch plans.
- **No re-baselining from inside a phase.** `coverage` refuses to replace an existing record whose protected-file hashes differ from the files on disk. It reports `check_file_changed` and keeps the old record. Only `select`, the start of planning, resets the record (confirmed by the maintainer on 2026-11-08, after the phase-7 review showed that an executor could edit a check and then re-run `coverage`).
- **Trace binding.** Each enforcement result carries its order's `order_hash`, and `ENFORCEMENT.json` carries the hashes enforce verified. `trace` records `proven` only when both are present and still match. Otherwise the order is `unenforced` (a missing or different order hash, or no recorded hashes) or `flagged` (a check file changed).
- **Smaller corrections from the same review:**
  - Only a JSON `true` enables the capability; the string `"false"` used to enable it.
  - Conflict detection compares `operation` names after compatibility decomposition (NFKD) and lower-casing, with combining marks and zero-width characters removed, then trimmed (so `İ` matches `i`).
  - `max_bytes` has a floor of 512 bytes, and the header and footer count against the cap.

Known limit, stated: the integrity record is a project file. An executor that deliberately rewrites both a check and the record, or re-plans the phase from `select`, defeats it. That is the same trust boundary §6 accepts for the check files themselves. It closes the silent and unlisted edits and the deleted-`ORDERS.yaml` hole. Acceptance criterion 4 (`backstop` yields `insufficient_spec`) depends on gsd-verifier's grading prose (A6), which no test in this repository can run. It is stated here next to [open-gsd/gsd-core#5984](https://github.com/open-gsd/gsd-core/issues/5984).

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| Status quo: per-phase prohibitions only | Leaves every gap in PRD §2. |
| LLM-only conflict engine | Low recall per the literature; a silent miss is the failure being prevented. |
| Formal methods by default | High authoring cost; verified code can still fail runtime limits (AxDafny). A future `check_kind`. |
| Adopt Spec Kit, Kiro or Tessl | Duplicates GSD's spec pipeline and loses its fail-first prover and gate seams. |
| Rules as prose in `REQUIREMENTS.md` | Unparseable, no contexts, no check descriptor. Orders reference requirement ids instead. |
| Contribute it to gsd-core as first-party | Ships to every GSD user and needs a gsd-core ADR and issue; a third-party capability proves it out first. |
| Copy the fail-first prover into this repo | Two provers drift; gsd-core's is tested and bounded. Call the public verb. |

## Consequences

**Positive**
- Rules outlive phases and bind every agent that touches their scope.
- Context-dependent behaviour is representable and conflict-checked.
- Planner input is limited to applicable rules within a byte cap.
- Rule changes have an impact query.
- Enforcement reuses gsd-core's tested prover.

**Negative**
- Dependence on gsd-core host contracts listed above; mitigated by `engines.gsd` and gsd-core's load-time skip of incompatible capabilities.
- Users must consent to an executable command module at install (ADR-1244 D5).
- Authoring cost for orders; mitigated by promotion and the `backstop` tier.

## Rollout

Each phase is one sub-issue and one PR, stacked on `main`; epic [#1](https://github.com/The-Artificer-of-Ciphers-LLC/standing-orders/issues/1). Corrected per amendment A3.

| Phase | Issue | Deliverable | Owns (PRD) | Exit gate |
| --- | --- | --- | --- | --- |
| 1 | #2 | `lib/orders.cjs`, `select.cjs`, `conflicts.cjs`; router with `validate` (direct CLI); `references/standing-orders.md`; vendored js-yaml; this amendment. | R1, R2, R3, R4, R5 (library), R6 (library), AC7 | Unit tests plus `fast-check` properties: context closure idempotent, conflict detection symmetric, selection monotone in scope; byte-cap tests at limit −1, limit, limit +1; `validate` runnable as a direct CLI. |
| 2 | #3 | Manifest, `select`/`conflicts`/`coverage` subcommands, `plan:pre` select step, planner contribution, `plan:pre` and `plan:post` gates as step + `predicate`. | R5 (wiring), R6 (gate), R7, R9, R17, AC1, AC2, AC5 | Manifest passes gsd-core's validator; installs from a local path and from git; `standing-orders` family reachable through `gsd_run`. |
| 3 | #4 | `enforce` step + `execute:wave:post` predicate gate via `check prohibition-enforcement`; check-file edit rule and projection rule extending `coverage`; planner projection of orders into `must_haves` (A6, replacing the `verify:pre` verifier contribution). | R10, R11, R12, AC3, AC4, AC8 | Request-shape contract test against gsd-core 1.19.0 and 1.20.1; RED fixture for a plan editing a check target; a `backstop` order projected as a `verification: backstop` truth, which gsd-verifier reports `insufficient_spec`. |
| 4 | #5 | `trace` ship:pre step (commits its own ledger, A7), `impact`, `stale`; `select` warns on stale orders. | R13, R14, R15, AC6 | Append-only property test; hash stable under key reorder; `impact` and `stale` reachable through `gsd_run`. |
| 5 | #6 | Promotion skill + `promote` command; LLM conflict skill as a non-blocking `agentVerdict` gate at `discuss:post` + `semantic` command (A8). | R8, R16 | Dismissal-needs-reason and `--auto`-never-dismisses tests; one order per `promote --add` call. |
| 6 | #7 | Mutation hardening. | — | Separate ADR before any implementation. |
