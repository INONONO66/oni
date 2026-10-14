# Design Philosophy

## Root Claim

**OpenOmni is a single-Owner Agent OS.** The Owner talks to one shell — the Resident, a judgment partner, not a command prompt — may attach directly to any process (Worker) when useful, and the kernel isolates, observes, and verifies everything that runs.

The OS framing is not a metaphor; it is the structure. Where the metaphor breaks is deliberate: a real shell never talks back. OpenOmni's shell challenges the Owner with evidence. The OS half targets isolation, observation, and evidence-backed verification; the Resident half supplies judgment and dissent. [Implementation Status](implementation-status.md) alone records current enforcement.

## The Kernel — Three Primitives

Everything in the system reduces to three primitives. Every other noun in the documentation is a field, format, or policy of one of these.

**Actor.** Everything that appears in the system — the Owner, the Resident, AI agents, external humans, installed apps, cron — is an actor carrying exactly one authority profile. Trust tier, grants, contact budgets, and voice registers are fields of that profile, not separate concepts. An actor or a channel enters the system through a recorded provisioning operation, never through configuration lying in the environment.

**Gate.** Every action that crosses a boundary passes through one gate (dispatch). Policy is the system-wide interception plane around every actor and boundary — including the Resident — not a Worker subsystem or a gate-only feature. Whether to auto-answer or escalate, whether to object, whether to wait on an external reply, and what voice to render are policy decisions applied at their contracted hook points. The model reaches the world through one sealed door — a fixed tool catalog; a new capability arrives as an operation of an existing tool or as a kernel change, never as a tool bolted on by a prompt.

**Ledger.** Everything that happens is recorded in one append-only history. Sessions, journal rows, policy decisions, delivered inputs, and receipts are the same history at different zoom levels; the bus only projects that history and never stores it. Isolation is the session's job; retrievability is the ledger's. Memory is a compressed view of the ledger, and the original always wins.

## Two Laws and a Dial

**The evidence law: a claim without a receipt did not happen.** A Worker's "done", the Resident's "you contradicted yourself", a memory's "you prefer X", the Governor's "this fix works" — all of them must point at ledger evidence to count. Corollaries: claims without evidence are treated as work not done; *objections* without evidence are treated as questions; a summary is a self-report of a transcript, so improvement loops read raw records, not summaries.

**The separation law: no one judges their own work.** The executor does not grade its own success. The judge does not audit its own consistency. The operator does not improve itself. Every role boundary in the system is this law applied once more.

**The stakes dial.** The harder an action touches reality — money, people, irreversibility, public output — the less runs automatically and the more evidence and Owner involvement is required. Auto-reply thresholds, objection intensity, and permission ceilings are all readings of this one dial, not three separate rule systems.

## Four Roles and Root

Applying the separation law splits the work into four roles. They are not new primitives — all four are just actors with different profiles:

| Role | Verb | Why it is separate |
|---|---|---|
| **Worker** | does | execution split from judgment |
| **Resident** | decides | the seat of judgment; executes nothing |
| **Jester** | doubts | the judge must also be checked — live, cheaply |
| **Governor** | fixes | operation split from improvement |

The role boundary is authority, not hierarchy. The Resident alone originates new Worker allocations and receives no subagent lane; a Worker may extend itself with a same-domain subagent, contact an already-existing agent when granted, or ask the Resident, but none of those coordination paths allocates work. The Jester target is silence-first and zero-authority: at most one semantic challenge is handed to the kernel host, which alone decides whether Voice and dispatch may speak it. The Governor target is read-omniscient and write-minimal: scheduled analysis may selectively inspect raw records, while its access contract keeps raw payload outside user-facing sessions and excludes loosening or exercise of write authority. Canonical behavior and access mechanics live in [Core Model § The Roles](core-model.md#the-roles) and the [Kernel Contract](kernel-contract.md#jester-evaluation-and-authorized-egress).

**The Owner is root.** Final decisions are always the Owner's. The system must challenge with evidence but can never replace the Owner's decision — and an override is recorded with the evidence that was on the table (a receipt). The Owner may bypass the Resident and work with any actor directly; bypass is an exception to the interface, never to observation. Even the Owner acting in the physical world is just a work item whose executor is the Owner: verification is waived, recording is not.

One consequence worth stating plainly: **hidden work is forbidden; isolated work is required.** Context must not mix (isolation), and work must never disappear (total recall). Raw records are not just for audit — under the [Governor access contract](kernel-contract.md#access-contract), scoped analysis may read them as fuel for the improvement loop without projecting their payload into a user-facing session.

## One Sentence

> Everything is an actor, every action passes one gate, everything lands in one ledger. Claims stand only on evidence, no one judges their own work, and the harder reality is touched, the more the human is involved. Four roles: do, decide, doubt, fix. Root is you.

## Why Not an Existing Agent

OpenClaw-class companions execute when told; Hermes-class companions self-improve through agent-curated memory. OpenOmni is neither's competitor — it is the layer beneath them. Both make excellent Workers *inside* OpenOmni. What neither can be retrofitted into:

1. **Executor and judge share one context there.** "It's done" is a self-report from the same context that did the work. An evidence gate requires a judging context outside the executing session — an architecture, not a prompt.
2. **Self-improvement compounds self-report bias.** An agent grading its own work and writing the grade into its own memory turns bias into operational knowledge. The empirical result behind our Governor design (Meta-Harness, arXiv:2603.28052) shows summary-fed improvement loops are the losing ablation; independent proposers reading raw traces win decisively.
3. **No accounting layer.** The moment agents spend money, message people, and speak in your name, the binding need is not execution but a process table, an audit log, and an authority model over arbitrary actors — humans included.

The honest caveat: these advantages are structural claims, and structure only pays off when stakes are real. The falsifiable version of this section — including the criterion under which we would abandon OpenOmni and adopt an off-the-shelf companion — lives in [Bets and Kill Criteria](bets-and-kill-criteria.md).

## What This Is Not

- **Not a general-purpose agent framework.** Built for one operator; the trade-offs follow from that. The kernel underneath is still reusable: its core packages are independently consumable primitives, product meaning lives only in the app's bundles, and a plugin that needs more than the [four extension points](kernel-contract.md#extension-points-4-and-bundle-contract) is asking for a kernel change, not a harness feature.
- **Not a claim of full autonomy.** Autonomy is earned per domain through ledger evidence and revoked the same way.
- **Not a replacement for the Owner's judgment.** The system executes, verifies, and improves; the Owner directs, decides, and owns values. The boundary moves over time; it never disappears.

## Vocabulary Discipline

The philosophy layer owns exactly ten nouns: Actor, Gate, Ledger, Evidence, Stakes, Owner, Resident, Worker, Jester, Governor. Specification terms (profiles, policy points, work items, receipts, lanes) live in [Core Model](core-model.md); implementation terms (packages, modules) live in [Architecture](architecture.md). The word *guaranteed* is reserved for what the kernel enforces in code — everything prompt-shaped is convention and must be labeled as such.
