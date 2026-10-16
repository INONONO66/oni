# Gateway messaging

The gateway is the single perimeter for cross-session and external messages. This document replaces the retired Deliver/return-value and engagement-machine design. Historical decisions remain in git history. [Kernel Contract](kernel-contract.md) is normative; [Implementation Status](implementation-status.md) records wiring.

## Public boundary

`gateway.ingest(sender, envelope)` has two separately authenticated inputs:

- External sender: `{kind: "external", surface, externalId}` plus `Gateway.IngressFacts`.
- Session sender: `{kind: "session", id}` plus `Gateway.SendMessage`.

Drivers submit event id, physical channel/workspace, addressee external ids, DM status, reply/thread/ancestor metadata, structured payload and rendered text. They cannot submit a tier, admission verdict, session activation, or policy result. The gateway resolves identity and addressee axes from perimeter stores. A structured Wait action is evaluated from payload, not from its rendered text.

The model-visible tool is `send_message({to, message, kind?, reply_to?, deadline_ms?})`. Its target is an existing session, a new child session, or an existing contact. `parent: "me"` binds to the authenticated session. The tool returns `{messageId, target}` without waiting. Actor handles name the actor, not an invented session.

## Ownership

| Owner | Responsibility |
| --- | --- |
| Channel provider | Platform transport through the agent-messenger SDK (#1569: login with vault credentials, the SDK's listener and client), facts-only normalization, rendering, concrete delivery receipt under one physical attempt per idempotency key |
| Channels router | Identity, blacklist/channel/grant facts, deterministic correlation, surface labels, actor send kernel |
| Existing policy compiler/executor | Message pre-admission, approval/transform, action intent/result and post obligations |
| App/L1 | Authenticated session/tree/fence facts, runner configuration and injected inbox port |
| Ledger/L0 | Atomic session configuration plus first inbox, fenced writes, terminal-plus-parent commit, answer/timeout CAS |

The gateway never reads the session store. Session delivery calls the injected inbox commit, not a channel driver. It keeps a physical surface label stable across retries; conversation correlation cannot choose that physical label. A missing root or child is materialized with its first inbox write in one transaction. Failures leave neither a partially created session nor an orphan first prompt.

## Admission and receipts

A and B are message pre-policy rows compiled by the same existing executor:

- A: external identity, effective grant/tier, egress facts, platform event dedupe and reply correlation. Sender tier and bot/owner/ambient addressee are independent dimensions. A channel observer default does not authorize top-level instructions.
- B: authenticated parent/child relationship, fanout/depth bounds, parent deadline, message type and actor-send authority. Default rows deny worker allocation, worker actor sends, child-to-resident interrupt and actor interrupt. Grant preflight uses the existing actor-send kernel; missing grants cannot become an executed actor delivery.

Pre-policy may deny, require approval or transform content. A routing transform requires readmission. Message post-policy cannot deny; an obligation failure retains the committed handle. Committed inbox prompts pass the recipient's prompt pre-policy again.

`IngestResult` is `blocked_pre`, `executed`, or `blocked_post`. Executed session delivery is `{kind: "session"}`: commit succeeds or throws. Only executed actor delivery has `{kind: "actor", value: "accepted" | "rejected" | "unknown"}`. Unknown delivery is never collapsed to rejection. A changed admission or failed durable commit throws rather than manufacturing a receipt.

Final assistant text enters ingest as an origin-targeted send (the reply door, below), not an actor send. A WebSocket `receipt` acknowledges admission; its later `message` carries text and a message id. Neither channel handlers nor typing wrappers write back a returned Resident value.

## Actor egress and the reply door

Actor sends retain the existing sender-target grant, exact endpoint resolution, social budget and stable idempotency-key kernel. The platform owner receives the message id as its idempotency key. Session sends do not invoke that owner.

A delivery leaves through one instance (#1569): the resolved endpoint names the platform, the send names the identity (`bot` unless the letter said `as: owner`), and the route is `<platform>:<identity>` — an identity-less surface (ws, github, webhook) keeps its platform key and is reached as the bot. The Owner's identity is admitted only when the composing app vouches that the sending turn opened on an Owner-tier prompt and an Owner instance of that platform has a mounted (outbound-granted) route; otherwise the send is refused as `identity_not_granted` before transport. Every `messaging.sent` names the identity it went out under. The reply door always leaves as the bot.

The reply to the conversation that prompted a turn is not an actor send and holds no grant (#1569). Its authority is the router's own conversation binding: inbound admission claimed the ingress surface key for the session it routed to, and only the session that owns that key may answer there. The composing app folds the binding from the named prompt's recorded origin; the router verifies ownership and a mounted delivery route before policy, records one budget-free admission fact per message id, and delivers into the channel or thread the person wrote in (a DM directly). The former rule-materialized reply grants, their durable projection and endpoint rebinding rule are gone; the initiator-endpoint facts on `route.decided` keep their byte-frozen names.

## Replies and deadlines

Wait correlation preserves the existing precedence: explicit reply message, thread, token hash, external conversation, then scoped endpoint/channel fallback. Same-level ambiguity is refused. Wait folds retain duplicate, responder, quorum and late-reply checks; a refused fold records a route correction before returning failure.

A child terminal crosses gateway admission before the atomic child-terminal/parent-inbox write. The parent's message retains original reply binding, terminal kind and final text. Its stable identity prevents a duplicate doorbell from creating another letter. Native and process runners share this mechanism; there is no process ACK recovery or separate worker store.

Deadlines are stable alarm rows bound to the source action and captured generation. At the deadline, the shipped alarm owner performs one answer/timeout CAS. The winner changes state; a late reply remains fresh input without changing the winner. Timeout observations follow durable commit. Startup expires due message alarms before session recovery.

**#947 boundary:** scheduling the live due-dispatch callback and monitor/alarm ownership remains #947. This cutover does not introduce a per-message timer, polling loop, or second scheduler. Startup expiry and explicit due dispatch through the alarm owner are tested; continuous live scheduling is not claimed.

## Observations and retained boundaries

Message sent, admitted/rejected, committed, drained, replied and timed_out observations are downstream of authoritative commits. The sink stamps session/trace identity; observation delivery is not command delivery or replay truth.

**#969 boundary:** generic channel Wait lifecycle and approval stores remain with their current owners. The executor's typed authenticated approval answer path remains intact. This cutover removes neither those folds nor their retained archival readers, and introduces no replacement policy, approval or watcher subsystem.
