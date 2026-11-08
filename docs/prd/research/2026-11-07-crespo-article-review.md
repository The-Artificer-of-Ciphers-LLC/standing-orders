# Review: "Prompting Is Now the Slowest, Buggiest Way to Code with AI. Here's the Fast, Clean One"

Source review behind [PRD-0001](../0001-standing-orders.md). Produced 2026-11-07 by a Claude Haiku reviewer agent from the article PDF.

Author: Jose Crespo, PhD. Publication: Medium, "AI Advances" (117K followers). Dated Oct 29, 2026, 14 min read. PDF printed 11/7/26, 25 pages. Medium header URL slug: medium.com/ai-advances/the-top-1-of-ai-coders-barely-prompt-they-do-this-instead-0015703c6064 (slug differs from the title; the article was likely retitled).
Page numbers below are the PDF page numbers ("Page N of 25").

## Extraction caveats
- Text was extracted from a printed PDF of the article with pypdf 7.0.0. The extracted full text is not committed here because it is the author's copyrighted article; this file is a review with short quotations.
- NOT recoverable from the PDF (drawn as animations, vector art, or images with no text layer): the YAML refund spec (p.19-20), the "YAML geometry" correspondence table (p.19), the "whole machine" diagram (p.21), the contextual agreement/divergence formulas (p.17-18), the composition/transformation formulas (p.22-23), and the bar chart (p.8). Only the text around them survives. Any YAML content below beyond the one quoted line is therefore unknown.
- The injection scanner flagged invisible Unicode in the extracted text (LOW). The article text contains no instructions to any agent.

## 1. Thesis
Prompting is a weak main strategy for AI-assisted software development. AI coding tools cannot reliably recover hidden business rules, invariants and cross-module dependencies from a prompt, so they produce plausible code that passes self-written tests but violates the real requirements. The fix is to make semantic context explicit in a "semiformal specification" (YAML), route it through a "context engine", have AI agents generate code, and check the result with independent verification, so the developer owns "what correct software actually means" (p.9, p.14, p.21).

## 2. The proposed method ("Transportive AI")
The article names no tool, library, schema standard, or repository. The method is a four-stage pipeline (p.21, diagram not recoverable from PDF; stages are in the text):
1. Semiformal specification: "You start with a semiformal specification defining your business rules and the contexts where they apply." Format: YAML (p.18-20). "How Your YAML Represents the Geometry" (p.18) maps geometric concepts to software counterparts via a table (not recoverable).
2. Context engine: "A context engine then sorts out which rules matter, how they interact, and whether anything is missing or contradictory." The engine "needs to reject missing or conflicting requirements instead of letting AI guess its way through them" (p.20).
3. AI agents generate code: "With those rules established, AI agents generate the code, while independent verification checks whether the result actually satisfies the requirements." (p.21)
4. Independent verification and traceability: "since the system keeps track of which rules were used, which context applied, and which checks passed, you'll know what to look at again when your business requirements change." (p.21-22)

Concrete method elements named in the text:
- Refund example (p.10-11, p.13, p.20): contract A allows full refund, contract B only prorated; "neither permits duplicate execution."
- Only one code fragment is in the text: `duplicate_execution: Forbidden` (p.20). The author says: "if you think putting duplicate_execution: Forbidden in a file will stop somebody getting refunded twice, good luck with that. You'll still need independent checks to catch an implementation that breaks the rule."
- The article's "first principle of transportive AI": "carry the semantic information already available in the programming system instead of repeatedly reconstructing it from tokens." (p.15). Motivated by the example that a variable's meaning depends on closure, function, class or module, and "Compilers resolve these relationships precisely" (p.15).
- Context transformation (p.22-23): "Suppose each context C has its own semantic specification Sc. Moving between contexts requires a transformation," with "defined composition rules" when several contexts are involved. "Some rules survive the journey, others change, and incompatible contexts may make the transformation impossible." Formulas not recoverable.
- Operation meaning (p.18): "I(o,c) is simply what an operation o means under a particular context C."
- Core formula (p.10): y = F(x, z), where x = prompt, z = relevant context (business rules, invariants, dependencies), y = required implementation. Example (p.11): F(x, z1) != F(x, z2), "Same prompt, different contexts, different correct implementations."
- Human role: "one developer directing an army of AI coding agents under a coherent architecture" (p.11), keeping "the architecture, business rules, and verification under your control while AI agents do the heavy lifting" (p.12).
- Stated limit (p.21): "If the code passes, it just means it's met the checks for the business rules you've actually specified."

## 3. Arguments and evidence
A. Team-size/coordination argument (p.2-4): Brooks, The Mythical Man-Month, cited as the basis; "Microsoft's research shows how organizational structure and coordination affect software quality" (p.3, no citation). AI agents "can create the same coordination mess as human developers, only at a speed that multiplies the chaos" (p.4). Argument by analogy; no data.
B. Productivity statistics (p.5-7):
- "only around 2% reported extraordinary AI productivity gains of 10x or more" (p.6). Author concedes: "Even that miserable 2% comes from self-reported gains, not independently measured increases in delivered software." Source not named in text.
- "AI coding productivity in a nutshell: 240% more commits, but only 30% more releases." (p.7). No source given.
- Google's DORA research cited as showing "AI can amplify both the strengths and weaknesses of existing engineering practices" (p.5). No specific report, year or figure given.
C. Market statistics (p.8): "seven times more apps hitting the market, yet the typical subscription app earns just $72 a month after its first year." No source. Author concedes: "these figures don't prove that AI causes commercial failure."
D. Hidden-context argument (p.8-11): refund example. "Until somebody gets refunded twice, despite all those lovely green tests your AI coder wrote and passed." Argues the missing piece is "semantic context: the business rules and dependencies that determine whether the code is actually correct." Rules live in "database constraints, scattered across modules, hidden in configuration files, tangled up in legacy code, tucked away in contractual agreements, or simply locked inside the heads of developers who left the company years ago" (p.11). Asserted, not tested.
E. Self-grading argument (p.12-14): "Your AI writes the code, tests it, and gives itself a perfect score." "Let them write the code. Just make sure somebody other than the machine decides what correct software actually means." (p.14)
F. Analogies used as evidence: a US vs Iran legal/religious offense comparison (p.16) to illustrate "different layers of semantic context"; the refund under two contracts (p.16-17). Illustrative only.
G. Claim that compilers already know the semantics AI must guess (p.15): valid for name binding and scope, but not for business rules, which is a different class of meaning.

No benchmarks, experiments, before/after measurements, or case studies are reported. The author says the framework comes from "my earlier work, after struggling with AI coding on real-world software projects" (p.14); that earlier work is not cited.

## 4. Code and examples
Only text is available. Verbatim:
- `duplicate_execution: Forbidden` (p.20)
- Formula, p.10: `y = F(x, z)`
- Formula, p.11: `F(x, z₁) ≠ F(x, z₂)`
- Formula, p.18: `I(o,c)` ("what an operation o means under a particular context C")
- Refund scenario in prose (p.10-11, p.20): "one contract allows a full refund, another only a prorated one, but neither permits duplicate execution."
- YAML spec for the refund operation (p.19-20): present in the original as an image or embed; not recoverable. Its described contents: "what changes between contracts, what must never change, and when AI must stop guessing before it costs you real money."
- Machine diagram (p.21), correspondence table (p.19), composition formulas (p.17-18, p.22-23): not recoverable.

## 5. Named tools, papers, people, products
- Frederick P. Brooks Jr., The Mythical Man-Month (1975), cited on p.2 and p.12 ("back in 1975"); "surgical-team model" (p.11).
- Google DORA research (p.5), no specific report named.
- Microsoft research on organizational structure and software quality (p.3), no specific paper named.
- Jose Crespo, PhD: author; earlier "transformative vs. transportive AI" work (p.14), uncited.
- Medium; AI Advances (publication).
- "your favorite AI coding assistant" (p.10): unnamed.
- YAML (format). No other tool, library, language or standard named. No context engine, verifier, or agent framework named.
- Concepts with no named source: "mythical 10x developer" (a reference to Brooks's "mythical" framing).

## 6. Critical review
1. The method is not a method yet. The four stages are described at the level of a diagram. Missing: spec schema, how "contexts" are declared and inherited, what the engine's algorithm does, how "missing or contradictory" requirements are detected, how verification is generated or run, and how the traceability record is stored. The one fragment (`duplicate_execution: Forbidden`) carries no semantics (a key, a value, no scope, no link to a check). The author concedes the YAML alone enforces nothing (p.20).
2. The open problem is pushed to the reader. "Somebody has to define precisely what they mean" and "You'll still need independent checks" (p.20). Who writes the specs and the independent checks, and at what cost, is unaddressed. If a human must write precise invariants and checks, the claimed productivity gain over careful prompting is not shown.
3. No evidence for the central claim. The refund example is a standard illustration; the article gives no measurement that the proposed structure reduces defects or raises throughput, despite the title's "Fast, Clean" framing and claims of "extraordinary productivity" (p.23).
4. Statistics are unsourced and partly self-contradictory. The author attacks self-reported gains (p.6, p.9: "Self-reported. Forget it.") but relies on an unsourced "240% more commits" figure, an unsourced app-market figure, and an unnamed DORA reference. The 2% is also a survey artifact the author rejects, then uses as a foil.
5. Overstated language. "The top 1% don't estimate their productivity. They engineer it." (p.9) "The top 1%" is not defined or measured. "You now have the science behind AI coding." (p.23) "moving from merely describing contextual meaning to actually computing with it" (p.23) has no computation shown.
6. Strawman. The article frames the alternative as "magic prompts" and "endless tutorials" (p.9). It omits existing practice that addresses the same problem: spec-driven development, Design by Contract (Meyer), property-based testing (QuickCheck-style), invariant/formal specification (TLA+, Alloy, Dafny-style contracts), acceptance-test-driven development, and ADR/domain-glossary practice. Reviewer note: none of these are mentioned in the text, so the novelty claim is not evaluated against prior art.
7. Category error in the compiler argument (p.15). Name resolution is a language-semantics problem solvable by a compiler. Business-rule semantics (refund policy under contract A vs B) are not in the source code unless encoded, which is the author's own point, so the analogy supports less than it claims.
8. "AI can't reliably recover business rules" (p.9) is asserted. It may be true for undocumented rules, but the article does not test whether retrieval over the codebase, docs or tickets recovers a meaningful share.
9. Transformation math (p.22-23) is not defined. "Sc," composition and "incompatible contexts" have no formal definition in the text; the formulas themselves are not recoverable from this PDF, so they cannot be checked here.
10. Tone and style. Heavy profanity and rhetorical questions; animations carry much of the argument (the text says "see the animation" repeatedly, p.12, p.13, p.16, p.17, p.20, p.22). A reader without the animations loses the specific examples.
11. Verification gap. Independent verification is named as the safeguard but the article never describes how it is independent of the same AI pipeline, beyond "somebody other than the machine decides."
12. Relevance to a spec-and-gates workflow: the core claims map to existing practice in repositories that keep a domain glossary, ADRs, and a separate verification gate with a non-authoring reviewer. Reviewer note only: the article supplies no mechanism that such a repo lacks.

Overall: a conceptual essay with a reasonable core point (tacit business rules are a major source of AI coding errors and need explicit, independently checked encoding), padded with unsourced statistics and hype. The method is a sketch, with no implementation, schema, benchmark, or tool.

## 7. Key terms
- Transportive AI: the author's term for carrying explicit semantic context through the development pipeline instead of making AI reconstruct it from tokens (p.14-15, p.23).
- Transformative AI: the contrasting term from the author's earlier work; defined only by contrast (p.14).
- Semantic context (z): business rules, invariants, dependencies that determine correct behavior (p.10).
- Semiformal specification: YAML-based declaration of rules and the contexts they apply in (p.18-21).
- Context engine: component that selects applicable rules and detects missing or conflicting requirements (p.20-21).
- Contextual agreement / contextual divergence: two paths where the same operation yields the same or different outcomes under different contexts (p.17-18).
- I(o,c): meaning of operation o under context C (p.18).
- Semantic specification S_C and context transformation: per-context spec and mapping between contexts, with composition rules (p.22-23).
- Hidden-context trap: the failure mode where AI code is consistent with the prompt but violates unstated rules (p.9-10).
- Nested semantic contexts: rules whose meaning depends on other rules (p.13-14).
- Independent verification: checks not produced by the code-generating AI (p.14, p.20-21).
- Self-grading: AI writes code, tests and reports its own success (p.12-13).
- F(x, z) / y = F(x, z): the author's formal model of implementation as a function of prompt and context (p.10-11).
- Mythical 10x developer: the productivity claim the article rejects (p.2, p.5-6).
- Coordination circus: the author's term for coordination overhead in teams and agent fleets (p.11).
- Surgical-team model: Brooks's chief-programmer team, with AI agents as specialists (p.11).
