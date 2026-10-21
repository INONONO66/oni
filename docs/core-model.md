# Core Model — The OS Specification

This document specifies the system that [Design Philosophy](design-philosophy.md) states in one page. Philosophy owns ten nouns; this document owns their fields, formats, and states. Implementation truth lives in [Implementation Status](implementation-status.md); package-level structure in [Architecture](architecture.md). Live delivery order, issue state, and checkpoints belong to [GitHub #459](https://github.com/INONONO66/oni/issues/459), not this contract.

## The System in One Paragraph

Input channels are adapters composed by the product app. Everything they receive enters through one ingress, is routed, and crosses boundaries only through one gate (dispatch) — to the Resident, to the Owner, to a specific Worker session, or out to an external human. Every step lands in the ledger. The Owner converses with the Resident; Workers execute in isolation; the Jester doubts in real time; the Governor fixes structurally after the fact.

## Actors and Authority Profiles

Every subject is an actor with one **authority profile**:

| Profile field | Meaning |
|---|---|
| `TrustTier` | owner / co-owner / manager / collaborator / observer / assigned_worker |
| `Grant` | ceiling on what the actor may do — channel ceilings and egress permissions on one axis |
| `SocialBudget` | contact frequency caps and cooldowns for outreach to this actor |
| `Voice register` | the tone contract for this relationship (formality, emoji, length, warmth) |
| `Blacklist` | absolute block |

Identity is `ActorIdentity` (one canonical subject) with N `Endpoint`s (`channel × externalId`). Humans are not a special case: an external seller, a friend, and the Owner in the physical world are all actors, and all executable work is uniformly a Worker assignment regardless of whether the executor is silicon or human.

## The Gate

### Three verbs, one exception

All communication in the system reduces to three verbs:

1. **`ingress.submit`** — the world enters. Channel adapters normalize everything (Owner messages, external humans, CLI apps, cron) into one schema. Adapters are defined in `packages/channels` and registered in `apps/oni`; adding a channel touches only those composition surfaces.
2. **`dispatch.submit`** — anything crosses a boundary. Delivering to the Resident, escalating to the Owner, messaging an external human or an already-existing agent, targeting a session, or cancelling a Worker uses the same verb with a different target. New Worker allocation is also dispatched, but only the Resident may originate it; a message never allocates work.
3. **`bus.publish`** — an observation is projected. Observation only; the bus never carries commands or performs a durable ledger write.

The target's single exception is the **Worker-local subagent**: an in-process extension of a Worker (function-call communication, no ticket, dies with the parent). The Resident never receives a subagent lane. Parent-tool bounding and nesting denial remain unconditional structural controls — *the gate has one Worker-local exception; policy interception has none.*

### Lanes

The gate routes each request to the cheapest sufficient lane:

| Lane | Used for |
|---|---|
| Built-in | judgment and read-only perception in place |
| Action | one atomic world mutation, no further reasoning |
| Worker | independent execution in an isolated session with its own profile |
| Subagent | context-inheriting parallel reasoning inside the parent |

Target lane availability is actor-specific. The Resident has `built-in`, `action`, and `worker` lanes, but never `subagent`; it alone may originate a new Worker assignment, including when the Owner requests delegation. A Worker has sandbox-local built-ins/actions and may use a subagent only for context-sharing work in the same domain, but it never has the `worker` lane and cannot spawn or commission another Worker. For independent or cross-domain work, a Worker either messages an already-existing agent through explicitly granted, policy-gated dispatch or asks the Resident with `resident.ask`. Neither path transfers allocation authority.

Spawning a Worker for an atomic action is waste; doing multi-step work in the Owner's session is pollution.

### Policy — the cross-cutting hook layer

Policy is not a gate-internal or Worker-only feature: it is the system-wide interception layer (LSM-style) around every actor and boundary. Resident, Worker, Jester, Governor, ingress, dispatch, memory, scheduling, tools, LLM connections, and writeback may each carry policy registrations selected by their actor profile and context. The protocol defines the policy decision and permission vocabulary; interception-point contracts are introduced with their first live consumer (#1246 deleted the consumerless ones). [Implementation Status](implementation-status.md) alone records which points have live consumers.

The rulebook:

1. Compiled-row evaluation orders rows by descending priority, then rule name; the first matched deny or approval requirement stops evaluation. The unconsumed general effect-composition contract (**deny > pending > allow**, safe-deny effects and conflict merging) is withdrawn in #1030, not replaced by this row evaluator.
2. Engine failure: side-effect-boundary (pre) points **fail closed** with an incident event; post points fail open. Silent skips are forbidden.
3. Hot-path discipline: policies are pure and synchronous — **a policy never calls an LLM**. LLM-grade watching is an actor's job: the kernel host invokes the Jester on bounded bus-derived input, and only the host may authorize speech; *policies block, actors assess, the host sends through the gate*.
4. No recursion: a policy returns a verdict and declares effects; it never invokes verbs. Effects are applied by the host.
5. Effects outside a point's `allowedEffects` are rejected at registration, not dropped at runtime.
6. Registering or changing a policy is itself a dispatched action: the Owner freely; the Governor autonomously only in the tightening direction; loosening requires Owner approval; nobody else at all.
7. `pending` is the escalation primitive — it carries timeout, resume, and expiry semantics, isomorphic to Wait.
8. Every decision is recorded with the facts it used. Volume is solved by encoding, never by not recording.
9. Per-point context schemas are enforced; there is no universal context shape.

### Waiting on the world

Existing-agent messaging targets an already allocated actor/session and creates no WorkItem, Worker, executor, or budget. Fire-and-forget records a delivery outcome and creates no Wait. The awaited form opens one durable **Wait** owned by the waiting `session`; process exit releases compute while deterministic correlation, restart, timeout, cancellation, late/ambiguous/duplicate replies, and partial N-of-M resolution remain ledger state. One primitive absorbs PendingAsk, PendingInteraction, WorkItem blockers, and WorkerRun wait states (#215). The normative contract is [Kernel Contract § Wait and existing-agent messaging](kernel-contract.md#wait-and-existing-agent-messaging).

## The Ledger

One append-only history. Target `Ledger.append(event, expectedHead)` is the only durable write: it serializes per owner key with compare-and-append semantics and is awaited before any authorized action. `bus.publish` only projects observations and may remain lossy; it neither appends to the ledger nor enforces record-before-act. [Implementation Status](implementation-status.md) alone records the current durable-write path. Everything else is a view:

| View | What it shows |
|---|---|
| `Session` | an isolation scope of the history, linked by lineage (parent/child/self-loop) |
| `Transcript` | the raw record of a session — exported in agent-greppable form |
| `WorkItem` | the process-table row: acceptance criteria, attempts, executor, evidence, verdict, outcome |
| `CompletionReport` | a Worker's exit format — deliverable plus claims, each referencing evidence |
| `Receipt` | an objection, the evidence shown, and the Owner's acknowledgment of an override |
| `Memory` | a compressed view; on conflict the original wins; Workers receive task-scoped slices only |

Rules: **record maximally, access selectively** — noise is a viewing problem, not a recording problem. Raw transcripts are the Governor's fuel (see below), which is why greppable export is a kernel requirement, not a nice-to-have. `Outcome` (adopted / corrected / redone / ignored) is the Owner's post-hoc signal that calibrates everything downstream.
Each attempt is a distinct execution instance (`attemptId`, per-item `attemptSeq`, nullable lineage `retryOf`), even when retries share content/environment fingerprints. Fingerprints and cache lookup express equivalence; replay identity names an archived record plus its nondeterminism manifest. None is an attempt row key. The normative model is [Kernel Contract § State and the ledger fold](kernel-contract.md#state-and-the-ledger-fold).

## The Roles

### Resident — decides

The default interface. It owns the relationship and global context — not exclusive access. It executes nothing: it answers, delegates, evaluates, and challenges. It has no subagent lane; when judgment turns into independent work, it commissions a Worker through dispatch.

The challenge rules:

1. **Evidence-gated**: an objection must cite the ledger, memory, or an original source. Without a citation it is demoted to a question.
2. **Trigger**: the hard machinery (receipts) engages only when a dispatchable action or a durable decision is at stake; in plain conversation, disagreement is just conversation.
3. **One round, then disagree-and-commit**: if the Owner overrides after seeing the evidence, the receipt is recorded and the action proceeds. No repeated nagging. The difference between "just do it" and "I understand the risk, do it" is not tone — it is the existence of a receipt.
4. **Intensity is learned, not designed**: initial thresholds ride the stakes dial; thereafter the Governor scores override outcomes (when the Resident objected and was overridden — who turned out right?) and calibrates.

### Worker — does

Any delegated executor: internal agents, external CLI apps (Claude Code, OpenCode), external humans, the Owner. Uniform contract: isolated session, task-scoped slice of data and permission, exit through a CompletionReport whose claims carry evidence. Human executors are verification-waived but never recording-waived — a one-line chat report suffices and the Resident writes the ledger entry.

A Worker cannot spawn another Worker or commission new Worker work. A same-domain, context-sharing subagent remains part of its own attempt. If a need has independent footing — especially a different permission profile, verification regime, or domain — the Worker may message an already-existing agent through an explicit, policy-gated grant or use `resident.ask`; neither creates work or transfers allocation authority. The Resident alone decides whether to commission a separate Worker.

Workers start ephemeral and earn persistence through ledger evidence (usage, adoption, correction rate); they are demoted the same way.

### Governor — fixes

A separate low-privilege observer whose target lane stays outside conversations. Two loops: an incident-driven fast loop (mistake → root cause from the situation's raw records → a structural fix aimed at preventing recurrence rather than an apology) and a periodic slow loop (routing hints, calibration, cost accounting).

Design commitments (grounded in Meta-Harness, arXiv:2603.28052 — summary-fed improvement loops are the losing ablation; independent proposers over raw traces win):

- **Reads raw under an access boundary**: the target grants scheduled analysis ambient authority to selectively query raw transcripts and the complete ledger without per-query Owner approval. Its access contract requires every read to be scoped to a recorded analysis query and audited, keeps raw payload outside user-facing sessions, and excludes write, disclosure, egress, access-grant, remediation, or loosening authority. See the [Governor access contract](kernel-contract.md#access-contract).
- **Proposals are evaluated before adoption**: the ledger doubles as a regression corpus — past work items with recorded outcomes are the search set for replay/canary evaluation.
- **Reward tiering**: domains with code-checkable rewards (tests, structural verification) get full search loops; Owner-subjective domains (adopted/ignored signals — sparse, slow) get proposal-only changes. Semantic evaluation stays independent of the adoption signal (Goodhart guard).
- **Write formula**: read-omniscient, write-minimal — tightening is autonomous, loosening needs the Owner, safety constraints are untouchable. Its primary output form is a policy attached to a hook point, which makes improvement observable as a diff.
- `IncidentFingerprint` is an incident index rather than a taxonomy that constrains diagnosis.

### Jester — doubts

A bounded real-time frame-breaker, filling the quadrant "who checks the judge, live". It is a cheap detector whose semantic output is data for a kernel-owned host; the Resident or a Worker does the evidence work.

1. **Exactly seven lenses** — `premise`, `evidence`, `scope_tunnel_vision`, `alternative`, `consistency`, `stakes`, and `audience_tone`. The target enum has no eighth lens or alias; multi-lens input selects one configured primary.
2. **Silence or one challenge** — for one `evaluationId`, target output is `silent` or `{ semanticQuestion, lens, fingerprint }` and excludes target, command, rendered prose, authority verdict, and effect fields.
3. **Zero authority** — the target output and tool surface exclude dispatch, blocking, command writes, and bus delivery. The bus is observation-only.
4. **Deliberately blind** — bounded allowed input includes a philosophy digest, the tail of the decision log, memory-index one-liners, and the current utterance; the Resident's reasoning is excluded.
5. **Silence is the default** — cooldown and mute suppress repeated challenges; getting muted is an independent kill signal.
6. **Host-controlled egress** — the kernel host records the result and independently applies mute/cooldown, policy, stakes, and the notification budget. Authorized outcomes alone proceed to Voice for one-question rendering and then to `dispatch.submit`.
7. **On the ledger like everyone** — evaluation and any verified delivery share the evaluation ID; the Governor later scores mature adjudicated raised challenges under the [normative lifecycle](kernel-contract.md#jester-evaluation-and-authorized-egress).

### Voice — a component, not a role and not a policy

Tone is a property of the audience, not of a component. Owner-facing output may be raw and technical. The target sends human-channel output through Voice, which renders an already-authorized semantic payload in the recipient's per-relationship register. Voice is rendering-only: it preserves Jester silence, question count, lens, and disposition and receives no authorization authority; `dispatch.submit` alone sends. An `egress.render.pre` policy may *oblige* rendering; the Voice component *performs* it — policies decide, components execute.

## External Interaction

The assistant is **openly known**: people understand that messaging the Owner's account or bot reaches the Owner's assistant. There is no impersonation problem — only a response-quality bar.

Flow: external message → ingress resolves the actor → the Resident judges *does this need the Owner?* Pure logistics (confirming a set appointment, sharing known facts) auto-answers in that contact's voice register; money, commitments, emotional weight, or novel requests escalate. What auto-answers is configurable per surface (routing settings ride the existing grant machinery). Every auto-reply is on the ledger — the Owner can always see what was said in their name. Hard rule: asked directly "are you human?", the assistant does not lie.

## Data

**Omnivorous in what it can observe, conservative in what it assumes, scoped in what it exposes.**

- **Capability-first**: connectors mount widely; by default nothing is read until needed, then originals are read directly.
- **Ingestion is earned per domain**: always-on observation starts with small structured domains (calendar, tasks) and expands only where ledger evidence shows proactive intervention actually helped — the same promotion pattern as Workers.
- The Resident never trusts memory over originals; when memory is load-bearing, it re-checks the source.
- Workers receive task-scoped slices only, enforced at `memory.recall.pre`.

## Vocabulary — Three Tiers

**Tier 1 (philosophy, exactly ten):** Actor, Gate, Ledger, Evidence, Stakes, Owner, Resident, Worker, Jester, Governor.

**Tier 2 (specification):** authority profile and its fields (TrustTier, Grant, SocialBudget, voice register, Blacklist), ActorIdentity, Endpoint, Channel, Surface, Gateway (the perimeter seam — Owner addition 2026-08-19, [gateway-design.md](gateway-design.md)), Command, Lane, Subagent, Policy and policy points, Wait, Session, Transcript, WorkItem, CompletionReport, Receipt, Memory, Outcome, Voice, Machine (an attached device — the OS's body; capability = enrollment ∩ offer — Owner addition 2026-08-23, [machines-and-delegation.md](machines-and-delegation.md)), Delegation (the uniform commissioning contract — WorkerAddress, ask/assign, settlement — Owner addition 2026-08-23, [machines-and-delegation.md](machines-and-delegation.md)), Deadline (the shared expiry semantics — inclusive boundary `now >= deadline`, parent min-clamp — Owner addition 2026-08-28, audit-remediation campaign order), Approval (the Owner-consent act — contact promotion and cross-channel endpoint merge ride a deadline-bound request where unanswered reads as refused — Owner addition 2026-09-01), Provisioning (the Owner's standing declarations — Person, ChannelInstance, and the envelope-encrypted Secret vault they reference — Owner addition 2026-09-01, [provisioning-and-providers.md §3](provisioning-and-providers.md)), Journal (the append-only, hash-chained session fact log — a closed set of 12 kinds, 9 core + 3 capability, each `{kind, version, schema}` with one writer — Owner addition, #1252).

**Tier 3 (implementation):** packages and modules — see [Architecture](architecture.md). `IngressEngine`, `DispatchRuntime`, `DispatchHandler`, `ActorRegistry`, `EventProjector`, `Connector` are module names, never concepts.

**Demotions and removals:** ChannelGrant/WorkerGrant/TrustTier/SocialBudget → profile fields; EffectiveAuthority → removed as a concept (it is a computation); WorkerRun → removed (absorbed into WorkItem.attempts); Escalation/PendingAsk/PendingInteraction → absorbed into Wait (#215); InboundMessage/InboundEvent/Envelope/Message → wire formats; SessionOwner/Origin/Purpose → session fields; executorKind → WorkItem field; IncidentFingerprint → Governor index field; MemoryCandidate → ingestion format; ApplicationManifest → app-Worker profile field; ExecutionLane → Lane; System Governor → Governor. The word **"runtime" is banned** as a standalone noun — say agent loop, worker process, or kernel.
