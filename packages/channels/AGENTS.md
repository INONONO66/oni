# packages/channels

2026-10-15, #1569 SDK transport: platform I/O moves to the agent-messenger SDK (`agent-messenger@2.39.0`, exact pin), one provider at a time — Slack first. A provider's `sdk.ts` names the SDK slice it speaks (client + listener interfaces and a construction seam tests fake), `create()` logs in with the vault-opened credential through `login({...})` and never touches the SDK's on-disk credential store, the SDK's inner `@slack/web-api` client is pinned to one physical attempt per idempotency key (`singleAttempt`), and SDK error codes fold into the `sent | not_sent | unknown` evidence (`classifySlackFailure`). Each SDK subpath has exactly one home, the provider's `sdk.ts` (`agent-messenger/slackbot` → `src/provider/slack/sdk.ts`, `test/channel-band-boundary.test.ts`); normalizers, dedupe, custody, translate and the router are unchanged. This scopes the #1248 paragraph below: for an SDK-transported provider the reconnect backoff, pings and hello timeout are the SDK's own ambient timers, bounded by its code rather than the injected clock, and the typed dead-shell guarantee returns with the SDK listener custody wrapper of the Discord PR; until then a fatal post-hello stop on Slack (`disconnect_terminal`, a revoked token on re-open) is a Warn and the row stays mounted until the next reconcile. Discord and Telegram still ride the hand-rolled gateway/poller until their PRs.

2026-10-02, #1248 Effect timing: drivers own no timers and no runner — every delay, retry, reconnect, heartbeat, and poll loop is an Effect program executed through the injected `run: EffectRunner` option (the app binds `runAppEffect`). `src/support/schedule.ts` is the single reconnect policy (exponential 1s→60s via `Schedule.min`, ±20% jitter, `RECONNECT_ATTEMPT_BOUND` 10); `src/support/socket-shell.ts` runs one interruptible retry streak per close (halt `Deferred` + `Effect.raceFirst`; exhaustion = typed dead shell publishing `reconnectFailed`); `src/support/fetch-retry.ts` is `Effect.retry` (≤3 attempts, 429 retry-after respected); uncertain deliveries record `unknown`, never resend, and publish one Owner-visible Warn (`src/support/deliver.ts`). Tests drive `ManagedRuntime(TestClock.layer())` from the package's runner owner (`test/helpers/effect.ts`).

2026-10-01, #1244 typed failures: `ChannelsFailure` is the package-owned carrier for untyped causes (`decodeChannelFailure`); driver and router errors stay `Data.TaggedError` classes in `src/errors.ts`, bare `throw new Error` is zero in `src/`, and handler/websocket frames report failures through typed ports rather than console logging.

2026-09-07, #969 Owner answers: `router/request/owner-answer.ts` accepts only the typed gateway arm with injected `authenticateAnswer` evidence. WebSocket `onRequestAnswer` composes with that same `ingest`; credentials never enter message recording or request actions. Upgrade-token authentication and ordinary text provenance remain separate.

2026-09-07, #969 request cutover: `router/request/` owns physical correlation and authenticated responder matching only. `GatewayRouterPorts.requests` injects kernel `list/open/answer/receipt`; channels has no request store, lifecycle fold, control API, or deadline sweep. Original message action ids identify requests. All/quorum, chain precedence, endpoint/channel pins, driver receipts, grants, budgets, and physical idempotency remain gateway responsibilities. `@openomni/agent` supplies the catalog persistence seams (`requireSubAdapter`, `withStoreTimestamps`, stored actor schemas) for `src/store/` and the kernel/SQLite acceptance-test fixtures.

Gateway band, stage 2 (`@openomni/channels`; drivers and perimeter judgment were consolidated here in #551/#707). This package IS the perimeter gateway of [docs/gateway-design.md](../../docs/gateway-design.md): platform drivers convert raw transport payloads to/from protocol `Channel` contracts, and the router band owns every perimeter judgment — external route resolution (`route.decided` recording), physical request correlation over injected kernel ports, channel/blacklist/actor admission, routed pre-run authority, the surface↔session map claim, and the #215 existing-agent send kernel (with #708 reply-grant instance materialization and the #219 active-egress budget gate). The app brain is reached only through the injected `deliver` port (protocol `Gateway.Deliver`); registration and composition stay in `apps/openomni` (`index.ts` + `channels.ts`): adding a platform = one driver folder here + one registration line there; the new driver gets normal review, but the router's judgment surface needs no re-review because the driver sub-band cannot reach it (S8 banding).

## STRUCTURE

```
src/
├── index.ts          # Package barrel — adapters, WebSocketHandler, router surface
├── types.ts          # PublishPort (injected observation port), ChannelClient, InboundNormalizer
├── websocket.ts      # In-process WebSocket surface (token-gated)
├── authn/            # Perimeter judgment: policy-engine decisions, trigger/webhook/upgrade authn
├── router/           # Gateway router (#707): createGatewayRouter, resolve-route (external arms),
│   │                 #   routing-resolution (route.decided record + replay gate), routing-execution
│   │                 #   (typed request-answer handoff), authority (routed pre-run), actor-resolver,
│   │                 #   raw-fact blacklist matching and channel-grant ranking/default treatment
│   ├── request/      # physical precedence and authenticated responder matcher over injected requests
│   │                 # request state transitions belong to the kernel, never this package
│   └── messaging/    # #215 send kernel: createExistingAgentMessaging, grant evaluation (scope-less + scope-aware
│                     #   arms), #708 reply-grant instance materialization (in-memory by ruling; durable store = #709),
│                     #   #219 social-budget egress gate (pure fold + EgressBudgetStore debits), audit events
├── provider/         # ChannelProvider contract + shipped registry + every shipped driver
│   │                 #   (docs/provisioning-and-providers.md §4): each driver folder exports one
│   │                 #   provider declaring id, ingest mode, credentials/settings zod schemas,
│   │                 #   capabilities (deliver/webhook/render policy), operator preconditions,
│   │                 #   and pure create(); the websocket loopback surface deliberately stays
│   │                 #   outside the registry. Each driver's format.ts is the single source for
│   │                 #   its outbound render policy — the provider declares it, the surface applies it.
│   ├── discord/      # Discord gateway client + surface (mention-trigger by default)
│   ├── telegram/     # Ordered long-poll surface; offset advances only after successful handoff
│   ├── github/       # Webhooks with retryable 5xx failures and delivery-marker comment read-back
│   └── slack/        # Socket Mode through the agent-messenger bot SDK (#1569): sdk.ts names the SDK slice
│                     #   and pins one attempt per key; surface.ts acks every envelope before dispatch,
│                     #   workspace-mandatory TEAM:USER endpoint keys (two tokens: xoxb- bot + xapp- app-level)
└── support/          # Band-local helpers: format renderers/chunking, bounded dedupe, Effect fetch retry,
                      #   shared reconnect schedule + socket reconnect shell (#1248), trigger evaluation
```

## DEPENDENCIES (the band import contract)

Whitelist at stage 2 (2026-10-02 #1246: policy and ledger folded into agent): **{`@openomni/protocol`, `@openomni/agent`}** for `src/` (ipc left the whitelist once no channels source imported it; re-admit only with a real driver consumer). `zod` is additionally admitted package-wide: pure schema validation with no I/O and no authority, required because providers declare their credential/settings schemas in-band (§4). `agent-messenger` (#1569) is admitted per subpath in exactly one file, the provider's `sdk.ts` seam (`agent-messenger/slackbot` → `src/provider/slack/sdk.ts`), so SDK types never reach a surface, the router, authn or the stores except through that seam. Enforced twice:

- `script/check-deps.ts` checks manifest and source imports plus S8 banding. Only `src/router/`, `src/authn/`, and `src/store/` may import `@openomni/agent`; driver files cannot reach router internals. No standalone lifecycle store or master Storage entry is allowed.
- `test/channel-band-boundary.test.ts` — the AST-level scan: every import in `src/**` must be a whitelisted package, a node builtin, or relative; `@openomni/agent` only under the judgment band (`src/router/`, `src/authn/`, `src/store/`). Telemetry is NOT allowed anywhere in `src/**` — observation goes through the injected sink (`PublishPort` for drivers, the router's `sink` port).

No app import from this package: both sides meet in protocol contracts (`Gateway.Deliver`, `Gateway.Send*`) plus injected ports.

## CONTRACT

- Providers are the uniform driver contract: `ChannelProvider.create()` is pure construction (no I/O until `surface.start()`), runtime seams (`deliveryRoute`, `webhookHandler`) must match the declared `capabilities`, the provider's own `credentials`/`settings` schemas ARE the validation layer where credentials and knobs enter the system (one enforcement layer — the app's gates call them, never a parallel table), `capabilities.render` is the surface's actual outbound policy (dialect mapping + chunk limit, single-sourced from the driver's `format.ts`), and `preconditions` is the verbatim operator checklist `provision_status` reports — `test/provider-contract.test.ts` enforces all of it and `test/provider-golden.test.ts` freezes each provider's exact normalized inbound shape.
- Adapters are ingress-agnostic: inbound flows through the injected `onMessage(routingHandler)` (bound to the router's `ingest` by the composition root); observation flows through injected sinks.
- The router is constructed ONCE (`createGatewayRouter({ sink, deliver, onPolicyDecision?, messaging? })`) — no post-construction mutation. `ingest` sanitizes gateway-derived fields off the inbound event at the trust boundary (audit A T2: `activation.durableSessionId`, `meta.channelGrant*`; `inboundTreatment` keeps only the harmless `evidence_only` self-downgrade), records `route.decided` before anything acts (record-before-act, #510 C3), mints/claims the resident surface-session label before deliver (S1: the sessionId is an opaque label; session ROWS are brain domain), and never reads session content. A request-correlated routed reply the kernel rejects appends a correcting `route.not_delivered` fact on `route_correction:<scope>:<id>` before the typed rejection returns, so the ledger never claims a delivery that never happened (#743).
- Wire/persisted vocabulary is byte-frozen: `route.decided` stream ids and decision payloads, `route.not_delivered` corrections, `messaging.sent`/`messaging.denied`, archived legacy rows, surface-key rows, egress-budget debit rows.
- GitHub filtered/unsupported deliveries remain successful 200 responses. A handler throw, comment read-back failure, or authenticated comment POST failure returns 500 and releases the in-memory delivery claim so GitHub can retry. A missing GitHub token is different: `postComment()` publishes a warning and returns normally, so the webhook returns 200 without posting a reply. Outbound comments carry the encoded delivery id in a hidden marker; retries read all comment pages first and do not repost when that marker already exists.
- Telegram consumes each returned batch in `update_id` order. Text-message updates are checkpointed only after the awaited `onMessage` handoff succeeds; a failed handoff leaves that update and every later update eligible for retry. Non-text updates require no handoff and are checkpointed in sequence.
- Normalizers are pure (`InboundNormalizer`); trace ids mint at genuine trace origins only (D11) via protocol's `newTraceId`; surface identity speaks the protocol `Channel.SurfaceKey` codec.

## CONSUMERS

`apps/openomni/src/gateway.ts` (router construction + brain wiring), `channels.ts` (driver registration), and `index.ts` (boot recovery and composition); the brain's `message.send` tool reaches the send kernel only through an injected port (never an import).

## TESTS

`bun test` in this package. `test/channel-band-boundary.test.ts` is the import-contract gate; `test/router/` carries the promoted kernel-routing, request correlation, authority, and messaging suites (including real request-kernel/SQLite acceptance; ordinary routing fixtures use injected ports). Driver tests include GitHub retry/read-back dedupe, Telegram offset-after-handoff behavior, and Slack surface pins over a scripted SDK (ack-before-handoff observed through the dedupe clock, start-on-hello and fail-before-hello, dedupe/forget, DM open before a conversation-less send, workspace-mandatory delivery keys, custody over the SDK's error shapes; Socket Mode reconnect/ping/generation pins are the SDK's own `listener.test.ts`) alongside authn, normalizers, Discord gateway, triggers, and WebSocket coverage. Standalone proof: `cd packages/channels && bun install && bun test && bun run build`.

## Channel stores (formerly packages/ledger channel facts, 2026-10-02 #1246)

`src/store/` owns the perimeter channel-fact stores over the injected catalog handle: `actor/` (identity + endpoint facts, provisional lifecycle, `ActorRegistryRefused` for synchronous refusals), `blacklist/`, `channel-grant/`, `reply-grant/`, `egress/` (counted-window social-budget debits), and `provisioning/` (person/channel declarations + `Vault`). They build on `@openomni/agent` catalog persistence seams and are exported from the package barrel; the app composes them from `@openomni/channels`, never from agent. Stored JSON decodes into validated plain values before domain assembly; tests use real SQLite handles from the agent store helpers.
