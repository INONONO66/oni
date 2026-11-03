# Conversation and message IO

Messages cross one boundary: `send_message({to, message, kind?, reply_to?, deadline_ms?})` and `gateway.ingest(sender, envelope)`. [Gateway Design](gateway-design.md) describes the implementation ownership; [Kernel Contract](kernel-contract.md) is normative. [Implementation Status](implementation-status.md) separates shipped behavior from proposals.

The former Conversation, Lease and engagement lifecycles were removed without replacement. Their design history remains in git, not as an alternate message path.

## Identity (#1569)

Every mounted channel is one `(platform, identity)` instance, `identity` being `bot` or `owner`. The bot identity is the default for reading and answering on every platform. The Owner's own account is a second instance of the same platform: it reads what the Owner can see, so a mention of the Owner or a message to the Owner reaches the Resident even where no bot is present, and it sends only on the Owner's explicit instruction. That instruction is an authenticated fact (the sending turn originates from an Owner-tier prompt and the instance's declared grant allows outbound), never prose: text cannot select the Owner's account. Every send journals the identity it went out under.

Contact identity is identity-independent: actor endpoints are keyed by platform and external id, and the same person is the same actor whether the bot or the Owner instance saw them. A message both instances see is one event. A message this process posted through the Owner instance is not an inbound Owner prompt.

Declared surfaces use the `channel_instance.id` (`channel:<provider>:<slug>`) as their route identity. Several accounts of one platform can coexist. App composition attaches bot/Owner identity before attachment processing, and the receiving instance follows the inbound through its binding and reply. Providers emit observed message facts without admission settings. Admission is the ordered rule table below. Platform coverage and transport history are recorded in Implementation Status.

This withdraws the W2 #1110 identity amendment (only the Owner is public, the agent has no persona, replies go out as the Owner, draft by default). Where a platform forbids automation under a user account, the Owner instance stays read-only and egress degrades to the draft-then-Owner-taps-send path of the Kernel Contract.

## Platform transport

Platform I/O is the agent-messenger SDK: one SDK listener and client per instance, logged in with credentials the vault opened (`login({...})`; the SDK's own credential store is never used). The SDK owns sockets, reconnects, acks and the Web API; the pinned build is the repository's fork, taken at one commit for byte uploads, per-client retry control and authenticated attachment downloads. Discord bot, Discord Owner and Telegram bot SDK clients use `retries: 0`; Slack pins its inner Web API client to one attempt while its SDK retains up to three retries after an explicit 429 refusal. The channels package keeps facts-only normalization, inbound dedupe, delivery custody, rendering and chunking, and the typed `sent | not_sent | unknown` evidence folded from SDK errors. GitHub and signed-webhook ingress are not messengers and stay hand-rolled. Inbound attachments arrive as platform references; with `ONI_MACHINES_INBOX` (or `machines.inbox`) configured, the composition root best-effort stores bot-authenticated Telegram `file_id` and Slack file-ID downloads (`files:read`) and public URLs such as Discord CDN links through its separate media resolver before handoff, then rewrites successful references to `<machine>:<path>`. Authenticated downloads have a 50 MiB cap and 30-second deadline; conversation-scoped hashed keys distinguish messages and exclusive-create writes refuse an existing leaf or symlink. A failed fetch or write keeps the platform reference and warns; Slack Owner and private-URL-only references remain unfetched. Implementation Status records shipped coverage.

Media parts are `image`, `file`, `audio` and `video` (`feat/g1-media-parts`, 2026-10-25). An audio part with `voice` goes out as a voice note where the platform has one (Telegram `sendVoice`; `sendAudio` and `sendVideo` otherwise, `duration` rounded from `durationMs`); Slack and Discord upload audio and video as they upload a file; the KakaoTalk Owner account sends photo, video, audio and file through the fork client and the caption as a following text message. Each platform declares `audioBytes` and `videoBytes` next to its image and file limits, and a part over its limit is refused before any request as the typed `MediaTooLarge`, folded into a `not_sent` receipt whose reason reads `media_too_large <kind> <bytes>><limit>`. Inbound attachments carry `video` as a kind and `durationMs`/`voice` as facts. Nothing in this change feeds audio or video to the model: no transcription, no frame sampling.

## Inbound facts and contact identity

A driver authenticates platform origin and submits facts: event id, physical channel/workspace, external addressees, DM status, reply/thread/ancestor metadata, structured payload, rendered text, and the identity that received it. Only the gateway resolves `(surface, externalId, workspace)` to an actor, derives standing and classifies the addressee as bot, Owner or ambient. Self-reported roles are not authority.

`Ingress.Message` is the single schema used by providers, the router, rule matching and stored groups. Its addressing facts are `account` (the receiving account's platform id), `addressees[]`, `dm`, `author.isBot` and optional `quotes` (the quoted author's platform id). The router derives `addressed` once: a DM, a mention of `account`, a quote of `account`, or an already-bound thread. It also attaches authenticated `from` and `receivedAt`. Provider event labels, display names and caller-supplied derived fields cannot make a message addressed.

Missing transport facts stay absent rather than being guessed. Telegram's account transport exposes a reply id but not its author; Instagram's summary exposes neither mention ids nor a quoted author or bot flag. Slack thread parents, Discord referenced messages, Telegram bot replies and KakaoTalk reply attachments retain the quoted account id when supplied.

`Ingress.Rule` rows are the sole inbound policy: enabled rows are examined by ascending `position`; every supplied `when` field must match, and an optional `judge` must answer `yes`. `no`, `unknown`, or an unavailable judge falls through. Only the first match runs. Its `outcome.kind` is `drop`, `record`, or `deliver`; drop and record retain a decision receipt without delivery, and deliver carries `deliveryKind: prompt | action`. No match, including an empty table, records the message without preparing a session. Physical request correlation remains independent of rule admission.

Channels returns `{ rule, factsUsed, verdict? } | undefined`; it does not write the ingress decision ledger. The app records the matched rule or no-match decision, persists delivery receipts, and enforces replay equality before execution. The protocol keeps typed outcome fields, but channels passes `reply`, `as`, `agent` and `deliveryKind` through without interpreting them. Grouping, daily limits, routing, trust tiers, reply drafting and the Owner budget exemption belong to the app's messaging bundle. Provider account arms expose transport capabilities; A2A card identity and instance-settings validation are supplied by the app.

The app seeds two protected rows on `channel_add`: non-bot DMs and addressed messages target `conversation` as prompts. Bot instances use `reply: auto`; Owner instances use `reply: draft` and `as: <instance>`. Optional `from` restricts both seeds. Seeds may be moved or disabled, not deleted; re-declaration preserves their order and disabled state. The alarm seed matches instance `alarm` and sends a prompt to its conversation, bound to the session that armed it, with no reply. Channels contains no such defaults.

Conversation keys are `<instance>:channel:<channelId>:thread:<root>` for channel messages, with a top-level message its own root, and `<instance>:dm:<peerId>` for DMs. The first session claiming the key remains its owner. Grouping holds the matched rule within one thread; daily limits refuse that match without trying later rules. `outcome.agent` is opaque to channels; the app resolves it through the #1796 profile store when creating a session. Rule administration is a store API and a correlated WebSocket API (`rule_add/list/move/enable/disable/remove/ledger`), not a provision tool.

A matching rule can admit an unknown sender without creating or promoting a contact. Canonical actor identity remains a separate registry fact. Durable Person declarations and credentials are owned by [Provisioning and Providers](provisioning-and-providers.md).

### Settings WebSocket methods

These frames require both the configured WebSocket token and Owner-tier
identity. Each carries `type` and a nonempty `requestId`; replies echo
`requestId`. They do not create a model turn.

| Request type | Additional fields | Success type |
| --- | --- | --- |
| `rule_list` | none | `rule_listed` with `records` |
| `rule_add` | `record` (`Ingress.Rule`, no `seed`; id optional) | `rule_added` with `record` |
| `rule_move` | `id`, nonnegative `position` | `rule_moved` with `record` |
| `rule_enable` | `id` | `rule_enabled` with `record` |
| `rule_disable` | `id` | `rule_disabled` with `record` |
| `rule_remove` | `id` | `rule_removed` with `id` |
| `rule_ledger` | optional `surface`, `decision`, `recordId`, `since`, `until`, `limit` | `rule_ledger_read` with routing `rows` |
| `agent_list` | none | `agent_listed` with `records` |
| `agent_add` | `record` (`Provisioning.Agent`) | `agent_added` with `record` |
| `agent_disable` | `id` | `agent_disabled` with retained `record` |

Refusals use `<request_type>_refused` with typed `reason` and `detail`.
Rule creation stamps `createdBy: owner`; clients cannot create seeds.
Seed rules refuse removal, while built-in `resident` and `child` agent
profiles also refuse disabling. The underscore `agent_*` frames address
profile rows; dotted `agent.session.*` methods address live machine sessions.

Each successful settings write commits one app-owned `store_edit` receipt
in the same catalog transaction as the mutation. Reads and refusals do not
write receipts. This audit table is separate from the routing ledger read
by `rule_ledger`. No provision tools expose these methods; desktop wiring
is separate work.

## Two doors out

A turn answers its originating conversation through the reply door, without a model tool call. The admitted rule freezes `reply: auto | draft | none` and optional `as` on the delivery origin: `auto` selects the receiving or named instance, `draft` keeps the answer for the Owner, and `none` provides no reply route. Later rule edits do not widen an existing delivery. A DM is answered in its chat without a thread; channel replies use the root thread and the original message reference. A button tap answers the message the button was on.

There is no instance-level automatic-reply switch. Typing follows the originating instance only when the recorded rule permits a reply; draft and no-reply deliveries do not pulse. The CLI no longer accepts admission or automatic-reply flags on account declarations.

`send_message` is for every other party: an existing session, a new child session, a CLI agent, or a contact on another channel, person or conversation than the one the work came from. Its `contact` target carries the surface, the conversation and, by explicit instruction, the identity. A letter addressed to the very conversation that prompted the turn is refused before the gateway (`same_conversation`): that conversation is answered by the plain reply. A driver never turns a returned handler value into a platform response: the final assistant answer enters the gateway as an origin-targeted send whose authority is the router's conversation binding, not a grant (shipped by #1569 PR 4; see Implementation Status).

## Delivery

Session mail becomes a prompt at atomic inbox commit and passes the receiving session's prompt pre-policy. New child configuration and first mail share that commit. Session delivery has no external receipt classification.

A letter to a platform reached only through the Owner's account is refused `identity_not_granted` before transport unless sent `as: owner` from an Owner-origin turn (#1600 lane R3); a delivery the platform rejected, or whose outcome is unknown, is the contact outcome on the tool result. Actor sends use existing grants (a Person's `reach`, the Owner's standing grant from `contact_add`; #1569 lane 8), exact endpoint resolution, egress budget (a reachable target with no active budget takes the Owner's consent on the `send_message` invocation, bound to the Person row; `message.resident.approval_required` denies it otherwise) and stable platform idempotency keys. Their executed values distinguish accepted, rejected and unknown. The reply door shares the delivery custody (one admission fact per message id, one physical attempt per key) but neither a grant nor a budget: a reply is never outreach.

WebSocket admission receipts and later message frames are distinct. Rendering and chunking remain provider-owned, after admission.

## Correlation and terminal mail

Explicit reply/message ids, thread ids, token hashes and external conversation ids retain their deterministic Wait precedence. Same-tier ambiguity is refused; structured requested actions remain data for the Wait fold. Physical surface routing is independent of conversation correlation.

A child terminal crosses gateway admission, then atomically appends one parent inbox message preserving final text, terminal kind and original reply binding. Processes transport session ids and committed doorbells; they have no parallel settlement or acknowledgement lifecycle. The parent interprets the returned letter; no task-satisfaction authority is recreated.

Deadlines are durable alarm rows. Answer and timeout compete on one source-action CAS; late replies remain input. Startup expiry is wired. Continuous live alarm dispatch is #947, not a second timer in message IO.

## Approval and remaining proposals

The existing executor consumes typed authenticated approval answers bound to the captured request, input hash and generation. Gateway authentication transports evidence; it does not execute a protected body or invent a policy verdict. Free prose is not approval evidence.

#969 unified the request lifecycle and #949 removed the approval tool: Owner consent is a `require_approval` policy row on `provision.contact_promote`/`contact_merge`. That work did not implement unified lifecycle replacement, broader contact promotion automation, a new negotiation budget, or a new conversation store. Additional rendering/disclosure UX and first-contact autonomy require their own approved policy changes.
