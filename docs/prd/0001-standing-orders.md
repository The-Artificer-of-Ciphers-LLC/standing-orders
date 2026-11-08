# PRD-0001: Standing Orders — project-wide business rules for the GSD loop

- **Status:** Draft
- **Date:** 2026-11-07
- **Owner:** The Artificer of Ciphers LLC
- **Architecture:** [ADR-0001](../adr/0001-standing-orders-architecture.md)
- **Research:** [Article review](research/2026-11-07-crespo-article-review.md)

## 1. Summary

Standing Orders is a GSD third-party capability. It keeps a project's business rules in one YAML file, scoped by the contexts they apply in. During the GSD loop it gives the planner only the rules that apply to the work at hand, blocks planning when rules conflict or are missing a check, enforces rules with checks written before the code, and records which rules each shipped phase was held to.

The name comes from the military term: a standing order stays in force across every mission until someone revokes it. A GSD phase is a mission; a standing order outlives it.

## 2. Problem

AI coding agents produce code that matches the prompt but breaks rules the prompt never stated. The source idea (Crespo, *AI Advances*, Oct 2026) frames it as `y = F(x, z)`: correct code depends on the prompt `x` and on semantic context `z` (business rules, invariants, cross-module dependencies). The same prompt under two contexts has two different correct answers. The worked example is a refund: contract A allows a full refund, contract B a prorated one, and neither permits a refund to run twice.

GSD already handles this inside a single phase. `spec-phase` writes a `SPEC.md` with prohibitions and edge cases, the prohibition probe finds missing must-NOTs, wired checks are proven to fail before the code exists, and the verifier grades against those predicates rather than its own judgment.

What GSD lacks is scope and lifetime:

1. **Rules die with the phase.** A prohibition found in phase 3 is not visible to phase 9, even when phase 9 rewrites the same code.
2. **No notion of context.** GSD cannot say "this rule holds under contract A, that one under contract B".
3. **No conflict detection between rules.** Probes find gaps inside one spec. Nothing finds two rules that contradict each other.
4. **No trace across phases.** When a rule changes, nothing answers "which phases, files, and checks depended on it?"
5. **No selective injection.** The planner gets the phase spec. It does not get the project rules that apply to the files it is about to touch.

## 3. Evidence

| Claim | Evidence | Verdict |
| --- | --- | --- |
| Agents produce far more code than shipped value | NBER w35275: commits +180% with autonomous agents, releases only +30%. The article's "240%" figure is not in the source. | Direction holds. |
| Self-reported AI productivity is unreliable | METR RCT (2025): experienced developers were 19% slower with AI while believing they were 20% faster. | Strong. |
| AI amplifies existing engineering practice | DORA 2025 State of AI-assisted Software Development. | Supported. |
| Tests written by the code's author pass wrong code | arXiv 2409.09464: tests generated against incorrect code detect 47% fewer bugs. arXiv 2504.03846: models favour their own wrong output, more so in stronger models. arXiv 2505.16222: LLM code judges flip verdicts on superficial cues. | Supported. Checks must be independent. |
| Property and invariant checks beat example tests | arXiv 2506.18315: +23–37% pass@1 over TDD baselines. PROBE (ACL 2026 Findings): generated properties are often weak and need adversarial validation. | Supported, with a caveat. |
| Concern-targeted mutation hardens tests | Meta ACH (FSE '25): 571 privacy-hardening tests, 73% accepted by engineers. | Supported. |
| Conflicting requirements can be detected | ALICE (ASE 2024): hybrid logic + LLM finds 60% of contradictions, beating LLM-only. arXiv 2412.01657: hybrid pipelines win. | Partial. Detection must be hybrid and is never complete. |
| Spec-driven tools already exist | GitHub Spec Kit, AWS Kiro (EARS criteria), Tessl. Böckeler (martinfowler.com, Oct 2025): verbose for small work, MDD-style rigidity plus non-determinism. Spec Growth Engine (arXiv 2606.27045): blocking drift gate, no outcome data. | Crowded space. The differentiator is enforcement and traceability. |
| Load only relevant context | Anthropic, "Effective context engineering for AI agents" (Sep 2025). | Supports selective injection. |

Full sources are in §10.

## 4. Users

- **Solo developer running GSD** on a product with real business rules: billing, permissions, compliance, data retention.
- **Team lead** who wants rules agreed once to bind every later phase and every agent.
- **Auditor or reviewer** who needs to know which rules a shipped change was checked against.

## 5. Goals

1. A rule recorded once binds every later phase whose work it touches.
2. Rules can differ by context, and contradictions between rules are caught before planning.
3. Missing or conflicting rules stop the loop instead of letting the agent guess.
4. A rule with a mechanical check is enforced by a check the executing agent did not write.
5. A rule change has a concrete impact query.
6. Turning the capability off changes nothing in GSD's output.

## 6. Non-goals

- Replacing `spec-phase`, the edge probe, or the prohibition probe. Standing Orders feeds and extends them.
- Formal verification (Dafny, TLA+, Alloy) in the first release.
- Recovering undocumented rules automatically from the codebase.
- A UI. The interface is YAML plus GSD commands.

## 7. Requirements

### Rule store
- **R1.** Rules live in `.planning/standing-orders/ORDERS.yaml`, human-owned and reviewed in git.
- **R2.** A rule has an id, kind (`prohibition`, `invariant`, `variant`), statement, operation, contexts, scope (paths and requirement ids), verification tier (`test` or `backstop`), an optional check descriptor, and a source.
- **R3.** Contexts are named and may include or extend other contexts. Cycles and undefined contexts are errors.
- **R4.** The file is parsed as untrusted input: YAML anchors and aliases are refused, scalars stay strings.

### Selection and gating
- **R5.** At `plan:pre`, only rules whose scope matches the phase's files or requirement ids reach the planner, within a byte cap, with a count of omitted rules.
- **R6.** Two `variant` rules for the same operation with overlapping contexts and different outcomes block planning.
- **R7.** An applicable `test`-tier rule whose check cannot be located blocks planning when configured to.
- **R8.** An optional LLM pass proposes semantic conflicts the deterministic pass cannot see. Its findings need confirmation, a dismissal needs a reason, and `--auto` never dismisses one.
- **R9.** At `plan:post`, every applicable rule is cited by a plan.

### Enforcement
- **R10.** At `execute:wave:post`, each applicable `test`-tier rule's check runs through GSD's existing fail-first prohibition enforcement: RED on a known-bad fixture, GREEN on a known-clean one.
- **R11.** A plan may not modify an applicable rule's check target.
- **R12.** A `backstop` rule is reported `insufficient_spec` at verification, never passed.

### Traceability
- **R13.** At `ship:pre`, one append-only trace record is written per applicable rule: rule id, rule hash, contexts, phase, plans, check, disposition, commit sha, time.
- **R14.** `standing-orders impact <rule-id>` lists the phases, files, and checks that depended on a rule, and flags a hash mismatch after the rule changes.
- **R15.** `standing-orders stale` lists every traced rule whose current definition differs from its last trace.

### Adoption
- **R16.** At `discuss:post`, resolved phase prohibitions and CONTEXT.md decisions can be promoted to standing orders, one human confirmation each.
- **R17.** The capability is off by default.

## 8. Acceptance criteria

1. A rule whose `scope.paths` matches a later phase's files appears in that phase's planner input, and a non-matching rule does not.
2. Two conflicting `variant` rules block `plan:pre` when `standing-orders.block_on` is `conflict`.
3. A `test`-tier rule whose check passes on the violation fixture is reported `flagged`, never green.
4. A `backstop` rule yields `insufficient_spec` at verification, never `passed`.
5. With `standing-orders.enabled` false or absent, GSD output is byte-identical to a project without the capability.
6. `standing-orders impact <id>` lists every phase that shipped against the rule and reports a hash mismatch after the rule is edited.
7. `ORDERS.yaml` containing a YAML anchor or alias is rejected without its content being parsed.
8. A plan listing an applicable rule's check target in `files_modified` is rejected at `plan:post`.

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| Spec tax on small projects | Off by default; promotion from existing artifacts; `backstop` is a legal tier. |
| Rules go stale | `standing-orders stale` feeds a `plan:pre` warning. |
| Prompt injection through rule text | Rule text reaches agents only inside a labeled contribution block, and `.planning/` writes pass GSD's prompt guard. |
| False confidence from a green rule | Fail-first proof is required; `backstop` never passes; the trace records the disposition, not just "ran". |
| Host contract changes | `engines.gsd` pins the supported range; GSD skips an incompatible capability at load instead of crashing. |

## 10. Sources

- Crespo, "Prompting Is Now the Slowest, Buggiest Way to Code with AI", AI Advances, Oct 29 2026 — reviewed in [research/2026-11-07-crespo-article-review.md](research/2026-11-07-crespo-article-review.md)
- Crespo, "The AI That Cracks the Context Problem" — https://www.josecrespophd.org/p/the-ai-that-cracks-the-context-problem
- NBER w35275, Writing Code vs. Shipping Code — https://www.nber.org/papers/w35275
- METR RCT coverage — https://getdx.com/blog/metr-study-on-how-ai-affects-developer-productivity/
- DORA 2025 — https://dora.dev/research/ai
- arXiv 2409.09464 — https://arxiv.org/pdf/2409.09464v3
- arXiv 2504.03846 — https://arxiv.org/html/2504.03846v3
- arXiv 2505.16222 — https://arxiv.org/pdf/2505.16222
- arXiv 2506.18315 — https://arxiv.org/abs/2506.18315v1
- PROBE, ACL 2026 Findings — https://preview.aclanthology.org/ingest-acl/2026.findings-acl.683/
- Meta ACH, FSE '25 — https://arxiv.org/pdf/2501.12862
- Gärtner & Göhlich, ALICE, ASE 2024 — https://link.springer.com/article/10.1007/s10515-024-00452-x
- arXiv 2412.01657 — https://ar5iv.labs.arxiv.org/html/2412.01657
- Böckeler, Understanding Spec-Driven-Development — https://www.martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html
- GitHub Spec Kit — https://github.github.com/spec-kit/
- Spec Growth Engine, arXiv 2606.27045 — https://arxiv.org/pdf/2606.27045
- AxDafny, arXiv 2606.32007 — https://arxiv.org/abs/2606.32007
- EARS — https://en.wikipedia.org/wiki/Easy_Approach_to_Requirements_Syntax
- Anthropic, Effective context engineering for AI agents — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
