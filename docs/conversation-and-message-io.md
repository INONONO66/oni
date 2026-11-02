# Conversation and message IO

Messages cross one boundary: `send_message({to, message, kind?, reply_to?, deadline_ms?})` and `gateway.ingest(sender, envelope)`. [Gateway Design](gateway-design.md) describes the implementation ownership; [Kernel Contract](kernel-contract.md) is normative. [Implementation Status](implementation-status.md) separates shipped behavior from proposals.

The former Conversation, Lease and engagement lifecycles were removed without replacement. Their design history remains in git, not as an alternate message path.

## Identity (#1569)

Every mounted channel is one `(platform, identity)` instance, `identity` being `bot` or `owner`. The bot identity is the default for reading and answering on every platform. The Owner's own account is a second instance of the same platform: it reads what the Owner can see, so a mention of the Owner or a message to the Owner reaches the Resident even where no bot is present, and it sends only on the Owner's explicit instruction. That instruction is an authenticated fact (the sending turn originates from an Owner-tier prompt and the instance's declared grant allows outbound), never prose: text cannot select the Owner's account. Every send journals the identity it went out under.

Contact identity is identity-independent: actor endpoints are keyed by platform and external id, and the same person is the same actor whether the bot or the Owner instance saw them. A message both instances see is one event. A message this process posted through the Owner instance is not an inbound Owner prompt.

Declared surfaces use the `channel_instance.id` (`channel:<provider>:<slug>`) as their route identity. Several accounts of one platform can coexist. The provider retains bot/Owner identity as metadata and the receiving instance follows the inbound through its binding and reply. Owner provider intake settings still bound what is observed; removing those branches is #1794. Admission itself is the ordered rule table below. Platform coverage and transport history are recorded in Implementation Status.

This withdraws the W2 #1110 identity amendment (only the Owner is public, the agent has no persona, replies go out as the Owner, draft by default). Where a platform forbids automation under a user account, the Owner instance stays read-only and egress degrades to the draft-then-Owner-taps-send path of the Kernel Contract.

## Platform transport

Platform I/O is the agent-messenger SDK: one SDK listener and client per instance, logged in with credentials the vault opened (`login({...})`; the SDK's own credential store is never used). The SDK owns sockets, reconnects, acks and the Web API; the pinned build is the repository's fork, taken at one commit for byte uploads, per-client retry control and authenticated attachment downloads. Discord bot, Discord Owner and Telegram bot SDK clients use `retries: 0`; Slack pins its inner Web API client to one attempt while its SDK retains up to three retries after an explicit 429 refusal. The channels package keeps facts-only normalization, inbound dedupe, delivery custody, rendering and chunking, and the typed `sent | not_sent | unknown` evidence folded from SDK errors. GitHub and signed-webhook ingress are not messengers and stay hand-rolled. Inbound attachments arrive as platform references; with `ONI_MACHINES_INBOX` (or `machines.inbox`) configured, the composition root best-effort stores bot-authenticated Telegram `file_id` and Slack file-ID downloads (`files:read`) and public URLs such as Discord CDN links through its separate media resolver before handoff, then rewrites successful references to `<machine>:<path>`. Authenticated downloads have a 50 MiB cap and 30-second deadline; conversation-scoped hashed keys distinguish messages and exclusive-create writes refuse an existing leaf or symlink. A failed fetch or write keeps the platform reference and warns; Slack Owner and private-URL-only references remain unfetched. Implementation Status records shipped coverage.

Media parts are `image`, `file`, `audio` and `video` (`feat/g1-media-parts`, 2026-10-25). An audio part with `voice` goes out as a voice note where the platform has one (Telegram `sendVoice`; `sendAudio` and `sendVideo` otherwise, `duration` rounded from `durationMs`); Slack and Discord upload audio and video as they upload a file; the KakaoTalk Owner account sends photo, video, audio and file through the fork client and the caption as a following text message. Each platform declares `audioBytes` and `videoBytes` next to its image and file limits, and a part over its limit is refused before any request as the typed `MediaTooLarge`, folded into a `not_sent` receipt whose reason reads `media_too_large <kind> <bytes>><limit>`. Inbound attachments carry `video` as a kind and `durationMs`/`voice` as facts. Nothing in this change feeds audio or video to the model: no transcription, no frame sampling.

## Inbound facts and contact identity

A driver authenticates platform origin and submits facts: event id, physical channel/workspace, external addressees, DM status, reply/thread/ancestor metadata, structured payload, rendered text, and the identity that received it. Only the gateway resolves `(surface, externalId, workspace)` to an actor, derives standing and classifies the addressee as bot, Owner or ambient. Self-reported roles are not authority.

`Ingress.Rule` rows are the sole inbound policy: enabled rows are examined by ascending `position`; every supplied `when` field must match, and an optional `judge` must answer `yes`. `no`, `unknown`, or an unavailable judge falls through. Only the first match runs. Its `outcome.kind` is `drop`, `record`, or `deliver`; drop and record retain a decision receipt without delivery, and deliver carries `deliveryKind: prompt | action`. No match, including an empty table, records the message without preparing a session. Physical request correlation remains independent of rule admission.

The app seeds two protected rows on `channel_add`: non-bot DMs and addressed messages target `conversation` as prompts. Bot instances use `reply: auto`; Owner instances use `reply: draft` and `as: <instance>`. Optional `from` restricts both seeds. Seeds may be moved or disabled, not deleted; re-declaration preserves their order and disabled state. The alarm seed matches instance `alarm` and sends an action to `session:main` with no reply. Channels contains no such defaults.

Conversation keys are `<instance>:channel:<channelId>:thread:<root>` for channel messages, with a top-level message its own root, and `<instance>:dm:<peerId>` for DMs. The first session claiming the key remains its owner. Grouping holds the matched rule within one thread; daily limits refuse that match without trying later rules. `outcome.agent` is opaque to channels; the app resolves it through the #1796 profile store when creating a session. Rule administration is a store API and a correlated WebSocket API (`rule_add/list/move/enable/disable/remove/ledger`), not a provision tool.

A matching rule can admit an unknown sender without creating or promoting a contact. Canonical actor identity remains a separate registry fact. Durable Person declarations and credentials are owned by [Provisioning and Providers](provisioning-and-providers.md).

## Two doors out

A turn answers its originating conversation through the reply door, without a model tool call. The admitted rule freezes `reply: auto | draft | none` and optional `as` on the delivery origin: `auto` selects the receiving or named instance, `draft` keeps the answer for the Owner, and `none` provides no reply route. Later rule edits do not widen an existing delivery. A DM is answered in its chat without a thread; channel replies use the root thread and the original message reference. A button tap answers the message the button was on.

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
