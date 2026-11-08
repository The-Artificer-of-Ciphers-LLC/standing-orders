# ADR-0001: Standing Orders architecture — a third-party GSD capability over existing seams

- **Status:** Proposed
- **Date:** 2026-11-07
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
| `discuss:post` | `step` (skill) | Offer to promote resolved phase prohibitions and project-wide CONTEXT.md decisions into `ORDERS.yaml`, one confirmation each. |
| `plan:pre` | `step` → `standing-orders select <phase-dir>` | Writes `APPLICABLE.md` (applicable orders only, byte-capped, omitted count stated) and `CONFLICTS.json`. `produces` both. |
| `plan:pre` | `contribution` into `planner` | Static fragment: read `APPLICABLE.md`; cite each order id in `must_haves`; never list a check target in `files_modified`. `consumes` `APPLICABLE.md`. |
| `plan:pre` | `gate` `query: standing-orders conflicts` | Blocks on validation errors, deterministic conflicts, undefined contexts, and (per `block_on`) unlocatable `test`-tier checks. |
| `plan:post` | `gate` `query: standing-orders coverage` | Every applicable order cited by a plan; no plan modifies a check target. |
| `execute:wave:post` | `gate` `query: standing-orders enforce` | For each applicable `test`-tier order, calls `gsd-tools check prohibition-enforcement --json` with the order projected as a prohibition. Reuses gsd-core's fail-first prover; no prover is copied into this repo. |
| `verify:pre` | `contribution` into `verifier` | Static fragment: grade applicable orders from `APPLICABLE.md` as exogenous predicates; a `backstop` order is `insufficient_spec`. |
| `ship:pre` | `step` → `standing-orders trace <phase-dir>` | Appends one `TRACE.jsonl` record per applicable order. Sole writer of the trace (ADR-5057). |

### 5. Conflict detection: deterministic first, LLM second

Research (PRD §3) shows pure-LLM contradiction detection has low recall. So:

- **Deterministic (`lib/conflicts.cjs`, pure):** overlapping-context variants with different outcomes; duplicate ids; prohibition versus required variant on one operation and context; undefined contexts; unlocatable check targets. These alone may block.
- **LLM (phase 5, optional):** a skill that reads `APPLICABLE.md` plus the phase `SPEC.md` and proposes semantic conflicts. It follows ADR-550's recall-then-precision protocol: findings are confirmed by a human, dismissals need a reason, and `--auto` never dismisses. Its gate uses `agentVerdict`, which gsd-core forces to non-blocking.

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

## Open questions (must be answered before phase 2)

1. **Gate `query` dispatch to a third-party family.** `loop-resolver.cts` renders a gate's `check` as text for the orchestrator to run. The sibling capability uses only steps and contributions, so no third-party gate has yet been exercised. Confirm a `query` naming the `standing-orders` family is dispatched through the installed command module. If it is not, express each gate as a `step` that writes a verdict file plus a `predicate` gate over it.
2. **Predicate-rail altitude.** gsd-core's ADR-857 amendment of 2026-06-12 makes predicate generation core substrate. Standing Orders adds an extra predicate source behind an off-by-default capability and removes nothing when off. Confirm with the gsd-core maintainer that this does not breach the altitude rule.
3. **Public stability of `check prohibition-enforcement`.** The enforce gate depends on that verb's request and payload shape. Confirm it is a supported interface, or pin `engines.gsd` to the range where it is known to match.

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

| Phase | Deliverable | Exit gate |
| --- | --- | --- |
| 1 | `lib/orders.cjs`, `select.cjs`, `conflicts.cjs`; `standing-orders validate`. | Unit tests plus `fast-check` properties: context closure idempotent, conflict detection symmetric, selection monotone in scope; byte-cap tests at limit −1, limit, limit +1. |
| 2 | Manifest, router, `select` step, planner contribution, `conflicts` and `coverage` gates. | Open question 1 answered; manifest passes gsd-core's validator; installs from a local path and from git. |
| 3 | `enforce` gate via `check prohibition-enforcement`; check-target edit rule. | Open question 3 answered; RED fixture for a plan editing a check target. |
| 4 | `trace`, `impact`, `stale`. | Append-only property test; hash stable under key reorder. |
| 5 | Promotion skill; LLM conflict skill. | Dismissal-needs-reason and `--auto`-never-dismisses tests. |
| 6 | Mutation hardening. | Separate ADR. |
