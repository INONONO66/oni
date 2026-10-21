# Kernel Contract

This document carries the normative contract detail behind [Core Model](core-model.md): the guarantee split, authority evaluation, durable session contract, and Governor operating rules. It absorbs ADR-009 through ADR-013, which are retired; git history preserves the originals. Like all design docs, it describes targets — implementation truth lives in [Implementation Status](implementation-status.md). It does not sequence delivery or report live issue state; [epic #930](https://github.com/INONONO66/oni/issues/930) is authoritative for that.

Deletion reconciliation: verified against merged `c4fb7748` on 2026-09-06; policy/ledger rows (`Policy.EffectiveDecision`, ledger-core stream tables) re-verified on `kernel/s1-authority-cut-2` (G002), 2026-09-18 — other normative targets were not re-verified there. The retired task-ticket/completion, built-in memory, blob-store, and dialogue-store contracts are withdrawn, not future kernel obligations. Historical text remains in git history; [SLOP receipts](SLOP.md) distinguish deletion evidence from pending campaign gates. Surviving target sections below do not predeclare unmerged I04-I08/I05 behavior.

## 1. Kernel and Userland

Every behavioral claim in this project is classified as exactly one of:

- **Kernel (structural guarantee)** — enforced by code; cannot be bypassed by any prompt. Violations are impossible, not discouraged.
- **Userland (convention)** — guided by prompts, skills, and actor profiles. May be violated; violations are observable in the ledger and become Governor evidence. Prompts and skills are data files, not code: role presets ship as markdown under `apps/oni/prompts/roles/`, and the Owner's skills and prompt templates are read from configured directories at boot.

These are target guarantees. [Implementation Status](implementation-status.md) alone records which mechanisms are currently wired.

### Lanes and the effect-radius rule

The target gives the Resident `built-in`, `action`, and `worker` lanes but no `subagent` lane; a Worker receives sandbox-local built-ins/actions but no Worker-allocation lane. Lane choice follows how much reasoning and independence execution requires, not size or difficulty. Worker messages, request replies, same-domain subagents, `resident.ask`, and policy grants never transfer allocation authority. The communication vocabulary is fixed: `ingress.submit` enters, `dispatch.submit` crosses a boundary, and `bus.publish` projects observations but is not a command-delivery or durable-ledger-write surface.

What separates a plain tool from dispatch is the **radius of the effect**:

- **Tool = sandbox-local effect.** Confined to the executor's own workspace and run (read/grep in its worktree, run its own tests). Guarded by fail-closed tool permission; legitimately invisible to the rest of the system, because nothing outside the sandbox can be affected.
- **Dispatch = boundary-crossing effect.** Anything touching shared state or other actors: other sessions, humans, schedules, devices, the physical world. Must pass the gate (authorize → route → audit). A living-room light is shared world state; a file in your own worktree is not.

Consequently, mutating custom tools require boundary authorization; read-only tools (search, lookups) may remain directly attached. The dormant runtime integration client was deleted, so this target is not a claim of a shipped integration host. A device driver, like a channel adapter, is registered in `apps/oni` behind a protocol port; core packages stay unchanged.

Subagent vs Worker are different species, not tiers of one thing:

| | Subagent | Worker |
|---|---|---|
| OS analogue | thread | process |
| Context | selectively inherits the parent's | none inherited — task scope only |
| Identity | none — another angle on the parent's problem | own profile (prompt / tools / model / credentials) |
| Lifecycle | dies with the parent | durable child session — survives runtime release and resumes |
| Ledger | no ticket — part of the parent's work | normal session row with `parentId`, role, tree, revision, and activation fence |
| Verification | exempt — intermediate reasoning the parent digests | gated — an independent deliverable |

Target coordination contract: a subagent is a same-domain, context-sharing extension of a Worker, bounded to the parent grant. The Resident profile receives no subagent lane, and the Worker profile receives no Worker-allocation lane. When a Worker discovers work with independent footing — especially a different domain, permission profile, or verification regime — the target permits either an explicit policy-gated message to an already-existing agent or `resident.ask`; the Resident decides whether to commission a separate Worker. Neither coordination path creates another session, Worker, executor, or budget.

**Target Peek budget.** A Resident per-turn tool-call budget separates light perception from execution. Work that remains unresolved after that budget moves beyond judgment scope, so the target next step is a bounded action or Resident-origin Worker commission rather than a subagent.

### Target boot contract

Promises survive power loss:

1. Due schedules re-enter through unified ingress without a separate scheduling authority.
2. A reply arriving after restart wakes exactly the work or session that was waiting without allocating a replacement Worker.
3. Interrupted attempts remain identifiable and resumable after boot recovery.

### Installed applications — the connector contract

CLI coding agents (Claude Code, Codex, OpenCode) are installed applications: they bring their own agent loop, tools, and context management. The kernel does not run their reasoning; it does what an OS does for an app — spawn (headless subprocess, prompt as argv), workspace isolation (one task = one git worktree), credential injection, resource limits (timeout, cost ceiling), and exit-status/evidence collection. This is a connector-host target, not a live blob store or task-completion gate.

**Don't manage the inside; observe the boundary.** An installed app runs inside the Owner's local trust boundary; its own permission system, configured by the Owner, governs its internals. Control lives at three wires:

- **In** — dispatch decides what task enters; the credentials layer decides what secrets materialize; the worktree decides where it works.
- **Side (question bridge)** — a headless app needing a decision (permission prompt, clarification) suspends its original durable request action instead of losing the invocation.
- **Out** — the target collects exit status, logs, usage, and tool evidence at the external boundary. Their storage/retention and connector execution are not implemented by the retired task-ticket or blob-store domains.

**The connector definition is the public ABI.** The kernel is not a package manager: binaries are installed by the Owner's tooling. Installing an app means installing its connector — a declarative, Zod-validated definition (data, not code): how to detect the binary and its version (`testedVersions` range), how to spawn headless, where its logs live and how to parse them, how the question bridge is materialized, what evidence it can emit, what credentials and capabilities it requires, and its initial routing profile. A third party integrates their agent by writing one file, never touching the kernel.

Install lifecycle: **detect → register → consent → wire → verify.** Consent is the app-store moment ("Claude Code requests: git, network, `ANTHROPIC_API_KEY`. Allow?") — the Owner's one tap sets the app's permission ceiling; from there autonomy grows only through ledger evidence (new apps start with conservative grants and a zero track record). Verify is a smoke test: run one trivial task, confirm exit status and log ingestion — "installed" is itself an evidence-gated claim, not a self-report.

Each installation carries an endpoint profile: task types, default timeout/retry/autonomy, driver capabilities, and an evidence-backed track record per task type, updated by the Governor — the routing table by which work is assigned to installed apps. **Version drift is an incident**: a version outside `testedVersions` triggers re-verification — smoke test passes → provisional allow plus ledger record; fails → app disabled plus Owner alert. Upgrades thereby ride the Governor's incident pipeline for free.

### Extension points (4) and bundle contract

W0.5 (#1184) defines the consumed Effect Layer floor. These are normative
boundaries; [Implementation Status](implementation-status.md) records branch
wiring, and [SLOP](SLOP.md#w05-consumed-layer-floor-1184) keeps residual callback
authority explicit. A bundle has exactly four extension points:

| Extension point | Contract | Source |
| --- | --- | --- |
| Tool catalog and system configuration | Every tool is bundle-owned: a generation's `ToolCatalog` is exactly the composed bundles' tools, so `provision{bundle_disable}` drops a tool from the next generation and a second bundle declaring the same name is the typed `duplicate` compose refusal. Recorded `session.configure` operations `tools.add`, `tools.remove` and `system.blocks.set` select the next generation, never replace an in-flight catalog. | `packages/agent/src/core/ports/ports.ts`, `packages/agent/src/core/session/run.ts`, `apps/oni/src/manifest.ts` |
| Policy rows | Data-only pre/post verdicts are `allow`, `deny`, `require_approval`, `transform` or `obligation`. Named implementations come from the captured bundle Layer, not a callback-registration API. | `packages/agent/src/core/gate/compile.ts`, `packages/agent/src/core/bundle.ts` |
| Observation subscriptions | `ObservationSink.subscribe` observes committed execution; it never decides admission or writes durable truth. Subscriptions belong to their Scope. | `packages/agent/src/core/observation/bus.ts`, `apps/oni/src/composition/generation-layers.ts` |
| Entity mailbox messages | A bundle addresses a session through `send_message` / gateway ingestion and entity-owned mailbox admission at a step boundary, not an injected executor or direct ledger writer. | `apps/oni/src/bundles/messaging/send-message/index.ts`, `apps/oni/src/gateway.ts`, `packages/agent/src/core/session/entity.ts` |

Anything else requires a kernel change. No arbitrary code-callback registration,
middleware registry, custom action writer, or raw ledger/control service is a
fifth extension point. Tool bodies, pure named transformers, observation
subscribers and ordinary Effect callbacks are not banned by this rule.

**Consumed services and Scope ownership.** Effect factories resolve Tags with
`yield*` at acquisition and retain the selected services; parallel plain-option
service APIs are not the floor. The executor consumes `Clock`, `Entropy`,
`ObservationSink` and `SessionLayer`; the dispatcher consumes `ToolCatalog`
(`packages/agent/src/core/loop/executor.ts`, `packages/agent/src/core/loop/tool.ts`).
LLM work consumes `Llm` (`packages/agent/src/core/loop/turn.ts`); app
write consumers receive ledger handles explicitly from the composition plane
(`apps/oni/src/composition/cluster-runtime.ts`).

Resource-owning Layers use scoped acquisition and release: the generation
observation bus is an `Effect.acquireRelease`-scoped PubSub built inside its
generation Layer (#1249), as are bundle-owned subscriptions/files. The composition root's `createAppLedger`
(`apps/oni/src/composition/cluster-runtime.ts`) owns the real storage
open/close. Pure Clock/Entropy values, immutable session
snapshots and definition-only catalogs may use `Layer.succeed`; a synthetic
no-op finalizer is not resource ownership.

`AppLive` is one final `Layer.mergeAll` over already-wired package Layers,
`AppScope`, bundle definitions and generation management
(`apps/oni/src/runtime.ts`). Dependency provision, not merge argument
order, determines resource lifetime. L0-L2 infrastructure is process-owned;
L4 bundle resources, tools, system and policy snapshots are generation-owned;
LLM/tool execution fibers are turn/action-owned. Protocol remains Effect-free:
these tiers describe ownership, not runtime objects in wire schemas. No service
kind is categorically unloadable; a process-scoped service simply has no
session generation in which to be replaced. There is no second mount/unmount
lifecycle owner.

**Definition and composition.** `packages/agent/src/core/bundle.ts` owns
`bundle({ name, requires, provides, layer, tools?, rows?, events? })` and
`compose(seed, bundles)`. Infer a Layer value first, then pass it to `bundle`;
its genuine Tag tuples must exactly match the Layer inputs and outputs.
Definition validation and composition revalidation copy/freeze metadata and
reject duplicate names, provided Tag keys, tool names, row identities and event
identities; invalid namespaces; callable/non-plain row data; kernel collisions;
and unavailable, self or later-only requirements. Composition preserves order:
earlier acquired outputs actually provide later Layers, rather than merely
passing metadata checks beside sibling `mergeAll` inputs. An observer may have
`provides: []` and use a scoped discard Layer.

- Namespace: `[a-z][a-z0-9-]*`; tool: `<ns>__<tool>`; event: `<ns>.<kind>` with a positive version; provided Tag: `@oni/bundle/<ns>/<Service>`; policy reference: `<ns>/<verb>`.
- The acquisition seed is exactly Clock, Entropy, generation-local ObservationSink and immutable ToolCatalog. SessionLayer is assembled after policy contributions, not required during their acquisition.
- `bundlePolicyTag(ns)` supplies the reserved `@oni/bundle/<ns>/Policy` service containing immutable `transformers` and `obligations`. Pure transformer `apply(args, config)` implementations are named; rows store `ref` and optional JSON config (default `null`), never closures. There is no `registerTransformer(callback)`.
- Missing transformer/obligation references fail compilation before execution. Decisions retain ordered `{ruleId, ref}` transforms and singular `ref` only for one transform. A pre-transform preserves `originalArgs` beside committed transformed arguments; dispatch validates and executes those admitted arguments. Approval retains original-input identity and recovery does not reapply a current transformer (`packages/agent/src/core/loop/executor.ts`, `packages/agent/src/core/loop/tool.ts`).
- Bundle modules may not import sibling bundle implementation modules; `script/check-deps.ts` guards that band. W0.5 adds no concrete production bundle.

**Generation LayerMap.** `SessionGeneration.Id` is `{sessionId, generation}`
(`packages/protocol/src/ledger/l0.ts`). The app's
`apps/oni/src/composition/generation-layers.ts` owns a session-keyed map of
retained managers; `makeSessionGenerations` in
`packages/agent/src/core/session/run.ts` owns each manager's numeric entries,
acquired contexts, capture/configure, retirement and close (the
`GenerationRawSlots` Context service in
`packages/agent/src/core/loop/executor.ts` carries only the raw
open/pending/await-settled slots). This is one live owner, not
an unused Layer cache plus controller rebuilds. Boot initializes immutable
role definitions once before ingress/recovery; bundle definitions alone live
in process scope, while selected bundle resources build in generation scopes.

`Snapshot.bundles` records sorted unique membership (historic absence decodes
as `[]`); acquisition follows the validated installed manifest order. New
sessions record installed names, and existing configure operations preserve
them. Bundle rows enter the existing durable policy generation before capture,
not an unrecorded compiler overlay. Installing definitions affects new sessions;
tools still require recorded catalog selection. W0.5 adds no membership setter
or unmount operation (`apps/oni/src/index.ts`,
`apps/oni/src/bundles/core-policy/index.ts`, `createSessionConfiguration` in `packages/agent/src/core/session/run.ts`).

Capture pins one context, policy, catalog, named registry and local observation
bus. Same-session acquisition/configure is serialized; the same Id cannot
silently change snapshot hashes. A candidate activates only after commit;
failed acquisition/commit closes it without selecting it. In-flight work keeps
its old generation, while later turns use the new one; revert records a new
number. Current entries survive hibernation. Closed entries are tombstones
within a process; restart reconstructs committed current or explicitly captured
historical selections from durable facts, never substitutes latest on a miss.
Retirement waits for owning fibers and actual raw/cell settlement or witnessed
physical termination. Interruption/disconnection alone is not that witness;
unsettled shutdown must refuse and retain resources, not fabricate finalizers.
This floor does not claim JavaScript-stack durability or the complete W3 G1
crash contract.

## 2. Authority and External Actors

### Identity

Identity resolution is `(channel, externalId) → ActorIdentity?`. One `ActorIdentity` is a canonical subject with N `Endpoint`s; the same person on Telegram and Discord is two endpoint rows linked to one identity, merged only after explicit verification. Classification is orthogonal axes on the profile, never a single role string:

| Axis | Values |
|---|---|
| `ActorKind` | human / ai_agent / service / resident / internal_worker / system |
| `TrustTier` | owner / co_owner / manager / collaborator / observer / assigned_worker |
| `ActorRelationship` (optional descriptive field) | owner / co_owner / collaborator / observer / contractor / external_agent / worker |

There is no `untrusted` tier and no quarantine. Unrecognized actors have no personal grant; without a matching request correlation or a channel default tier they are blocked. An unregistered endpoint is never auto-promoted to an identity (no earning identity by spam) — promotion requires explicit Owner registration or an Owner-approved Resident proposal. The only transient tier is `assigned_worker`, sourced from a request correlation match. System actors use `ActorKind: system` with namespaced IDs (`system:governor`, `system:cron`, `system:recovery`).

An external agent claiming to act "on behalf of" someone is ignored without signed delegation; it gets its own trust tier.

### The two grant fields

The profile's Grant carries two fields evaluated together (formerly two separate types, now one merged axis):

- **Channel ceiling** — per-surface policy: what any actor may do through this surface. The ceiling has a kind — `trusted_channel` (full access for registered actors, default tier for unregistered), `broadcast_channel` (inbound allowed but treated as evidence-only: data, never instructions), `blocked_channel` (inbound dropped silently except request correlation matches) — refined by an `inboundTreatment` override (`normal | evidence_only | owner_review | block`). **The channel is a ceiling**: even a registered owner in a public channel may be restricted from sensitive operations; personal grant beats channel default but never exceeds the ceiling.
- **Worker egress** — what an executor may do outbound: which existing actors/channels it may contact, whether it may ask the Resident, and any explicitly granted lifecycle action on existing work. Worker egress never includes new Worker creation. A Worker contacting an external actor gets tools limited to result reporting, clarification, and artifact attachment; external responses are data, never instructions; its session is isolated from user sessions. No deleted memory policy point or built-in recall port confers authority.

**Blacklist is absolute** and checked before all other evaluation, inbound and outbound — a Worker cannot contact a blacklisted target; the outbound attempt fails with reason. Entries: `{ kind: actor | endpoint | channel | pattern, value, reason?, expiresAt?, createdBy }`.

**Social budget** bounds what the system spends of the Owner's reputation: per-contact outreach frequency caps, cooldowns, a do-not-contact list, and a per-channel disclosure policy. First contact with a stranger is approval-gated; replies within an existing thread are not. Where a platform forbids automation, egress degrades to owner-mediated send (the system drafts, the Owner taps send) — modeled as just another executor, not an exception.

### The gate's authority evaluation

Not a stored value — a computation performed per request, intersecting five dimensions:

```
allow = NOT blacklisted
      ∩ channel ceiling
      ∩ (personal grant || channel default grant)
      ∩ session ownership grant
      ∩ original-request scope (allowedActions)
```

Any dimension missing → deny. Authority comes from verified identity and grants, never from string matching or message content — privilege cannot be escalated through prompt text.

### Inbound routing precedence

Fixed evaluation order for every inbound message:

1. **Blacklist** — match → silent drop, audit record only.
2. **Request correlation** — correlation match routes to the original action's session before surface routing; the kernel decides whether the authenticated answer may continue it.
3. **Channel allowed?** — not allowed → block.
4. **Actor identification** — registered → personal grant; unregistered → channel default tier; neither → block.

Ingress uses `gateway.ingest(sender, envelope)`. Physical reply matching supplies `requestContext` with the original action and allowed response; it does not settle a second lifecycle. The kernel admits normalized answers under the receiving session's fence, and ledger commits the request decision and its receiving input together. Surface identity and action-derived correlation remain different read questions: the default session is not a substitute for an explicit outstanding request. Late or refused answers never become fresh conversational prompts.

### Durable session identity and runtime ownership

Every native Resident or worker is a normal durable session row. The row carries
`id`, nullable `parentId`, role (`resident | worker`), state, revision,
generation pointers, and the current activation fence. A worker row points to
the session that commissioned it and owns an independent revision and entity
activation; no separate task-ticket domain or synthetic `delegation-*` session
identity is required.

`Session` is the sole live consumer surface, keyed by `sessionId` and hosted by
an `effect/cluster` `SingleRunner`. Durable existence is independent of an
activation: each session owns one fresh-schema SQLite file, while one catalog
SQLite file owns cross-session facts and cluster coordination. The old database
layout is not read or migrated. Activation opens the session file, rotates its
fence exactly once, and releases the handle on passivation. Mailbox delivery is
strict FIFO composed with `decideSessionAdmission`; a newly activated entity
drains the complete admitted backlog before becoming idle.

Before runner entry the activation fence commits a `turn` intent with a
pre-minted result ID and pinned tool/system/policy generation; the same ID seals
one terminal. Interruption detaches a running turn only at the entity boundary,
and the entity port's `settle` operation waits for quiescence. Startup resumes
intent-without-terminal turns from their last completed boundary with a
persisted budget of ten. Authenticated control is available before waiting for
recovered Owner consent; recovery stays owned by app shutdown.

### DeliverAt timers and monitor baseline

Retry schedules, request deadlines, watch occurrences, and watch timeouts are
entity messages scheduled through `DeliverAt`, not rows in a second durable
plane. The durable action chain is the guard: delivery re-reads current state
and becomes a no-op when its schedule was cancelled, superseded, already
committed, or fenced by a newer activation. Persist-before-send and residual
delay on restart preserve the existing retry and deadline semantics.

The app worker band, not session residency, owns PTY command and filesystem
source handles. Source observations retain stable occurrence identity and the
captured notification budget, then schedule an entity delivery. The entity
decides admission and commits the resulting prompt and occurrence evidence in
its session transaction. Recurring matches remain armed; explicit rearm resets
epoch budget and dedupe, cancellation is terminal, and persistent source
recovery does not replay a live-stream gap.

[Implementation Status](implementation-status.md) distinguishes branch evidence
from merged delivery. The retained `Alarm.Watch*` and `Delivery.Commit` protocol
names are wire vocabulary only; their live consumer is the entity and they do
not imply separate persistence or worker planes.

### Unified message boundary

`send_message({to, message, kind?, reply_to?, deadline_ms?})` folds onto the gateway send and enters `gateway.ingest(sender, envelope)`; `to.kind` is `session | new_session | contact`, and `kind` defaults to `prompt`. Session identity is authenticated separately from model input. A/B are compiled message pre-policy rows; post policy is obligation-only. The gateway consumes perimeter facts and L1-projected session facts, and never reads the session store. Session delivery enters the entity mailbox; new child configuration and first prompt share its transaction. Only executed actor delivery has an accepted/rejected/unknown receipt. A session commit succeeds or throws.

Two doors leave a session (#1569). The reply door answers the conversation a turn came from, automatically and as the bot identity: the person who wrote in on a channel is owed the turn's result there, and the model never calls a tool for it — the app enters the result as an origin-targeted gateway send naming the delivered prompt, the gateway folds the conversation from that prompt's recorded origin and admits it on its own binding (the sender owns the ingress surface key), with no grant, budget or tool row. The `send_message` tool reaches every other party — another session, a new child, a contact on another channel or conversation, a CLI agent; a letter to the prompting conversation itself is refused as `same_conversation`. The Owner-draft arm for conversations only the Owner instance can reach is a later #1569 PR, recorded in Implementation Status. The bot identity is the default on every platform; the Owner's own account sends only on the Owner's explicit, authenticated instruction, never by default. The only implicit obligation beyond the reply door is a child's terminal reaching its parent's mailbox. Physical adapters report facts, not hopes: a send is `sent` (platform receipt), `not_sent` (typed refusal, preflight failure, or proof the connection was never established) or `unknown` (lost ACK, reset, timeout, partial or malformed receipt). Only `not_sent` permits another physical attempt under the same idempotency key; `sent` and `unknown` keep custody. The kernel receipt vocabulary `accepted | rejected | unknown` is a translation of that evidence at one boundary. A surface that receives an event it does not open records a typed `unsupported_event` refusal rather than dropping it silently.

A child seals its terminal and a source-owned outbound obligation atomically, without changing the parent. The recorded bytes traverse gateway admission, the idempotent entity mailbox, and the receiving executor. Only a verified destination receipt permits the source acknowledgement; retries never reseal the child or repeat the receiving invocation. Process response maps correlate physical replies only. Mandatory terminal mail answers the original request under its existing deadline/CAS, never a new request. Native child admission commits the original request, deadline schedule, child configuration and first mailbox item together.

Table A's egress fact reads the authenticated peer's declared social budget and the destination session's current debit window without charging ingress. A missing peer entry is inapplicable to inbound traffic (unlike cold outbound outreach, where a reachable target with no active budget takes the Owner's consent on the `send_message` invocation, bound to the Person row — the compiled `message.resident.approval_required` row denies it without — and a consented send is admitted once with no debit; #1569 lane 8); a correlated request answer retains the reply exemption. Explicit do-not-contact, allowance, quiet-hour, cooldown and window/class restrictions select the existing compiled denial row. Correlation consumes the ordered immediate-to-root reply chain before broader thread/token/conversation evidence; multiple matches at the winning level remain ambiguous. Socket pre-admission refusal is an error frame, never an accepted receipt. Current implementation gaps are recorded in Implementation Status, not silently weakened here.

### Waiting and existing-agent messaging

Existing-agent messaging requires an explicit grant and targets an allocated actor/session; it conveys no allocation authority. One-way actor delivery records its physical receipt. Awaited sends and native commissions retain waiting on the original durable action, not in an independent waiting or approval store.

- **Original invocation:** `requestId` is the admitted action id. The state pins parsed input, input/effect hashes, tool/system/policy generation, domain revision preconditions, expected responders, physical correlation, allowed actions, deadline, resolution threshold and recorded replies.
- **Authenticated consent:** only authenticated Owner evidence can answer an approval request. Neither model prose nor a gateway trust claim creates consent. Recovery executes the captured invocation, not a model reconstruction; a durable application claim prevents a second effect. Protected Person and endpoint mutations revalidate domain preconditions inside their mutation transaction. Sole-owner checks remain enforced.
- **One winner:** answer, refusal, timeout and cancellation share the original request CAS and one terminal slot: `resolved/answered`, `refused/denied`, `expired/outcome_unknown`, or `cancelled/cancelled`. Equivalent input ids return the original receipt; divergent reuse refuses. Local receipt time is not part of semantic redelivery identity.
- **Late-input policy:** an authenticated answer at or after the deadline records `late_unknown`, expiring a still-open request in the same batch. It never reopens that request or becomes new conversational input. This supersedes the former logical follow-up window.
- **Physical correlation and partial replies:** immediate-to-root reply chains precede thread, token and conversation evidence; ambiguity is never guessed. First, quorum and all policies count distinct expected responders. Arrived replies remain durable when the deadline wins with fewer than the threshold. A supplied platform id can bind a physical receipt without converting `rejected` or `unknown` into `accepted`; transport acceptance is not completion.

The entity plane boots only its fresh catalog and per-session schemas. It does
not inspect, upgrade, or delete databases from the former layout; there are no
compatibility stores or historical writers in the live path. The full
transition ordering is in [Session lifecycle contract](session-lifecycle-contract.md#4-original-request-late-input-and-delivery).

### Jester evaluation and authorized egress

1. The kernel host creates an `evaluationId`, assembles bounded allowed input, and invokes the Jester.
2. The Jester returns only `silent` or `{ semanticQuestion, lens, fingerprint }`. It returns no target, command, rendered prose, authority verdict, or effect. Its lens is exactly one of `premise | evidence | scope_tunnel_vision | alternative | consistency | stakes | audience_tone`.
3. The host records `jester.evaluated`. Silence terminates. For a challenge the host independently applies mute/cooldown, system-wide policy, kernel-observed stakes, and the existing notification budget. A suppressed target result remains silent.
4. For an authorized result, the host passes exactly one semantic question to Voice and then to `dispatch.submit`, record-before-act. The Voice target is rendering-only and preserves the question, lens, disposition, and silence state. Only verified delivery creates `jester.raised` linked to the evaluation and receipt. `bus.publish` observes these records and is not a delivery path.
5. Later records under the same ID may be `answered_with_evidence` with evidence references or `conceded`. A mature adjudicated raised challenge becomes exactly one of `adopted | dismissed`; `muted` is independent Owner control rather than an adjudication.

The required base discrimination set is exactly fourteen fixtures:

| Lens | Positive fixture | Negative fixture |
| --- | --- | --- |
| `premise` | Unsupported premise | Explicit supported premises |
| `evidence` | Claim outruns or conflicts with evidence | Claim bounded by evidence |
| `scope_tunnel_vision` | Material scope omitted | Scope deliberately sufficient |
| `alternative` | Material alternative ignored | Alternatives considered or immaterial |
| `consistency` | Conflicts with a recorded decision | Consistent or explicit supersession |
| `stakes` | Treatment mismatched to observed stakes | Proportional treatment |
| `audience_tone` | Material audience/register mismatch | Appropriate audience/register |

Cross-cutting proofs cover silence, one-question selection for multi-lens input, cooldown, mute, and Voice preservation; they do not add a lens.

### L2 action executor

Every native `prompt`, `turn`, `llm`, and `tool` operation crosses the session-pinned executor, which evaluates the compiled pre bucket before the body runs and the post bucket over the result. Each evaluation commits its own `policy.decision` action, so the durable tree carries the verdict even when nothing else is appended.

Who owns the action record differs by kind. `llm` and `tool` operations are executor-owned: the executor commits an intent before invoking the body and exactly one linked terminal result (`executed`, `blocked_post`, or typed `failed`); a retried model call adds a child `attempt` intent/result pair per attempt. `prompt` and `turn` are decided over records the session machine already owns, the durable mailbox action and the turn envelope, so the executor adds policy decisions and a verdict, never a duplicate intent or result. A pre denial never invokes the body, and for the executor-owned kinds it commits no intent. Post denial records `reverted` when a reverter exists and `irreversible` otherwise. Tool lifecycle observations are projections emitted only after the corresponding intent/result commit; observations are never authority or truth.

Policy authority is the immutable compiled row snapshot pinned by the durable session generation. There is no caller-owned callback policy engine. The target forbids arbitrary callback registration; retained configure-authority and approval-binding seams are explicitly tracked by [SLOP B6](SLOP.md#w05-consumed-layer-floor-1184), not declared deleted here. The Oni boot composition seeds the kernel's mandatory policy rows into durable storage before sessions are materialized; a generation without the mandatory row compiles to a fail-closed snapshot and refuses the turn.

The live policy contract is compiled-row evaluation, not general effect composition. PR #1030 removes the unconsumed `composeEffects` subsystem and its 29 tests without a successor. Its deny/pending/allow composition, safe-effect ceiling on deny, conflict fail-closed merging, effect deduplication and retry-ceiling merging are not active kernel capabilities. Rows retain descending-priority evaluation and stop at the first matched deny or approval requirement; captured budget-obligation limits and channel ceilings are separate, unchanged controls. `Policy.EffectiveDecision` was deleted in G002 (#930); no replacement composition surface was introduced.

## 3. Machine and codemode contract

The machine endpoint is a raw WHERE surface: `MachineHost.list()` and stable
`get(id)` handles expose confined filesystem operations, `exec(cmd, cwd)`, and
`runCode`. Enrollment and daemon offer capabilities intersect fail-closed;
`shell.exec` is distinct from filesystem capabilities and is required for
`exec`. For each exec call the daemon re-resolves the effective export root pathname,
checks cwd containment, and spawns by pathname. Exec does not share the fs
branch's pinned-root invariant: replacing the export-root pathname before a
request changes where exec actually starts (fs keeps reading the root pinned at
attach), and a symlink swap between check and spawn is a bounded, accepted
TOCTOU for now (follow-up #938 in `docs/SLOP.md`). This is
not an OS shell sandbox: commands run as
the daemon user and may exercise that user's other OS authority once started;
Owner grants shell execution knowingly. Codemode consumes these handles through
one `eval` cell runner, with per-tenant interpreter state and no legacy
machines or filesystem tools. Inside a cell a machine handle's methods are the
tool names: `read`, `write`, `ls`, `bash`, `eval`; there is no second
vocabulary for the same operation. The `edit`, `find` and `grep` handle methods
the #949 amendment names are not offered yet: those tools are compositions over
the raw fs endpoints that live in the app tool layer, above codemode, and until
that composition is hoisted a cell reaches them through the `tool.<name>()`
proxies.

`eval.op = run({code, timeout?})` starts code in the session's cell and waits
up to `timeout` seconds (default 15) for it to settle; a cell still running is
answered as `running` with its `cell_id` and its output so far, and keeps
running in the background under a hard ceiling of ten minutes.
`peek({cell_id})` returns the state and the output so far without waiting;
`stop({cell_id})` interrupts the cell and settles it as `cancelled` with the
output it produced — the code never runs again, and the interpreter's state is
discarded like any other cancel. A settled background cell is handed over once:
the `peek` or `stop` that observes the terminal state claims the id synchronously,
so a `peek` whose daemon round trip a `stop` overtook finds it spent, and a
`cell_id` from another session is as unknown as a spent one. Unread settled
cells are retained per facade up to a bound (64); beyond it the oldest is
dropped and its id is spent.

### The sealed tool catalog (#949)

The model door offers exactly eleven tools, in catalog order: `read`, `write`,
`edit`, `ls`, `find`, `grep`, `bash`, `eval`, `monitor`, `send_message`,
`provision`. `completion({prompt, model?, system?, schema?})` is the one
cell-only tool; batching is the cell's `parallel()`. `model` is an id on the
configured provider (never another credential), `system` is system text, and
`schema` is a JSON Schema the answer must satisfy: the host validates the
answer and returns canonical JSON text, or refuses. Names are lowercase
snake_case and follow the file-tool vocabulary; the file is the tool
(`apps/oni/src/bundles/tools/<name>/index.ts`, with `_` written `-` in the directory name
because the repo-wide kebab-case file rule applies; `lint:tools` checks the
correspondence). Every multi-operation tool takes `operation: { op, ... }`
with one discriminator named `op`: `eval.op = run | peek | stop`,
`monitor.op = create | rearm | cancel`,
`provision.op = contact_add | contact_remove | contact_promote | contact_merge |
channel_add | channel_enable | channel_disable | secret_rotate | status`. Declared
ChannelInstance rows are the only channel provisioning owner; channel
credentials in environment variables are refused at config load, and
`provision.channel_add` is the replacement. The
root of every input schema is an object. There is no `approval` tool: Owner
consent for `provision.contact_promote` and `provision.contact_merge` is a
`require_approval` policy row that the executor resolves through the kernel
request path, and no model-callable `decide` exists. Retired names (`list`,
`search`, `run_code`, `llm`, `sendMessage`, `approval`, delegation and
work-item tools) have no aliases; `lint:tools` and the catalog test pin the set.

### Path tools

`read`, `write`, `edit`, `ls`, `find`, and `grep` share one `parseLocus`: bare paths
are local; `machineId:/absolute/path` selects a raw machine handle. Single-letter
machine IDs are supported. Empty IDs, relative remote paths, URL syntax, NUL,
remote parent traversal and the retired virtual root syntax refuse with typed
errors. A local filename containing a colon can be addressed with `./`.

Local filesystem calls use host-user permissions and process cwd, with ordinary
OS symlink semantics; this is not a new local confinement boundary. Read/write
support UTF-8 (default) or canonical base64. Write creates or overwrites one file
and requires existing parents. `read` accepts a one-based `offset`/`limit` line
window for UTF-8 reads. `edit` applies an `edits` array of exact literal
replacements, each matching once and none overlapping; it is sequential but not
atomic against external writers. `ls` lists immediate entries with an optional
`limit`. `find` matches paths relative to the search root against a glob;
`grep` matches UTF-8 content with a regular expression (`literal`,
`ignoreCase`, `glob` name filter, `context` lines, `limit`), reports one-based
lines, and neither traverses symlinks. Binary content requires explicit base64
read; `grep` refuses it.
Remote read windows are assembled into a full value; daemon transport limits
remain distinct from model rendering limits.

`bash({command, timeout?, machine?})` runs local bash in process cwd or the
daemon's raw exec in `/`; remote `/` must be an offered, allowed export.
Directory changes belong inside `command`, never persistent tool state.
`timeout` (seconds) bounds local commands only; the existing raw exec boundary
owns remote deadlines, cancellation limitations and transport byte limits. No
new machine authority check is added to these adapters.

Query category alone derives `safe`; write/edit/bash are sequential mutation or
execution tools. The dispatcher alone caps model rendering at 32,000 UTF-16 code
units, including `\n[truncated: N bytes dropped; M bytes original]`. The marker
counts original and omitted UTF-8 bytes, excluding the marker itself from both
counts. A retained prefix ends at a Unicode code-point boundary and can be one
code unit shorter than the cap rather than splitting a surrogate pair. It drops
overflow, never spills artifacts, and does not cap typed cell results.

## 4. Turn termination, not task satisfaction

The old task-ticket, executor-kind, completion-admission and evidence-gate contracts were withdrawn by #940. There is no replacement ticket/evidence store or completion authority. The kernel records that a turn terminated; the model reading the returned letter judges satisfaction. Generic provider attempts remain children of model actions, not a revived task domain. The gateway/entity-mailbox boundary and original-action request ownership are distinguished in [Implementation Status](implementation-status.md).

### Session L3 execution contract (#937)

The session invokes stateless runAgent; every model step drains the entity mailbox before LLM, after LLM before tools, and after the tool wave, then compacts and evaluates stop policy. Tool waves retain whole-wave preflight/approval, positional results, sequential barriers, and immediate abort release without invalidating the activation fence that controls live raw effects.

One logical `llm` owns ordered attempt children. Only the executor retries and re-admits policy/context; the provider processor performs one attempt. Visible assistant text or a tool call makes a later provider failure terminal. Failed billing remains in attempt evidence and additive usage, while failed partial messages never enter active history. Model/auth resolution, provider classification, retry-after and backoff belong to the agent model plane (`packages/agent/src/model/`); cross-provider fallback resolves its own credentials.

Stop policy is ordered: abort/deadline/budget, terminal text, exact-output repetition, toolless stall, blocked recurrence, live wait, continuation. Thresholds come from captured compiled obligations, not role-specific constants. Progress is committed effect/state change, not tool invocation. The neutral openIntent reader and pending executor approvals prevent premature completion. Only a still-armed action created in the current turn permits `waiting/live_wait`; waiting is not approval suspension or a successful result. Channel correlation is a physical reader over the same original-request state, not a separate lifecycle.

Full assistant/tool snapshots and compaction projections are append-only action results. Terminal resume gets new IDs/latest generation; crash-open recovery uses existing IDs/captured generation. A missing or changed captured executable catalog fails closed rather than substituting the newest definition. No retired task domain, public fact callback, legacy session API or physical history migration is introduced.

## 4. Governor Contract

### Access contract

**Permission formula: read-omniscient, write-minimal.** The target grants scheduled or periodic Governor analysis ambient authority to selectively query raw transcripts and complete ledger records without a per-query or per-analysis Owner grant. Its access contract requires every read to be bounded to a recorded analysis query and audited with the evaluation/loop, query scope, records accessed, time, and outcome; the target host rejects an unscoped read. Raw records stay outside Owner, Resident, Worker, and other user-facing session state; only derived findings may leave through the unchanged authorized result path.

The target read capability excludes policy, Skill, disclosure, remediation, egress, access-grant, write, and loosening authority. Governor writes remain confined to proposals plus the autonomous tightening tier below, and the role stays outside conversations.

**Two loops:**

- **Fast loop (incident-driven, the core).** An incident spawns a root-cause analysis: read the failed session's action evidence, report, raw transcript, ledger timeline, and policy/prompt state *at the time* — classify the cause, prescribe a structural fix so recurrence is impossible. Never an apology: reflection that leaves nothing in the environment repeats the mistake.
- **Slow loop (periodic).** Aggregation over the ledger: routing hints per task type, Resident evaluation-leniency calibration (accepted work the Owner keeps correcting), cost accounting.
**Jester scoring.** The Governor computes Jester precision only over mature, adjudicated `jester.raised` challenges: `B5 = adopted / (adopted + dismissed)`. When `adopted + dismissed = 0`, B5 is `insufficient_data` and no precision-based demotion decision is evaluated. Answers with evidence and concessions are reported as separate signals, not denominator states; muted volume is an independent kill signal.

**Incident lanes:**

| Lane | Triggers |
|---|---|
| Immediate | Owner unplanned intervention; `outcome = redone`; fabricated evidence caught by the gate; canary breach / rollback; 3rd recurrence of a fingerprint |
| Daily batch | attempt failures; `outcome = corrected` (after triage); request expired unanswered; budget hard-stops; cost anomalies |

**Storm collapse**: more than N similar incidents per hour collapse into one storm RCA. `environmental` causes (expired credentials, API outage) route to an ops alert, never a policy change — twenty workers failing on one dead API key is one infrastructure incident. **Triage before RCA** for soft signals: a single `corrected` with no fingerprint match is recorded only; preference-shaped corrections (tone, style) are not policy defects. Their persistence requires a separately designed consumer; no deleted memory-candidate port is implied. Two or more occurrences, or any hard signal, get a full RCA.

**Cause taxonomy → fix mapping:**

| Root cause | Structural fix | Autonomy tier |
|---|---|---|
| Missing know-how | skill addition/update | approval |
| Wrong worker/app/model for the task | routing hint update | autonomous |
| Ambiguous instruction | delegation / acceptance-criteria template improvement | approval |
| Gate didn't catch it | new verification check for that task type | approval (adds cost) |
| Over-broad permission/tool surface | permission tightening | autonomous |
| Unrealistic budget/limits | numeric adjustment | tighten: autonomous / loosen: approval |
| Model limitation | model-tier escalation proposal | approval |
| Environmental | ops alert to Owner | n/a |

**Autonomy boundary — tighten freely, loosen with approval:**

- Autonomous: routing hints; numeric tightening (lower retry caps, lower budgets, narrower tool sets); recording and alerting.
- Approval required: numeric loosening; skill/prompt/template changes; new verification checks; anything expanding any actor's autonomy.
- Never (kernel-enforced floor): blacklist, social-budget ceilings, approval-tier definitions, safety constraints, kernel code, its own write permissions. Proposable, never self-applicable.
- Rate limits: at most one active change per fingerprint; at most M autonomous changes per day; every applied change is journaled with a scope tag.

**Regression ratchet.** Every applied change opens a canary window (the next N tasks of the affected type). Two consecutive same-type failures inside the window → automatic rollback plus an immediate-lane RCA on the change itself — a bad fix is just another incident whose root cause is a recent change, visible because changes are journaled. No separate regression machinery; rollback triggers are simple counting rules, not statistics (a personal system's samples are too small for significance, and a false rollback costs only a restore).

**Fingerprints are an index, never a taxonomy that constrains diagnosis.** `IncidentFingerprint` = cause category × task type × failure mode. Matching against open fingerprints is mandatory before creating a new one. Recurrence ladder: (1) first occurrence → fix proposed/applied; (2) recurrence after the fix → the fix failed: reopen with the prior RCA as input, escalate priority; (3) third occurrence → Owner escalation ("structure is not catching this").

**RCA is a target analysis workflow, not a separate task-ticket contract.** Its report should identify a cause with evidence, propose a falsifiable prevention check, and correlate prior incidents. The Owner's dismissal rate of Governor proposals is a proposed calibration signal, not a currently wired completion store. There is no meta-Governor: if the dismissal rate climbs, fixing the Governor is the Owner's job. One level of recursion, then a person.

**Fabricated evidence is a first-class offense.** A claim whose `evidenceIds` do not resolve — or that read-back contradicts — is not a quality miss but a false report: immediate-lane RCA, permanently recorded on that executor's reliability track record, directly feeding promotion/trust decisions.

**Owner surface.** Proposals arrive as a weekly digest; immediate pings only for rollbacks, fabricated evidence, and third recurrences. Unreviewed proposals expire after N days (state preserved on the fingerprint). Governor spend is capped as a percentage of total system spend.

## 5. Removed built-in memory

#941 deleted the curated file stores, mutation tool, configuration and prompt injection without replacement. The engine/candidate/recall contracts and their old policy points are withdrawn from the active kernel contract. Any later memory or session-search design needs its own approved scope and real consumer; it is not inherited as shipped behavior.

## 6. Determinism, Replay, and Verification

Normative promotion of the 2026-07-09 determinism/verification round (machine-local research original: `foundation-formal.local.md`). The former verifier registry, task-completion admission and archived task replay were removed with their product owners; those historical issue labels are not a live API contract. The surviving principles below are targets, not evidence that a replacement verifier or replay library ships. Framing first, and honestly: this is an **accountability contract, not a correctness proof**. Determinism and accuracy are independent axes (a fully deterministic agent can be reliably wrong), and hallucination detection without an external oracle is impossible — so the contract makes behavior recorded, bounded, and replayable; it does not make outputs true.

### State and the ledger fold

- Internal state is a fold: `S = fold(apply, S₀, L)` over the append-only ledger, partitioned per owner key. `apply` is pure — no clock, no randomness, no live reads, no external calls. Nondeterministic values are captured **as events at write time** and never re-derived on replay.
- **Determinism contract = command-sequence identity**: same inputs must produce the same command sequence, not byte-identical outputs. A replay that attempts a step absent from the ledger fails **loudly** as a nondeterminism error — never silent fold corruption. A static replay-fidelity 1.0 on one golden trace is not accepted as determinism evidence.
- **The gate uses the durable ledger write for record-before-act**: target `Ledger.append(event, expectedHead)` is a per-owner-key serialized compare-and-append with retry on conflict. The gate evaluates against exactly the state it commits on and awaits that commit before acting, closing the check-then-act TOCTOU (two workers passing one budget gate). `bus.publish` is downstream observation/projection, not the append enforcement point. [Implementation Status](implementation-status.md) alone records the current durable-write path.
- **Provider attempts are execution instances, not task tickets.** The session executor records ordered attempt children under a model action; identical model inputs do not imply the same attempt.
- **Equivalence is separate.** `contentFingerprint` covers canonical task input, handler/reducer code, model/config, upstream fingerprints, and dependency-lock identity. `environmentFingerprint` covers relevant runtime/OS/architecture, dependency/tool/policy/verifier/schema versions, provider/model parameters, and redacted configuration identity; secrets contribute only non-reversible version/reference IDs. Both fingerprints may repeat across attempts.
- **Replay/cache vocabulary is re-fileable, not shipped**: the `cacheKey`, `replayKey`, and `nondeterminismManifest` protocol schemas were removed when #493 closed as superseded (Owner no-slop ruling; the deterministic-replay ambition tracks #459). The three laws below bind the re-filed contract, not current wiring — [Implementation Status](implementation-status.md) records the current state.
- **Cache identity is lookup-only.** `cacheKey` is an explicit equivalence lookup derived from the content fingerprint plus a declared deterministic environment subset, never a row key. A hit still creates a new attempt and records `reusedFromAttemptId`.
- **Replay identity is replay-of-record only.** `replayKey` binds an immutable archived range/cassette, environment fingerprint, schema/upcast versions, and the nondeterminism-manifest hash. It is never a cache key.
- **Nondeterminism is manifest data.** `nondeterminismManifest` captures consumed clocks/time zones, random seeds/bytes, model sampling/output/provider request ID, network/tool/device responses, ordering/concurrency choices, generated IDs, environment reads, and human/source inputs. Secrets remain redacted with provenance/version. Missing inputs, unexpected commands, or incompatible environment/upcast fail loudly.
- **Replay has zero live effects.** Recorded outputs substitute for LLM, network, tool, and device calls. A what-if or fork is a separately labeled new attempt, never replay.
- **Event schema evolution**: field renames and semantic re-meanings are forbidden (content-addressing cannot detect them) — a changed meaning is a new event type; shape evolution is upcast-on-read. Enforced as a lint in #467.
- **External effects are not fold state**: they follow intent → idempotent effect (keyed by event id) → confirmed/failed → boot reconciliation. The ledger is authoritative for internal state and eventually-consistent, via reconciliation, for the world.
- **Hash chain stance (2026-07-09 reconciliation)**: the chain stays on the write path; boot verifies the tail only — a broken tail becomes a `chain-break` event plus a Governor incident, never a boot refusal; full-chain verification runs only as the offline restore-drill gate (#226).

### Verification typing

`judge(claim, evidence, S) → { verified | asserted | refuted | inconclusive } × checked_predicate`.

- `verified` always stores **which predicate was checked** ("URL returned 200 and contains the quoted string" — not "the claim is true"). `guaranteed` remains reserved for code-enforced kernel behavior.
- `inconclusive` means an applicable proof attempt could not decide the criterion from the current information; it does not silently pass at low stakes. Verifier crash, malformed output, or capability violation is a separate verification-error fact and also blocks the affected required criterion.
- A claim with no deterministic verifier is typed `asserted` — a first-class trust signal, not a silent pass. A **high-stakes `asserted` raises to the Owner**.
- **Verifiers are deterministic code, sandboxed** (no network, no clock, no subprocess; deny-by-default) — purity by capability, not by naming convention. **No LLM-in-verifier.** Four families, strongest first: executable re-check > citation/quote match > frozen-NLI support > constrained-decoding validity (validity only, never promoted to truth). Every verifier's bench must demonstrate discrimination (returns `refuted` on a known-bad input).
- Language discipline: `replay-of-record` (reconstructing what happened — what this system provides) is never conflated with `deterministic regeneration` (re-running the model to identical outputs — not provided).

### Observability surface

The source of truth for a run is its session action tree and revisioned row; observations are at-most-once notifications, never replay truth. `s.get()` returns the authoritative fence/state/generation/open-turn snapshot and latest-turn tail without activating the entity. `s.watch()` atomically opens a snapshot plus session-filtered subscription; a skipped revision emits a gap and the caller replaces state with `get()`. SQLite remains primary storage, and timelines or exports are derived views. Failure-step attribution by LLM judges is unreliable; durable action results are recorded at the boundary, not reconstructed afterward.

## 7. History

ADR-001 through ADR-008 established the conventions now stated directly in [Architecture](architecture.md) and [Core Model](core-model.md) — package namespacing, Zod-first schemas as the language-agnostic boundary, ring layering, and the durable-session/disposable-runtime split that makes suspension and resume nearly free — along with the persona-era workforce model that evolved into the current role model (Resident / Worker / Jester / Governor as actor profiles, not packages). All are retired; git history preserves the full records.
