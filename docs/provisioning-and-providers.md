# Provisioning and Providers — Target Contract (Proposal)

Status: proposal, not shipped. `docs/implementation-status.md` remains authoritative
for what exists. This document defines the target contract for (a) moving the
Owner's standing declarations — who people are, which channels exist, what
credentials they use — from environment variables into the ledger database, and
(b) formalizing the channel driver band into a uniform Provider contract.

This document governs how the perimeter is *declared, stored, and mounted*;
message semantics are owned by the kernel architecture.

## 1. Problem

Everything the Owner has decided lives in process environment, parsed once at
boot (`apps/openomni/src/config.ts`):

- **Bot tokens** — `DISCORD_BOT_TOKEN`, `TELEGRAM_BOT_TOKEN`,
  `GITHUB_WEBHOOK_SECRET`/`GITHUB_TOKEN` as raw env strings.
- **People** — `OPENOMNI_ACTORS` as a JSON blob in a single env var, upserted
  into ActorRegistry at boot (`registerActors`).
- **Budgets** — `OPENOMNI_SOCIAL_BUDGETS` as env JSON.
- **Machines** — `OPENOMNI_MACHINES_ENROLLED` as env JSON.

Consequences:

1. **The DB already stores the *consequences* of these decisions** (actor rows,
   channel grants, blacklist) but not the decisions themselves. A restart with
   a mutated env silently rewrites authority with no record of what changed or
   why. This violates the record-before-act spirit: the Owner's provisioning
   act is the one act the ledger cannot see.
2. **One person across platforms has no single declaration.** `OPENOMNI_ACTORS`
   binds one `externalId` per actor and its `channel` enum is a hardcoded
   three-value list. The P3 `endpoint_merge` approval act can bind endpoints at
   runtime, but the Owner cannot *declare* "this person is these five platform
   IDs" anywhere durable.
3. **Secrets are unmanaged.** Tokens sit in env plaintext, appear in `ps e`
   output and shell history, cannot be rotated without a restart, and have no
   redaction contract in telemetry.
4. **Drivers converged by convention, not contract.** discord/github/telegram
   each ship `client / normalizer / surface / types`, but nothing enforces the
   shape; `channels.ts` hand-writes one `if` block per channel with bespoke
   factory signatures; adding Slack means editing the app, the config enum, and
   the profile by hand.
5. **No runtime administration.** Adding a channel, rotating a token, or
   admitting a person requires editing env and restarting the process — the
   Resident cannot do any of it as a recorded act.

## 2. Design principles

- **Provisioning is an act, not an ambient fact.** Every declaration (person,
  channel, credential, budget) is a durable record with `createdBy`, revision,
  and a recorded change history. Boot *reconciles* declared state; it never
  invents it.
- **Declared / derived / secret are three different kinds of rows.** Declared
  state (who, what, with which policy) is readable and diffable. Derived state
  (actor rows materialized from declarations) is rebuildable. Secrets are
  ciphertext referenced by id, never inline in declarations, never in ledger
  event streams.
- **Env becomes seed, not source.** Environment variables remain a one-time
  import path (`openomni init` / first boot) and an override for ephemeral dev
  runs; the DB is the source of truth for standing declarations. The model
  API key is the exception: it stays injection-only (env / token-hub), because
  the host's key custody policy forbids persisting LLM keys on disk.
- **One enforcement layer per invariant** (repo law): tier resolution stays in
  the router; secret redaction lives only in the vault boundary; provider
  lifecycle lives only in the runner.
- **Fail closed.** A declaration that cannot be validated, a secret that cannot
  be decrypted, a provider whose credential schema rejects — that component
  does not mount. Absence of valid config is absence of the component
  (channels.ts already states this law; it generalizes).

## 3. The provisioning model

Three new protocol domains, one ledger store band.

### 3.1 Person (identity manifest)

The Owner's declaration that a human (or agent) exists, at what standing:

```
Person {
  id            "person:<slug>"           // stable, Owner-chosen
  displayName
  kind          Actor.Kind
  trustTier     Actor.TrustTier           // "owner" for the Owner themself
  endpoints     [{ channel, workspace?, externalId }]   // N platform IDs
  revision, createdBy, updatedAt
}
```

- **This is where the Owner is defined.** Exactly one Person row may carry
  `trustTier: "owner"` per installation (enforced at the store, typed error on
  a second). The implicit owner is gone (#931): owner tier is named at exactly
  one call site, the ws loopback bootstrap grant (first-contact path). A named
  channel mounts at the tier its declaration's `grant.defaultTier` states, and
  with no such statement it mounts at the mount tier — `assigned_worker`, the
  least authority the tier vocabulary carries — so mounting a surface grants
  nothing beyond existing.
- **Reconcile at boot:** each Person materializes `ActorRegistry` identity +
  endpoint rows (upsert, same idempotence contract `registerActors` has today).
  Removing an endpoint from a Person removes the endpoint row; deletions are
  reconciled, not leaked (repo law: reconcile before deletion).
- **Relation to P3:** a promoted provisional contact *becomes* a Person row
  (promotion writes the declaration); `endpoint_merge` *edits* a Person's
  endpoint list. Manifest and approval lane are two writers of one store —
  the manifest is for people the Owner already knows, the approval lane for
  people who arrived unknown.

### 3.2 ChannelInstance

The Owner's declaration that a channel exists and how it is mounted:

```
ChannelInstance {
  id            "channel:<provider>:<slug>"   // e.g. channel:telegram:main
  provider      string                        // provider registry key
  identity      "bot" | "owner"               // #1569: which account the instance speaks as (default bot)
  enabled       boolean
  settings      provider-schema-validated     // non-secret knobs (triggers, botUsername, workspace)
  credentialRef "secret:<id>" | absent        // never the secret itself
  grant         { defaultTier?, allowedSenders?, provisionalMint?, outbound? }   // perimeter policy
  revision, createdBy, updatedAt
}
```

- One provider may have multiple instances (two Telegram bots, N Slack
  workspaces) — today's "one channel per kind" assumption dissolves.
- A webhook declaration's credential may name a `url` (#1569 lane 9a): the
  instance is then also a target for `send_message`'s `webhook:<id>`
  contact — the letter POSTed there as a signed JSON body (the shared
  secret `secret` sealed with the declaration, or the vault row behind
  `secretRef`; the inbound side verifies with the same), read from the
  vault at send time, one physical attempt per tool call and never a
  redirect followed; a textual answer is returned on the tool result.
  Naming a url is an outbound destination, so the declaration takes Owner
  consent like an Owner instance or an outbound grant, and a rotation never
  introduces one.
- An A2A peer (#1569 lane 9c) is a `channel:a2a:<id>` declaration whose
  credential carries the shared bearer `token` and, for a peer the Resident
  may write to, its `url` — an outbound destination, so the declaration
  takes Owner consent like a webhook target's, and a rotation never
  introduces one. Every peer is a roster entry of the one door (`POST
  /a2a`, the card at `/.well-known/agent-card.json`), mounted once while
  any peer is declared and reading the roster from the store and the vault
  at request time; the peer's tier is its `contact_add` as an actor with
  endpoint `a2a:<id>`, never the door's. `send_message` reaches a peer with
  a url as the `a2a:<id>` contact, honouring its card only within the
  declared url's origin.
- The Owner's own sign-in (#1569 lane 5b): `openomni login <platform>` runs
  the platform's flow through the agent-messenger SDK (Slack QR, Discord
  remote-auth QR, Instagram password with two-factor or challenge code,
  KakaoTalk device passcode) and declares the `owner` instance over the
  Owner's socket as a `channel_add` frame (`Provisioning.ChannelDeclareRequest`);
  the daemon seals the credential into the vault and the CLI keeps nothing
  (the scratch directory the Instagram login lends the SDK for its device
  file is removed before the session is returned); `--print` shows the
  payload for a declaration through the Resident's provision tool instead,
  which records it in the session journal.
- `identity` (#1569) names the account: a `bot` instance mounts as
  `<provider>:bot` and reads inbound under the surface's ingress grant; an
  `owner` instance is the Owner's own account, builds through the provider's
  `owner` arm (its credential is the account session, e.g. Slack's
  `{token xoxc, cookie d}` from the QR login) and mounts as
  `<provider>:owner`. A platform without an owner arm reports
  `identity_unsupported`. `grant.outbound` is the Owner's declaration that
  the Resident may send from that account on an explicit, authenticated
  instruction (`send_message … as: owner` from an Owner-origin turn); without
  it the owner instance mounts no delivery route and such a send is refused
  as `identity_not_granted`. An owner instance's `settings` are its intake
  posture (lane 6, `OwnerPosture`): `intake: mentions_and_dms` (default —
  a DM to the Owner or a mention of the Owner reaches the Resident,
  `receivedBy: owner`; reactions are not intake), `all` (everything the
  account sees), or `none` (send-only). A re-declaration that omits
  `settings` keeps the stored posture. A reading owner instance holds the
  platform's one ingress grant together with the bot instance: the row is
  re-registered at the least tier any current reader declares, carries
  `ownerIntake` while an Owner instance reads (a mention of the registered
  Owner is then addressed to the Resident whichever instance observed it),
  and is revoked with the last reader. Both instances seeing one message
  hand it to routing once (`inboundOnce`). Without `grant.outbound` an owner
  instance mounts neither a delivery nor a typing route. `autoReply` (lane
  7, default false) lets the reply door answer a conversation through this
  account on its own where the platform has no bot instance; without it
  the Resident's answer is refused `message.resident.reply_draft` and stays
  a draft the Owner sends. Instagram and KakaoTalk are Owner-only
  platforms: a bot declaration of them is `identity_unsupported`.
- The `grant` block is the Owner's per-instance perimeter policy: boot threads
  `grant.defaultTier` into the surface's ChannelGrant row through the channel
  supervisor (`DesiredChannelRow.defaultTier` → `registerTrustedChannelGrant`).
  A declaration without a tier mounts at `assigned_worker`; raising a surface
  is always an explicit declaration, never app code (#931).
- `enabled: false` unmounts the stage (dispose path already exists in the
  channel profile composition) without deleting the declaration.

### 3.3 Secret (vault)

Ciphertext rows in a dedicated table, never in event streams:

```
Secret {
  id            "secret:<slug>"
  ciphertext    envelope-encrypted bytes      // AES-256-GCM under a per-secret DEK
  wrappedDek    DEK wrapped by the KEK
  kekId         which KEK wrapped it          // rotation support
  purpose       "channel_credential" | "webhook_secret" | ...
  createdAt, rotatedAt
}
```

- **Envelope encryption** (standard practice for app-held credentials:
  per-secret data key, wrapped by a key-encryption key held outside the DB —
  see e.g. https://useanima.sh/blog/agent-data-encryption-at-rest and
  https://www.sqliteforum.com/p/sqlite-encryption-and-secure-storage). Whole-DB
  SQLCipher is rejected: the ledger must stay greppable/debuggable and only the
  secret fields are sensitive.
- **KEK source, in priority order:** `OPENOMNI_VAULT_KEY` env (dev / CI), else
  a key file (`~/.openomni/vault.key`, `0600`, created by `openomni init`).
  OS-keychain backends are a later slice behind the same interface. No KEK →
  vault reads fail typed (`vault_locked`) → dependent channels do not mount.
- **Redaction is a vault-boundary law:** plaintext exists only inside the
  provider construction call. Vault reads return values wrapped in a
  non-enumerable holder whose `toString`/`toJSON`/inspect yield `[redacted]`;
  telemetry and ledger payloads never carry plaintext because the type system
  never hands them one.
- **Rotation:** `secret_rotate` writes a new ciphertext revision and re-mounts
  the referencing channel stages; old plaintext is never recoverable through
  the API. Model API keys are explicitly out of vault scope (§2, env-only).

### 3.4 What stays out

- **Blacklist, approvals, delegations** — already DB-native, unchanged.
- **Machine enrollments and social budgets** — same disease, same cure, but
  deferred to keep the first slices reviewable; they migrate onto the same
  declaration pattern in a later phase (§9).

## 4. Provider contract

`packages/channels` grows one registry interface; the four existing drivers
implement it without behavior change.

> #1569: the transport beneath a provider is the agent-messenger SDK — a
> provider's `create()` builds the SDK client and listener and logs in with
> the vault-opened credential through `login({...})`; the SDK's own credential
> store (`~/.config/agent-messenger`, `AGENT_MESSENGER_CONFIG_DIR`) is never
> used, so the vault stays the single secret owner. The contract below is
> unchanged by that; which providers have crossed over is recorded in
> [Implementation Status](implementation-status.md).

```
ChannelProvider {
  id                  "telegram" | "discord" | "github" | "ws" | "slack" | ...
  credentials         zod schema for the secret payload
  settings            zod schema for non-secret instance settings
  ingest              "poll" | "socket" | "webhook"   // webhook: github, linear (#1569 lane 9b, Owner-only), webhook
  capabilities        { deliver: boolean, webhook: boolean, render: Format.Surface,
                        outboundRate?: TokenBucketPolicy }
  preconditions?      operator checklist items provision_status can only report,
                      not verify (Discord gateway intents, Slack app scopes)
  create(instance, credentials, publish) -> ProviderRuntime
  owner?              #1569: the Owner-account arm — { credentials (the account
                      session, never the bot's), preconditions, capabilities
                      { deliver, react, media, typing }, create() } mounting as
                      <id>:owner; absent = `identity: owner` is unsupported
}

ProviderRuntime {
  surface             Channel.Surface        // existing contract, unchanged
  deliveryRoute?      ChannelDeliveryRoute   // iff capabilities.deliver
  webhookHandler?     (Request) -> Response  // iff capabilities.webhook
  start() / stop()                           // lifecycle owned by the runner
}
```

Field-survey grounding (per-platform requirements verified against the
hermes-agent multi-platform gateway, https://github.com/NousResearch/hermes-agent,
https://hermes-agent.nousresearch.com/docs/user-guide/messaging):

- **Credential shapes are genuinely heterogeneous** — the schema-per-provider
  decision is load-bearing, not gold-plating: Telegram is one bot token;
  Discord is one token plus portal-side gateway intents (a precondition, not a
  credential); Slack is *two* tokens (`botToken` xoxb- + `appToken` xapp- for
  Socket Mode); GitHub is `webhookSecret + token? + botUsername?`; Email is
  six fields (IMAP/SMTP hosts+ports, address, password). The vault stores bytes,
  not only strings.
- **Ingest reduces to three modes**: `poll` (telegram default, email),
  `socket` (discord gateway, slack Socket Mode), and `webhook` (github,
  telegram optional). The runner owns all three lifecycles uniformly.
- **Settings core shared across providers**: `homeChannel?` (destination for
  operator notices and scheduled delivery), scoped sender allowances (DM vs
  group are separate lists), and `triggers` extended beyond today's
  `mention | event` with `reaction` (emoji-trigger) and free-response channel
  lists. Everything else is provider-private settings schema.
- **Endpoint keys**: Slack is the first provider where `workspace` in the
  `(channel, workspace, externalId)` endpoint key is mandatory (team id);
  external ids are the platform's stable numeric/snowflake id, never the
  mutable username.

Runner operations (adopted from the same survey):

- **Circuit breaker per instance**: repeated retryable failures trip the
  breaker — the stage is auto-paused (`paused_by_breaker`), an operator notice
  goes to another live instance's `homeChannel`, and resume is manual
  (`channel_enable`); no reconnect thrash during a sustained platform outage.
- **Pause is not unmount**: a paused instance keeps its declaration and drops
  inbound; `provision_status` reports `running | paused | paused_by_breaker`
  with the last error.
- **Outbound pacing**: `capabilities.outboundRate` (telegram ~30/s global,
  discord 5/5s per channel, slack ~1/s per channel) wraps deliveryRoute in a
  token bucket — pre-paced, with the existing 429 retry as the second layer.
- **Confirm-or-redeliver**: the egress ledger already records sends; the
  runner adds redelivery of responses whose platform confirmation never
  landed before a crash, labeled as possible duplicates (honest
  at-least-once), bounded in attempts and freshness.

- **The runner owns lifecycle.** Polling (telegram), gateway WS (discord),
  webhook (github), and server (ws) all reduce to `start/stop` plus the
  existing reconnect/backoff logic each driver already carries; the runner adds
  the one thing none of them have — uniform mount/unmount/remount driven by
  ChannelInstance revisions, so a token rotation or `enabled` flip is a stage
  bounce, not a process restart.
- **Normalization is a stated contract:** every provider's normalizer maps raw
  payload → the existing inbound message shape, covered by golden tests
  (payload fixture → normalized snapshot) per provider. This is codifying what
  the three normalizers already do, not new behavior.
- **Rendering** folds in the existing P0 per-surface renderer/chunking tables
  via `capabilities.render`, removing the surface-id switch that selects them
  today.
- **The band contract is unchanged:** providers stay protocol-only (no ledger,
  no policy); whitelist/blacklist/tier/mint decisions remain router-side. The
  provider registry is data the *app* consumes to build stages —
  `apps/openomni/src/channels.ts` shrinks from one hand-written block per
  channel to one loop over ChannelInstance rows.
- **Slack ships as the contract's proof:** the first provider added after the
  refactor, touching zero app composition code beyond registering the provider.

## 5. Runtime administration

One Resident-only tool, `provision({operation: {op, args}})`, where every op is
a recorded act (#949 folded the former `approval` tool into it; Owner consent is
a `require_approval` policy row resolved by the kernel request path, never a
model-callable decision):

| `provision.op` | Act | Guard |
| --- | --- | --- |
| `contact_add` | upsert Person (identity + endpoint bindings) | tier raises above `collaborator`, and any change to the `owner` Person, suspend the original invocation for authenticated Owner approval; lateral/downward edits are direct |
| `contact_remove` | remove Person, reconcile derived rows | refuses to remove the sole `owner` |
| `contact_promote` | register a provisional contact | `require_approval` policy row; domain-revision CAS at apply |
| `contact_merge` | move an endpoint onto an existing contact | `require_approval` policy row; domain-revision CAS at apply |
| `channel_add` | upsert ChannelInstance (+ optional secret payload → vault write + ref); also reachable as a ws frame from the Owner's own socket (#1569 lane 5b, `channelWire`: the login helper's seal — any other socket is refused `owner_only`, a malformed frame `invalid_record` with its issues, the tool's own refusal verbatim as `refused`) | credential validated against the provider schema (the Owner arm's for `identity: owner`) before the row lands; invalid → typed refusal, nothing mounts; an Owner instance, and any change to its `outbound` grant, suspends the invocation for Owner approval with a domain-revision CAS at apply; a re-declaration keeps the stored identity (#1569) |
| `channel_enable` / `channel_disable` | flip `enabled`, bounce the stage | — |
| `secret_rotate` | new ciphertext revision, remount referencing stages | the payload must satisfy every consumer under its own arm's schema (an Owner instance rotates an account session, never bot tokens) |
| `status` | read-only: declared vs mounted diff, last reconcile errors | — |

Boot reconcile and tool-driven mutation are the same code path: declarations
change → affected stages bounce. There is no second "runtime config" surface.

## 6. Bootstrap (first run)

The chicken-and-egg: tools require an owner-tier session; owner tier requires a
declaration. Resolution — `openomni init` (CLI, local filesystem trust):

1. Creates the vault key file.
2. Imports current env (tokens → vault, `OPENOMNI_ACTORS` → Person rows,
   channel env → ChannelInstance rows) so existing installations migrate with
   one command.
3. Writes the Owner Person row (interactive or flag-driven).

Until an Owner Person exists, the loopback ws bootstrap grant behaves as today
(owner tier on loopback only, named at that one call site in
`apps/openomni/src/gateway.ts` and token-gated off loopback) — the existing
single enforcement layer in `assertWsExposure` is unchanged. No named channel
inherits that tier (#931).

## 7. Explicit non-goals

- Multi-owner installations; `co_owner` tier semantics beyond what exists.
- Remote/HA secret backends (KMS, Vault-the-product); the KEK interface leaves
  the door open.
- Encrypting the ledger event streams themselves.
- Moving the model API key into the vault (host key-custody policy forbids it).
- Slack/group-target *semantics* (P4 of the message-IO doc) — Slack here is
  only a provider-contract proof for 1:1 message flow.

## 8. Adversarial review

- **8.1 Env ghost.** After migration, a stale `DISCORD_BOT_TOKEN` in env must
  not resurrect a disabled channel. Law: once any ChannelInstance rows exist,
  env channel config is ignored (boot logs the shadowed vars). Gate: test —
  disabled instance + env token → no mount.
- **8.2 DB theft.** `storage.db` copied off-host must not yield tokens. Gate:
  vault rows are ciphertext; no plaintext column, no plaintext in any ledger
  event payload (schema-level scan test).
- **8.3 Telemetry leak.** No bus event, log line, or tool result may carry a
  decrypted credential. Gate: redaction-holder type + a test that serializes
  every vault read result and asserts `[redacted]`.
- **8.4 Owner lockout.** Corrupt vault key must not brick the brain. Law:
  vault failure unmounts credentialed channels but never the loopback ws
  surface; `provision_status` reports `vault_locked`. Gate: boot-with-bad-key
  test asserts ws mounts and telegram does not.
- **8.5 Tier escalation via manifest.** A worker or non-owner session calling
  `person_declare` to raise its own tier. Gate: tools are resident-gated
  (existing catalog law) and tier raises route through the approval lane —
  unanswered = refused (P3 machinery, reused).
- **8.6 Owner hijack via endpoint edit.** Adding an attacker's telegram ID to
  the Owner Person would grant owner tier to the attacker. Law: *any* mutation
  of the `owner` Person requires the approval lane, including by the Resident
  in an owner-tier session. Gate: adversarial test.
- **8.7 Rotation race.** Messages in flight during `secret_rotate`. Law: stage
  bounce is stop → swap → start; the surface's existing dedupe absorbs
  redelivery; outbound in-flight completes on the old client. Gate: rotation
  test asserts no dropped inbound and no double delivery.
- **8.8 Second owner.** `person_declare` with `trustTier: "owner"` while an
  owner exists → typed `owner_exists` refusal, never a silent overwrite.

## 9. Phasing

Each phase is one PR, merged before the next; per-PR quality gates and repo
gates as established (P0–P3 discipline).

- **PR-A — Provider contract.** `ChannelProvider`/`ProviderRuntime` in
  `packages/channels`, four existing drivers adapted, `channels.ts` loops the
  registry. Zero behavior change; gate = existing channel suite green
  untouched + golden normalizer tests added.
- **PR-B — Provisioning domain + vault.** Protocol schemas (Person,
  ChannelInstance, Secret), ledger stores + migration, envelope-encrypted
  vault, `openomni init` import, boot reads DB with env-seed fallback
  (§8.1 law). Gate: §8.1/8.2/8.3/8.4 executable.
- **PR-C — Runtime administration.** Resident tools (§5), reconcile-on-mutate
  stage bouncing, approval-lane hooks for tier raises and owner-Person edits.
  Gate: §8.5/8.6/8.7/8.8 executable.
- **PR-D — Slack provider.** Contract proof; golden tests; no app-composition
  edits beyond registration.
- **PR-E (deferred) — machines + budgets onto the same declaration pattern.**

## 10. Open questions for the Owner

1. KEK default: key file under `~/.openomni/` acceptable, or require macOS
   Keychain from day one? (Proposal: key file first, keychain behind the same
   interface later.)
2. Should `channel_declare` accept a raw token through the resident session
   (it would transit the model provider), or vault-write only via CLI/env
   import? (Proposal: CLI-only for secret payloads; the tool takes only
   `credentialRef`.)
3. Does the ws surface become a declared ChannelInstance too, or stay the
   hardcoded bootstrap surface? (Proposal: stays hardcoded until PR-E; it is
   the recovery path and should not depend on the vault.)
