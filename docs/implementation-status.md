# Implementation Status

## #1353 — compaction four core ports with a plugin-owned policy (PR #1470, base `64ef3f639`)

- Port: `packages/agent/src/core/compaction-ports.ts` declares the four operations the turn loop needs and nothing else (132 formatter-canonical lines, 172 before; the issue's ~70-100 guide is noted as a follow-up). `core/turn.ts` reaches compaction through exactly one `maybeCompact(` call; the old tokens (`applyCompaction`, `prepareCompactionAfterContinue`, `createCompactionSession`, `geometry`, `shouldCompact`, `createSession`, `thresholdTokens`) go 11 → 0 in turn.ts.
- Policy: compaction policy, speculation and tool-output elision defaults move into `packages/agent/src/plugins/compaction/policy.ts`. `CompactionReason = prepare | threshold | yield | overflow` (`prepare` only starts speculation after a tool-call continuation and never executes); `overflow` is recorded as the existing `trigger: "yield"` row value, so no recorded journal byte changes (goldens and conformance snapshots untouched). The plugin imports only `core/api.ts`; `Bun.spawn` in the plugin stays 0.
- Deletions: `packages/agent/src/core/compaction.ts` (144 lines) and `apps/openomni/src/compaction/strategy.ts` (30) are gone; core and `testing/registry.ts` imports of `plugins/compaction` 1 → 0; app `configuredCompaction` 3 → 0. The app `compactionBundle` only makes composition refuse when no summarizer is composed.
- Regression caught by the full agent suite: speculative preparation was torn down before the settle-abort finalizer could grant its start tick; fixed by forking a child scope in `bindCompactionRun` before registering the finalizer (finalizer order unchanged: abort still runs before the child's fibers are torn down).
- Review r1: High 1 — the tool-call continue path called `compact("threshold")` and could execute a compaction where main only prepared; prepare-only semantics restored through the port with a test proving a continue step above threshold writes zero `compaction` rows while end-of-turn still compacts. Medium 5 — M1 the speculative-grace deferral applies to `yield` again (a window yield with a speculative summary in flight defers instead of launching a second summarizer), M2 the yield point is armed from the model window only, M3 `compaction-off.test.ts` now fails the second call as a real context overflow and asserts zero compaction rows: the first turn stops normally and the second settles with the original typed provider failure (a successful second turn is impossible under the no-retry contract with compaction off), M4 `DEFAULT_TOOL_OUTPUT_ELISION` is no longer exported and elision is tested by behavior, M5 this stamp and this section replace the stale `applyCompaction` description. Lows carried as PR comments.
- Verification: packages/agent 1441 pass / 0 fail (217 files), apps/openomni 846 / 0 (117 files); check-types, lint, lint:tools, check-deps, check-import-cycles, check-dead-exports, check-journal-writers, check-written-types and check-comment-residue exit 0; the full local gate (`gate-1353.log`) exits 0 on the reviewed head. Four app bundle-list pins gained the shipped `compaction-summarizer` / `compaction-strategy` bundles (test-only).

## #1457 verified driver facts match automation triggers (epic #1337 follow-up)

On `fix1337/1457-driver-trigger-contract` (2026-10-13, base `e7677bbad`, PR #1461).
Webhook deliveries now emit `event: "webhook"` and the stored `secretRef`
that verified their HMAC. GitHub deliveries emit `event: "github"` and a
`githubEvent` key such as `pull_request.opened`. Both optional facts are
additive protocol fields, preserved by the unified input builder and selected
by the corresponding automation trigger. `Gateway.IngressFacts.event` is now
the same six-value enum as `Ingress.Input.event` (a widening of the wire
domain from message|reaction|mention); the channels-local `automation/facts.ts`
copy of that enum is deleted and the router consumes `Gateway.IngressFacts`
directly. `channelId` still identifies the webhook credential or GitHub
issue/PR, so channel conditions and grouping keep their meaning. Drivers
report facts only; the matcher does not accept `message` as a specialized
event.

Matching is still gated by the perimeter: a verified webhook or GitHub
delivery matches its trigger and produces an action only when the sender
passes `GatewayRouter.ingest`, that is when the kernel route is `route` or the
sender resolves to an identified actor with a trust tier (the
`automationActor` arm; the matched automation then grants the inbound). An
unidentified webhook or GitHub sender is still blocked at the channel ceiling
(`message.external.grant_tier`) with no automation row, and a GitHub bot
author is filtered by `rule/bot-author` before matching.

`packages/channels/test/automation-driver.test.ts` proves both branches
through the real signed drivers and the real router fixture: with an
identified observer endpoint, the webhook (valid HMAC) and GitHub (signed
`pull_request.opened`, `User` sender) deliveries execute with target
`worker`, one `action` commit whose origin is `automation/selected`, a
`route`/`surface_default` routing decision carrying `automation:selected`,
and one router-recorded `matched` ledger row; without the endpoint the same
deliveries return `blocked_pre message.external.grant_tier`, a
`channel_ceiling` block, zero commits and zero automation rows. Both positive
cases fail on the pre-fix matcher or pre-fix drivers.

## #1350 — alarm registry single owner and one chain fold (PR #1467, base `c99bb6d5c`)

- Registry owner: `composeAlarmPurposes` is defined once, in
  `packages/agent/src/plugins/alarm/index.ts`, and reaches the app only through
  `Bundle`; the core `ComposePurposesVerb` definition, its `core/api.ts` and
  `core/index.ts` exports and the compose-time injection are deleted (token
  count 2 → 0 across `packages/agent/src` and `apps/openomni/src`). `plugins/alarm/**`
  imports only `core/api`; core imports nothing from `plugins/`.
- One chain fold: `packages/agent/src/core/alarm-read.ts` `foldAlarmChains`
  walks `historyPage` in 256-row pages over `(afterRevision, throughRevision]`
  and `openAlarmIds` drops reserved purposes and `at: null` retirements. It
  replaces the loop fold inside `core/run.ts` (`sessionStopEvidence`, now typed
  over `Pick<SessionKernel, "row" | "actionById" | "historyPage">`) and the app
  fold in `apps/openomni/src/composition/alarm-plane.ts` (which aliases
  `Core.foldAlarmChains`). Equivalence was reviewer-compared against both
  deleted folds on revision bounds, reserved purposes, `at: null` retirement,
  matching versus superseded stale firings and occurrence identity;
  `packages/agent/test/alarm-read.test.ts` (4 cases) and
  `test/alarm-stop-evidence.test.ts` pin the divergence cases with stub kernels
  built through `SessionHistory.Page.parse` / `LedgerSession.Row.parse`.
- The former manual watch-retirement check is
  `apps/openomni/test/monitor-retire-restart.test.ts` over the real WS/monitor
  path. `script/check-comment-residue.ts` pins lowered for `run.ts` and
  `plugins/alarm/index.ts`; the new `alarm-read.ts` is pinned at 0.
- Review r1: H2 (branch not rebased onto #1349; residue pins stale) and M2
  (comment churn outside moved code; type-erasing test casts) fixed on the
  rebased tip; 6 Lows recorded as PR comments. Stamp:
  `docs/agents-stamps/1350-alarm-registry-owner.md`.

## #1349 — three-line comment rule across packages/agent (PR #1449, base `2c3efdb0a`)

- Scope: `packages/agent/src`, `packages/agent/test`, `packages/agent/bench` plus `script/check-comment-residue.ts` and its test; nothing else (`git diff --name-only 2c3efdb0a..HEAD | grep -vE '^packages/agent/|^script/check-comment-residue'` is empty — this stamp is the lead's tail commit). The rung lands alone, after #1348, because every agent file it touches is also a rebase hazard for the other rungs.
- Rule applied: a comment survives only where it states a non-obvious invariant, a law reference or a why, in at most a few lines; narration of what the next statement does, restated signatures, `#NNNN` issue trails, `─` divider lines and JSDoc blocks over six lines are deleted or rewritten as ≤ 6 why-only lines. Every retained src comment line is ≤ 100 columns (biome `lineWidth`; r1 M3 found 140 over-width lines introduced by the rewrite and they were rewrapped).
- Zero behavior change is verified, not asserted: every edit went through a scratch line-range applier that refuses to write unless the file's TypeScript token stream (comments stripped) is byte-identical afterwards, and the whole-lane acceptance check re-verified all 236 touched agent files token-identical to the base. The src diff has zero non-comment lines (`git diff 2c3efdb0a..HEAD -- packages/agent/src` filtered to code lines = 0). Changed test files ran green behind the shared lock (792 pass / 0 fail across four batches), and the full local gate ran green on the pre-rebase tree (`gate-1349.log`, 13 steps / 11 lanes / patch coverage exit 0); the two rebases were comment-only merges whose CI run is the verification.
- Measured (src, `check-comment-residue --measure`): comment ratio 1426bp (3589 comment / 25168 non-blank lines) → 710bp (1659/23364); issue-number comment lines 156 → 0; `─` dividers 64 → 0; JSDoc blocks over six lines → 0 (core/entity.ts alone went 261 → 83 comment lines, 14 oversized JSDocs → 0). Test tree after: 2523 comment lines / 53606 non-blank (4.71%), issue-number lines 0, dividers 0, JSDoc>6 0.
- Gate: `script/check-comment-residue.ts` now carries a per-file `[issueNumberLines, dividerLines]` pin table over every agent src file, a package comment-ratio ceiling and a JSDoc>6 ceiling of 0, all equal to HEAD actuals (a pin above its actual is itself a violation: shrink only, never grow). The blanket `structuralHeaders` divider exemption is replaced by `durableByteNotes`: an enumerated list of (file, exact marker, reason) entries with a budget of 10, exempt only from the issue count and never from the ratio.
- Rebases: onto `ce36b8296` (#1347 added comments that broke the pins — trimmed to policy, not re-pinned upward: `05bf79c98`) and onto `2c3efdb0a` (#1348 split/moved eight test files — main's code taken verbatim, policy re-applied to the surviving comments), each followed by a shrink-only re-pin commit.
- Review: r1 High 0, Medium 3 — M1 (10 issue-ref/divider lines left in test + bench) removed, M2 (`writerLoop` lost its invariant note: RPC-only enqueue, arrival order, loss-free shutdown redelivery) restored as a 5-line note, M3 (over-width lines) rewrapped; Lows carried as PR comments.

## #1458 desktop ingress ledger winning-prompt link (PR #1460, base `b3d62bbc3`)

The ledger explorer links a `superseded` decision to the winning prompt using
that stored automation row's `target: "session:<id>"`. The automation ledger
returns only automation and group-close decisions; no separate routing row is
required or displayed. A row without a winning session has no prompt link.
The desktop fixture reflects those producer rows; the channels router test pins
that a real ingest stores the superseded row with the winning session target,
and the desktop test renders that row shape through production `LedgerRows`.

## #1456 Owner bootstrap for the shipped desktop connection (epic #1337 follow-up)

On `fix1337/1456-desktop-owner-bootstrap` (PR #1463, 2026-10-13, base `2c3efdb0a`).

- The desktop connects with URL + token and no actor declaration; the upgrade
  mints `connection:<uuid>`. Chat already admits that sender as the Owner from
  one fact (`admitWebSocketOwner`: no registered endpoint and the stored `ws`
  bootstrap grant's `defaultTier` is `owner`). The gateway's automation
  callback used to grant Owner only to tokenless sockets or an already
  registered Owner endpoint, so `automation_add`/`automation_enable` returned
  `require_approval` until chat registered the address, and every reconnect
  minted a new one.
- `packages/channels` exports `webSocketSenderTier(stores, externalId)` (the
  registered identity's tier, else the ws grant's `defaultTier`); chat's
  `admitWebSocketOwner` and the app's automation callback both read it, so one
  rule names the Owner's own connection. The old tokenless branch is gone: the
  same grant covers a tokenless loopback socket, and removing the grant
  (`openomni-resident-ws`) makes both chat and automation fail closed.
- A declared socket keeps whatever its registered identity says (a registered
  collaborator still gets `require_approval`); an unregistered declaration on
  a token-authenticated socket resolves exactly as chat resolves it (the token
  is the Owner credential). Session callers are unchanged.
- Tests (`apps/openomni/test/automation-wire.test.ts`): the fresh token socket
  on plain `/ws` with no pre-registered Owner runs add -> enable -> list twice
  across a reconnect with `createdBy: "owner"` results; the same socket without
  the bootstrap grant is refused `require_approval`.

## #1348 — agent test dedup and bare-throw narrowing (PR #1448, base `18ca03806`)

- Every positive bare `toThrow()` in `packages/agent/test` is narrowed to the class the code actually throws: 41 sites in 19 files → 0 (`rg --pcre2 -n '(?<!not\.)toThrow\(\)' -g '*.ts' packages/agent/test`). Each site was classified by running a scratch probe copy once (deleted afterwards, never committed) rather than guessed; the classification receipt is `lane-1348-throw-probe.txt` under the campaign evidence directory.
- Copied setup is replaced by scoped per-test fixtures under `packages/agent/test/helpers/` (seeded session, alarm budget/recovery, bus, hook, request port, fork seed, store fork, gate builders, request seeds, compaction evidence, disk stores, kernel rows, verdict/authority/model-message clones, tool wave, silent runtime, refused deliver) with teardown on every exit. `helpers/fixtures.test.ts` pins fixture isolation (fresh collectors per test), release on a failing body, child kill → `ESRCH`, and — after r1 M1 — that a released session handle refuses reads, so a leaked release makes the teardown pin fail instead of passing vacuously.
- The two oversized suites are split by responsibility behind shared harness helpers: `session-handle.test.ts` (2155 lines) → `session-handle.test.ts` (admission and turn sealing, 800), `session-handle-ownership.test.ts` (ownership and generations, 708), `session-handle-recovery.test.ts` (crash recovery and observation, 317); `session-lifecycle-conformance.test.ts` (1588) → 764 lines over `helpers/lifecycle-conformance.ts` (886). The largest agent test file is now `executor-recovery.test.ts` at 932 lines; none is over 1,000.
- Measured before/after on the same options (`jscpd --min-lines 5 --min-tokens 50`, agent test tree): 344 files / 140 clones / 1357 duplicated lines (2.38%) → 360 files / 33 clones / 213 duplicated lines (0.374%). Agent lcov line coverage 90.22% (LH 26231 / LF 29074, 281 src files) → 90.79% (LH 28059 / LF 30904, 294 src files): no drop. `.skip`/`.todo`/`.only`: 0. `sleep(`: 1 hit, `helpers/time.ts:19`, the test Clock's own `sleep` implementation present at the base — no new sleep.
- Scope: `packages/agent/test` only, 88 files, +4971/−5309 over 13 commits; test LOC 57733 → 57394; `git diff --name-only 18ca03806..HEAD | grep -v '^packages/agent/test/'` is empty (production code, `packages/channels` and docs untouched; this stamp is the lead's tail commit). One pre-existing failure was observed and left alone: `test/core/execution/tool-output-projection.test.ts` 1 MiB bounded-row case on the pre-#1347 tree (fixed by #1347's row byte cap, not by this PR).
- Review: r1 High 0, Medium 2 — M1 (teardown pin could not fail) fixed in `ab7028617`, M2 (PR body facts) re-measured and re-posted; 12 Lows carried as PR comments. Gate: the local gate ran the package, app and script lanes plus the patch-coverage step with exit 0 (`gate-1348.log`).

## #1428 nine-bundle app layout

The app has eleven bundle directories under `apps/openomni/src/bundles/`: alarms, approval-policy, compaction, core-policy, delegation-policy, hooks-json, messaging, prompt, provision, resident, and tools. These are the nine from the #1428 proposal plus approval-policy and hooks-json, which #1346/#1256 had already landed as bundles; imports, test paths, and tool globs relocated without behavior changes. `script/check-deps.ts` pins the existing sibling-bundle and direct bundle-to-app-module findings by exact import identity; new edges and pin slack fail closed, and #1454 tracks removal of those edges. `script/lint-tools.ts` accepts the nested `bundles/tools/<tool>/index.ts` form while checking the directory against the catalog tool name.

## #1341 app wiring for rule-based ingress automation (epic #1337, rung 4)

On `epic1337/1341-app-wiring` (2026-10-13, base `033258aae`, PR #1446).

- `provision` gains `automation_add`, `automation_remove`, `automation_enable`,
  `automation_disable`, `automation_list` (`src/bundles/provision/automation.ts`,
  schema in `automation-schema.ts`); the gateway exposes the same five as
  one-to-one methods plus read-only `automation_ledger`, the contract #1342's
  desktop editor consumes. Authority is owner-only, derived from the socket
  actor's trust tier, never from the request (#1446 r1 H2).
- `src/composition/automation-wire.ts` answers every request with a typed value
  (refusals included, no throw); `automation-judge.ts` binds the optional fast
  model (`OPENOMNI_FAST_MODEL_ID`) to the channels judge port;
  `automation-alarm.ts` registers the alarm sender once per session and types
  malformed payloads as `AlarmWakeError`; `automation-delivery.ts` lands
  `prompt|action` rows — target `new` composes the #1346 create-session
  RPCs, a missing `session:<id>` target records `refused target_not_found`.
- Channels fixes landed with the wiring: missing-channel routes are granted only
  after a matched record (r1 H1); schedule triggers match `cron:<expr>` ticks
  only, never a `monitor:` alarm channel (r1 M4); `AutomationConfigurationError`
  and `scheduleTickChannel` join the package barrel.
- Snapshot baselines (`script/conformance/tool-schema-snapshot.json`,
  `schema-snapshot.json`) grew by the five provision ops; additive, recorded for
  Owner sign-off in `[ino]` issue #1450.
- Verification: review r1 H1-H2/M2-M7 fixed and lead-verified from the diff
  without r2; post-rebase CI reds were three stale test expectations; CI green
  at merge. Receipt names #1434.


## #1347 — restore budget, persisted step budget, strikes, row byte cap (PR #1445, base `c99bb6d5c`)

- `fold.checkpoint` rows carry `budgetState`; the checkpoint policy (`everyActions`, `maxTailBytes`) lives in `session.configure` settings. A crash-open reactivation resumes its step/budget counters from the checkpoint through `createSessionChatRunner` and stops with the existing `AgentStopError{reason: "budget"}` before any model call (the reactivation test drives `createController(...).reconcile()` over reopened SQLite files and fails when the `budgetState` hand-off in `run.ts` is removed).
- The writer keeps the restore tail under `maxTailBytes` (`commitFoldBatch` checkpoints by count or bytes); the activation restore (`restoreSessionHistory`) refuses a longer tail with a typed `RestoreRefused`; restore telemetry is logged from `core/recovery.ts` and never reaches model context. A folded state past the row cap degrades explicitly: the store's typed `row_bytes` refusal of the writer's own checkpoint is logged with `sessionId`/`checkpointId`/`checkpointBytes` and the caller's rows commit without it.
- `armed_alarms` gains a strike counter: `strikeArmedAlarm` increments in its own transaction (no journal row) and the entity settles an occurrence unexecuted at `MAX_OCCURRENCE_STRIKES = 3`; session-file schema is `SESSION_FILE_SCHEMA_VERSION = 2` with a probe-side v1 upgrade, and a file written by a newer build refuses to open with `CatalogVersionRefused{operation: "openSessionStore"}` (no read-only `query_only` fallback remains).
- Every journal row is capped at `DEFAULT_ROW_BYTE_CAP = 1024 * 1024` bytes of payload at the `sqlite-l0-write.ts` append boundary (typed `SchemaRefused{reason: "row_bytes"}`, zero rows written); the `tool.post` decision row records the projected (bounded) result so it fits; the boundary test pins literal bytes (`1_048_576` commits, `1_048_577` refuses) rather than mirroring the constant.
- The process-session child provides `Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)])` through the new `AppRuntimeOptions.logger` (provided under the whole runtime layer so cluster-host fibers inherit it): the child's stdout is the parent's JSON-lines wire, and the restore log would otherwise fail the parent's `JSON.parse` and restart the entity on every activation (CI `openomniApp` lane; `process-session-e2e` 9/1 → 11/0).
- Scope: `packages/agent` (27 files), `packages/protocol` (4: `ledger/l0.ts`, `journal/core/session-configure.ts`, `journal/index.ts`, `storage/index.ts`), `script` (2: `check-comment-residue.ts`, `conformance/schema-snapshot.json`), `apps/openomni` (2: `src/runtime.ts`, `src/process-entry.ts`); 35 files over 16 commits; zero edits under `packages/channels`.
- Review: r1 H1–H3 and M1–M5 fixed in 8 follow-up commits (one per finding plus one H3 band follow-up keeping `entity.ts` under its `check-deps` pin); Lows carried as PR comments. CI round: comment residue trimmed to the 1424bp ratio pin, written `unknown` test locals replaced by typed narrowing, child stderr logger. Gate: the codemode lane was rerun alone after a Chromium launch timeout under host load (47 pass / 0 fail).

## #1342 desktop automation editor and ingress ledger explorer (epic #1337, rung 5)

- `apps/desktop/src/renderer/gateway/` transport gained six typed methods over the
  existing WebSocket: `automation_add`, `automation_remove`, `automation_enable`,
  `automation_disable`, `automation_list`, `automation_ledger`; replies are
  `*_added/removed/enabled/disabled/listed` and `automation_ledger_read` or the
  shared `*_refused`
  frame. Every request has a bounded wait; a missing or malformed reply resolves
  to a typed refusal and re-enables the list (#1447 r1 M2).
- `renderer/automation/{editor,triggers,conditions,view}.tsx`: record editor for
  the `Ingress.Automation` contract; `invalid_record` issues (local and server)
  render next to their field; `require_approval` and refusals are shown, never
  retried.
- `renderer/ingress-ledger/{rows,view}.tsx`: ledger explorer over
  `automation_ledger` requests / `automation_ledger_read` replies (range/page
  bounded); a grouped row links to the
  `matched` row sharing its `group:<id>` fact, the shape `packages/channels`
  `router/automation/groups.ts` writes (#1447 r1 H1).
- Fixture preview lives only in `apps/desktop/test/automation-preview.{tsx,html}`
  and helpers; no mock data in the renderer; `sqlite` appears 0 times in
  `apps/desktop/src`.
- Verification: 113 desktop tests at delivery, 40 changed-file tests and six root
  gates after the review fixes, eight light/dark × desktop/narrow captures with
  no horizontal overflow; live-gateway integration is covered by #1341's wire
  tests, not by desktop tests.


## #1352 model-call layer extracted to `@openomni/llm` (epic #1356, rung 5)

On `epic1356/1352-llm-package` (2026-10-13, base `c99bb6d5c`).

`packages/agent/src/model/` (provider resolution and adapters, the stream-event processor, usage accounting, credential storage, the `ai@7.0.93` pin and the provider majors) and its tests moved by `git mv` into the new `packages/llm` workspace (`@openomni/llm`, depends on `@openomni/protocol` only; `Provider` is package-internal, `Model` survives only as protocol `Model.Ref`). The dependency is reversed from the pre-#1246 package: the core declares the port in `packages/agent/src/core/llm.ts` — the `Llm` tag keeps its `@openomni/agent/Llm` key, `LlmPort { resolveModel(ref, now), run(input, sink), classifyFailure(facts) }`, `LlmSink`, `RunInput`, `ResolvedModel`, a `_tag`-identified `LlmRunFailure` and the closed `FailureClass` (`aborted | overflow | retryable{reason, afterMs?, directed, instant} | terminal{reason, code?}`) — and `packages/agent` never imports `@openomni/llm`, `ai` or `@ai-sdk/*` (`script/check-deps.ts` workspace table and core band). `core/retry.ts` keeps the retry decision: reason codes, the 60s directed and 30s ladder caps, the instant-failure streak, the 3-attempt cap and overflow -> compaction producer; `runAttempts` takes a `classify` callback and `turn.ts` asks the port about a successful stop that showed nothing, so a usage-proven overflow enters the same recovery; a stop that already showed output is the answer and is never replayed (the between-turn compaction trigger owns that window, as before). An error result whose payload is not a typed failure settles as a terminal `AgentFailure`, not a retry input. `makeLlmService(authFilePath)` in `packages/llm/src/services.ts` is the port value; `apps/openomni/src/runtime.ts` binds it to `Core.Llm` (`LlmLive`), `composition/completion.ts` classifies through the bound port, and `observation/llm-failure.ts` maps the class to a `ProviderReason`. `classifyFailure` is pure: overflow for a declared or text-matched overflow, a normal stop whose input + cacheRead exceeds the window, or a length stop with zero output at >= `NEAR_WINDOW_RATIO` (0.99, named once) of the window; missing usage never reclassifies. The agent test suite runs against the port-only fake (`packages/agent/test/helpers/fake-llm.ts`, whose classifier mirrors the real one: no provider cause is terminal); the shared seven-signature `ai` mock lives in `packages/llm/test/helpers/retry.ts` only. New tests: `packages/agent/test/core/llm-port.test.ts` (facts, directed delay, terminal, overflow routing, the silent and the visible stop), `packages/llm/test/failure-classification.test.ts`, `packages/llm/test/run.test.ts` (one attempt per invocation); `packages/llm/test/retry/retry.test.ts` relocated; `packages/agent/test/core/provider-retry-ownership.test.ts` kept. Topology: `script/topology.ts` adds the `llm` workspace (nine workspaces; `apps/openomni` may depend on it), `check-deps.ts` drops the model band, the `Model` namespace and the moved-file pins, `check-comment-residue.ts` drops the moved pins (the residue gate covers `packages/agent/src` only) and lowers the JSDoc ceiling 126 -> 109, `knip.json` and `.github/workflows/ci.yml` gain the lane, the AGENTS topology table is regenerated, and `script/effect-error-contract.test.ts`, `gate-discovery.test.ts`, `lint-side-effects.ts` and `generate-models-snapshot.ts` follow the moved paths.

Verification: `check-types`, `lint`, `script/check-deps.ts`, `script/check-topology.ts`, `script/check-comment-residue.ts`, `script/check-dead-exports.ts` and `lint:tools` on the branch; the changed test files of `packages/llm`, `packages/agent` and `apps/openomni` run per file under the shared flock lock (never the whole suite); the issue's zero-hit searches (`from "ai"`/`@ai-sdk` and `../model`/`@openomni/llm` under `packages/agent/src`, `from "ai"`/`@ai-sdk` under `packages/agent/test`, `@openomni/agent` under `packages/llm/src`, the model band and `Model` namespace in `check-deps.ts`) return nothing. The full gate is lead-owned.

## #1346 one-call session creation and the four entity RPCs (epic #1356, rung 4)

On `epic1356/1346-create-session-four-rpcs` (2026-10-13, base `89b90b793`, PR #1444).

Session creation is one core call: `Core.createSession` (`packages/agent/src/core/create.ts`, `SessionStore.create`) commits the session-file genesis inside the catalog transaction, so the durable genesis and its catalog index row exist together or not at all, refusing typed `CreateRefused{duplicate | orphan_index | write}`; fork indexing is core-owned through `ForkPorts.catalog`. The app reaches a session only through the four entity RPCs: ingress and outbound commits ride the core execution ledgers (typed `CorruptRecord` on a missing receipt), `materializeDeliveryTarget` calls `Core.createSession`, interrupt is `Deliver{kind: "signal", control: "interrupt"}` (the app CAS/retry loop is deleted), and the process child forwards deliveries as `request_deliver` frames the parent commits through the entity. The `Core` barrel exposes `SessionHandleStore` as the curated read-only face only; `script/check-deps.ts` `validateAppsSessionWrites` bans session-store write receivers in `apps/**` except the exact `index.ts:1219 kernel.commit` (`tools.add` configure) line and the pinned `ingress-executor.ts` `Core.adoptedExecutor` perimeter exception. Verification tokens in `apps/openomni/src`: `kernel.commit(`/`source.commit(`/`kernel.materialize(`/`plane.catalog.indexSession(` 2/1/1/3 → 0/0/0/0; scoped `.commit(` 5 → 1 and `.materialize(` 3 → 1.

Verification: lead gate `gate-1346.sh` on the PR head after the rebase onto `89b90b793` (log `.omo/evidence/ulw/01a11a6f-1bd5-7df9-b6af-92414dece7bb/core1356/gate-1346.log`); adversarial review r1 (`review-1346-r1.md`) and r2 (`review-1346-r2.md`): Gate (local, 2aa690c6c): 14 STEP/LANE/PATCH exits 0 in gate-1346.log; the packages/agent lane wedged under load 23 on 18 cores (114/114 timeouts, 0 assertion failures, no output after 15:40) and was killed, then rerun alone (hub 15:51 ruling, no full-gate rerun): LANE_EXIT packages/agent 0,  1787 pass  0 fail - logs gate-1346.log + gate-1346.agent.log under core1356/..

## #1345 core-owned ledger host (epic #1356, rung 3)

On `epic1356/1345-core-host-layer` (2026-10-12, base `25584f2d7`, PR #1442).

The ledger host moved into `packages/agent`: `core/host.ts` opens the catalog, per-session stores, the `effect/cluster` `SingleRunner` layer and the session entity behind `Core.openLedger` (a scoped Layer; one store-opening function carries the typed `OpenRefused`, and the plane finalizer is the catalog's only release). The plain plane constructor exists only as `Testing.openLedgerPlane` for test fixtures and is banned in `apps/**/src` by `script/check-deps.ts`; the `Core` barrel no longer exposes `openCatalogStore`/`openSessionStore`. `apps/openomni/src/composition/cluster-runtime.ts` keeps configuration and consumes the Layer: retired tokens `openCatalogStore|openSessionStore|createSessionEntityLayer|createSessionEntityRunTurn|SqliteClient` in `apps/openomni/src` 2/3/2/6/2 → 0/0/0/0/0; `@effect/sql-sqlite-bun` imports in app + channels src 1 → 0 and `effect/cluster` imports in app src 1 → 0. The one channels touch is the Owner-approved test helper `packages/channels/test/helpers/ledger.ts` (+18/−10: import switched to `Testing.openLedgerPlane`, a `close` and the session-file key mapping; no `packages/channels/src` change). `packages/agent/test/core/host.test.ts` covers file and memory modes, late port binding, open refusal, single catalog release, reopen over the same catalog/session files, and memory-mode passivation on the injected clock.

Verification: lead gate `gate-1345.sh` on the PR head after the rebase onto `25584f2d7` (log `.omo/evidence/ulw/01a11a6f-1bd5-7df9-b6af-92414dece7bb/core1356/gate-1345.log`); adversarial review r1 (`review-1345-r1.md`, H1 M4 L6) fixed in full by the r1 fix lane, r2 (`review-1345-r2.md`) r2 REQUEST_CHANGES H3 fixed in f65ba02ca..eb0e7d732 + 171b9371e; gate-verified GATE_EXIT 0 on 171b9371e, no r3 per rule 3.

## #1344 unified parallel core implementations (epic #1356, rung 2)

On `epic1356/1344-parallel-impls` (2026-10-12, base `7e05bb8d1`, PR #1408).

Five parallel implementations inside `packages/agent` collapsed to one owner each. Journal-visible text changes are confined to failure rendering and each is pinned by a test (review r1 M1/M2/L1/L4): tool and gate evidence carries `thrownAsError(cause).message` instead of `String(cause)` and `renderBodyCause` renders an empty-message Error as its name; `parsePlainJson` refuses `SchemaRefused{reason: "json", detail: <SyntaxError.message>}` instead of fabricating a row; `LlmRunFailure` evidence sets `providerErrorName` only for provider SDK errors (transport throws stay `null`); `model/run.ts` renders an empty-message error as its `_tag`. No journal kind, schema or row shape changes:

- Revision CAS: `core/entity.ts` `retryRevision` is the only bounded retry (three conflicting attempts, then the typed `AdmissionFailure{code: revision}`); `testing/controller.ts` calls it through the internal core import, and `AdmissionFailure` is a member of `SessionError` (pinned by `script/effect-error-contract.test.ts`).
- JSON: `core/store/json.ts` owns `parsePlainJson` (throwing — malformed text is `SchemaRefused{reason: "json"}`, schema failures stay typed) and `readPlainJson` (the degraded companion used by session-file and alarm-watch reads); `rg -n 'JSON\.parse' packages/agent/src` = 2 (the decoder and the module-private `core/gate/decide.ts` `clonePlainValue`, which must copy, not alias — pinned through an exported consumer).
- Causes: `rg -n 'String\((cause|error|err|e)\)' packages/agent/src` = 2 call sites (`thrownAsError` in `core/failure.ts` beside `renderBodyCause`, and `model/model/loader.ts`, which wraps a non-Error catalog throw into the typed `ModelCatalogError.cause`); every other cause is typed `string | Error` (model causes, `RunFields.cause`, `HookSpawnError.cause`) with no new `Failure.fromCause` use, and AI SDK failures still wrap `APICallError` inside `APIError`. `model/auth/storage.ts` decodes the auth file with protocol `parseJson` inside a `safeParse` transform — a third decode owner, kept because `model/` may not import the core store (review r1 L6).
- Test-only options: `trackWave` and `extensionKinds` are gone from `core/tool.ts`, `core/run.ts`, `plugins/tool/dispatch.ts` and `core/gate/decide.ts` (0 hits in src and test); `turn-dispatcher-coverage.test.ts` and `execution-verdicts-model.test.ts` observe real wave settlement and registered execution kinds.
- Clones: jscpd over `packages/agent/src` at the 50-token threshold reports 0 clones, down from 9 at the base (nine production pairs consolidated at their existing owners: shared turn ports, capability hooks, prepare-args tuple, `decisionOf`, `rewriteDoHow`, `unknownRef`, `GenerationSeed`, `openDeliveryRow`, `weightedMessageChars`, `sqliteNumeric`); dead-export ratchet unchanged.
- Cost: the always-zero required `cost` field is deleted from `Message.StepFinishPart` and `Message.AssistantMessage` (`packages/protocol/src/message/index.ts`), the step-finish stream producer, agent projections, fixtures and `script/conformance/schema-snapshot.json`; parts persisted with `cost: 0` still parse (field stripped, `packages/protocol/test/message.test.ts`). No rate table and no new journal row.
- Residue: the #1343 comment-ratio ceiling lowers 1425→1424bp in the same PR; `Bun.spawn|node:child_process` under `core/` stays 0.

Verification: lead gate `gate-1344-r1.sh` on the PR head after the rebase onto `7e05bb8d1` (log `.omo/evidence/ulw/01a11a6f-1bd5-7df9-b6af-92414dece7bb/core1356/gate-1344-r1.log`): build, check-types, lint, lint:tools, check-topology, check-deps, check-import-cycles, check-dead-exports, check-journal-writers, check-written-types, verify-tsconfig-inheritance, lint:docs, check-quality-python, the eight workspace test lanes, the three script lanes and patch coverage all exit 0; jscpd `packages/agent/src` 9 → 0; `check-comment-residue` OK at 1424bp. Review r1 (`review-1344-r1.md`, H0 M6 L6) fixed in full; r2 (`review-1344-r2.md`, H0 M1 L5) confirmed them and found one new Medium — a second `thrownAsError` copy in `model/model/loader.ts` — fixed by the lead before merge (loader on `core/failure`'s `thrownAsError`/`renderBodyCause`).

## #1340 automation matcher, judge port, grouping and perimeter store tables (epic #1337, rung 3)

On `epic1337/1340-matcher-judge-store` (2026-10-13, base `182a9fc27`, PR #1411).

- `packages/channels/src/automation/` is pure (no router imports): `rules.ts`
  and `matcher.ts` turn a matching `Ingress.Input` into a prompt or action
  route; `judge.ts` resolves `runWhen` conditions as `yes | no | unknown`
  before the final match (`unknown` never matches); `regex.ts` validates
  patterns at `store.add` (typed refusal, 512-character cap) and caches them.
- The router owns integration under `src/router/automation/`: one
  `input.ts` builder serves filtering and matching; `ledger.ts` records
  exactly one automation decision (`matched`, `filtered`, `refused`,
  `deduped`, `grouped`) per external event and emits one observation per
  new row; replay of any recorded kind writes no new row and returns the
  original decision; blocked routes and request answers never enter
  automation or groups.
- Grouped events are durable rows (`store/automation/`, SQLite adapter in
  `store/sqlite/`) that survive a store reopen; quiet windows close from
  the injected clock, which `apps/openomni/src/index.ts` mounts via
  `composition/automation-clock.ts`. Prompt and action deliveries go
  through the ordinary dispatch path (policy gate, egress budget, event-id
  checks, `message.admitted`).
- `router/automation-rules.ts` replaces #1339's `router/ingress-filter.ts`;
  bot filtering writes only the automation ledger.
- Rule editing (`provision{automation_*}`) and the desktop editor are rungs
  4/5 (#1341, #1342). A non-firing automation never suppresses ordinary delivery;
  a failing group close is isolated to its group and recorded. Tests:
  channels 770 pass / 0 fail; apps/openomni 782 pass / 0 fail.

## #1339 channel drivers report facts only and emit the unified ingress input (epic #1337, rung 2)

On `epic1337/1339-facts-only-drivers` (2026-10-13, base `6f9503ef1`, PR #1410).

- Slack, Discord, Telegram and GitHub normalizers emit `Ingress.Input` with
  `IngressFacts` author/event (bot flag, reactions, edits, pull-request events);
  Slack `message_changed` edits by the bot itself are dropped as self-echo.
- Fifth provider: signed webhook (`packages/channels/src/provider/webhook/`),
  composed in `apps/openomni` with its own credential reader; webhook rows boot
  with their own schema.
- `router/ingress-filter.ts` records bot and reaction ignores as ledger rows
  before routing; `router/inbound-id.ts` is the single inbound-id helper; GitHub
  refused connections classify `not_sent` through the shared `isNotSent` rule.
- No automation policy or matcher yet (rung 3, #1340). Tests: channels 709 pass /
  0 fail; apps/openomni green.

## #1338 protocol contracts for the unified ingress input, automation records and automation ledger decisions (epic #1337, rung 1)

On `epic1337/1338-protocol-schemas` (2026-10-12, base `d9800ad74`, PR #1409).

- Four Zod contracts under `packages/protocol/src/ingress/`, exported through
  the existing `Ingress` namespace, Effect-free and I/O-free
  (`rg -c -i effect packages/protocol/src/ingress/` prints nothing):
  - `Ingress.Input` (`ingress/input.ts`): the one normalized event every
    source produces — `eventId`, `surface`, `event` in
    `message | reaction | mention | webhook | github | schedule`, optional
    `channelId`/`threadId`/`workspaceId`, `author{externalId, isBot}`, `dm`,
    `mentionsBot`, `body`, `receivedAt`; strict object.
  - `Ingress.Automation` (`ingress/automation.ts`): the managed rule record —
    `createdBy` is `owner` or `session:<id>`, at least one `Trigger`
    (`schedule{cron, tz} | message{surface, event} | webhook{secretRef} |
    github{event} | on_demand`), optional `Conditions` whose list fields are
    non-empty (`channels`, `users`, `threads`, `contains`, `excludes`,
    `regex`) plus `includeBots`/`dm`/`mentionOnly`, optional `runWhen` prose,
    optional `grouping{windowSeconds in 0|5|10|20|30|60, by
    thread|channel|author}`, the delivery record `target` (`new` or
    `session:<id>`) × `kind` (`prompt | action`, default `action`), optional
    `instructions` for a new session, optional `limits.maxRunsPerDay`.
  - `Ingress.TriggerContext`: what a matched automation hands the session —
    `automationId`, the firing `trigger`, `matched{conditions, runWhen?{verdict
    yes|no|unknown, reason}}`, and the bounded event group (1..64 messages of
    `{eventId, body, receivedAt}` with surface/channel/thread/author).
  - Six automation ledger variants on `RoutingDecisionPayload`
    (`event/ingress.ts`): `matched | filtered | refused | deduped | grouped |
    superseded`, each strict with `stage: "automation"`, `outcome:
    "record"`, `by` matching `automation/… | rule/… | blacklist/…`,
    `factsDigest` (never a message body), optional `runWhen` and `actionSeq`;
    `recordedRoutingDecision` keeps upcasting persisted rows (regression test
    `persisted routing rows still upcast historical fields`).
- `Gateway.IngressFacts` (`gateway/message.ts`) gains optional `event`
  (`message | reaction | mention`) and `author{externalId, isBot}` so
  drivers can report the facts rung 2 normalizes from; existing facts parse
  unchanged.
- No consumer yet: channels normalizers (#1339), the matcher and judge port
  (#1340), the app provisioning and deliver plug-in (#1341) and the desktop
  editor (#1342) are the following rungs. No journal kind, gate point, tool,
  wire method or app/desktop file changes in this rung.
- Tests (`bun test packages/protocol`, 592 pass / 0 fail across 52 files):
  `ingress-input.test.ts` 8, `automation-record.test.ts` 22,
  `ingress-ledger.test.ts` 16, `ingress-facts.test.ts` 5; the routing suite
  under `test/ingress` is 76 pass.

## #1422 one delegation depth cap owner (lane D, umbrella #1421)

Merged `e8481ef66` (PR #1432). The message-policy depth row and the admission constant share one value: `ADMISSION_DEPTH_MAX = DEFAULT_DELEGATION_CAPS.maxDepth` (3) in the delegation-policy bundle; admission previously allowed one level deeper than the caps declared. The depth row lives in the catalog policy plane, where `seedKernelPolicyRows` (`apps/openomni/src/bundles/core-policy/index.ts`) lets every stored row overwrite the default by id, so a catalog seeded before this change keeps admitting at its stored `max: 4`; only catalogs without the row (fresh installs) receive the shared value. Migrating stored rows is a follow-up on #1422. The tests assert the admission constant equals the caps' `maxDepth`.

## #1424 desktop journal-kind audit (lane D, umbrella #1421)

Merged `e86ae5eb0` (PR #1431). The 12-kind coverage table and the confirmed audit live on issue #1424 (https://github.com/INONONO66/openomni/issues/1424#issuecomment-6128854787); the unreachable desktop `data-epoch` path is deleted and no renderer was added: every kind arrives as a payload-free page row, the live message frame carries no revision, and pages are not joined to chat messages, so no per-kind marker can be placed today. Which kinds to render, and how, stays a product decision listed on the issue with a recommendation.

## #1423 the app's Promise band is a declared three-module band (lane D, umbrella #1421)

On `app/1423-promise-band` (2026-10-12, base `c85607df7`, PR #1430).

The three `apps/openomni` modules forced onto Promises or callbacks by an
external runtime API are declared as one band; each carries a head comment
naming the forcing API, the single Effect entry call, and what must never be
added there. Comment-only; zero behavior change; no lint or script added.

| module | forcing API | Effect entry call | verdict |
| --- | --- | --- | --- |
| `composition/watch-sources.ts` | `node:fs` `watch` listener callbacks, `Bun.spawn` PTY streams / `child.exited`, machines `pty.read` long-poll, `setInterval` reconcile cadence | injected `WatchSenders.deliver` (bound to `runAppEffect` in `index.ts`); the module never commits an arm row | keep |
| `composition/process-session.ts` | `Bun.spawn` stdin/stdout byte streams (`ReadableStream` reader, `child.exited`) | injected `answer` (`runAppEffect(runtime, requests.answer(...))`) | keep |
| `provisioning/supervisor.ts` | channels driver `surface.start` Promise contract (`stop` is synchronous; channels is the #1248 Promise band with its own injected `EffectRunner`) | the driver runner (`ChannelRuntimeDeps.run` = `runAppEffect`) that `deps.desired()` passes into each built surface; `.then(() => undefined, ThrownError.parse)` narrows the rejection to a typed Error that `mountRow` re-throws and `startRow` records as breaker status, never a swallow | keep |

Considered and excluded: `composition/alarm-plane.ts`, `composition/process-replies.ts`,
`composition/cluster-crypto.ts`, `gateway.ts` and the other `composition/*` layers use
`async`/`.then` only at the `runAppEffect` edge or inside Effect programs; `cli/*` is
the process-entry band that never touches session state; `tools/*` bodies are
Effect-free by the boundary law (`script/check-effect-boundaries.ts`) and speak the
machines IPC Promise API, which is the declared machines boundary.

## #1314 benchmarks measure the consolidated bus and store paths (epic #1303, rung 16)

On `stab/16-measure-bus-consolidations` (2026-10-08, base `4b36d0f73`, PR #1335).

- Production bus measured: `bench/bus-fanout` and the memory guard
  (`test/store/bench/memory-regression.bench.ts`) run on `makeObservationBus`
  (the real Effect PubSub inside a Scope), not the retired
  `helpers/observation` stand-in (`rg 'helpers/observation'
  packages/agent/bench packages/agent/test/store/bench` -> 0). Fanout acquires
  N subscriptions via `yield* bus.stream` before any publish, asserts the new
  read-only `bus.subscriberCount()` equals N before measuring, and settles
  each iteration on the exact N-th delivery; a short fanout throws the typed
  `FanoutShortfall` (watchdog outside the measured body), never hangs.
- One existence + one parent query per committed action: both checks live
  solely in `validActionBatch`; the commit loop and the single-append path
  write through module-private `appendValidatedAction` (query-spy test: a
  3-action batch runs exactly 3 existence queries and 1 parent query —
  in-batch parents resolve from the batch id set with zero queries). The
  single-append path keeps the #1252 fail-closed order: `refuseSchemaMismatch`
  runs BEFORE the existence/parent checks, so a duplicate-id +
  schema-mismatched action throws the typed `SchemaRefused`, never a silent
  `undefined` (regression test in `test/store/session/kernel.test.ts`).
- Linear summarizer trimming: the quadratic
  `estimateMessagesTokens(elided.slice...)` probe became a running
  weighted-char suffix total with one ceiling per probe — byte-identical
  rounding proven by equivalence tests against an inline quadratic oracle
  (500 over-budget messages, mid-list stop, exact-budget boundary, zero
  inputs) in `test/compaction/compact.test.ts`.
- Measured ns/op (`bench-16-before.json` -> `bench-16-after.json`, host runs
  on Darwin arm64 Apple M5 Pro, Bun 1.4.2, load recorded; not CI):
  bus-fanout/10-subscribers 619 -> 7641, bus-fanout/50-subscribers
  819 -> 42145, bus-fanout/100-subscribers 1093 -> 89022 (the measured
  surface changed from a stub to the real PubSub — the honest baseline the
  issue asked for); session-commit/action 123463 -> 70138;
  compaction/500-messages 3007810 -> 3086723 (+2.6%, host noise).

## #1319 legacy gate rows cut over to a versioned writer (epic #1303, rung 12)

On `stab/12-legacy-rows-cutover` (2026-10-08, base `2dc31be78`).

- Writer: `packages/agent/src/core/gate/rows.ts` owns gate-row identity
  minting — `GATE_ROW_WRITER_VERSION = 1` and `gateRowId(row, point, ordinal)`
  returning `<name token>/<point>#<ordinal>`, where the name token is the
  row's free-form name projected onto the protocol `GateRowId` grammar
  (runs outside `[a-z0-9]` collapse to `-`, non-letter starts gain `row-`),
  so bundle-seeded names (`hooks-json/tool.pre#3`) and dotted message names
  mint schema-valid ids. `project.ts` mints every projected row id through
  it; the ordinal is the row's index in the priority-sorted projection
  order, so same-name (and same-token) rows on one point stay distinct.
- Snapshot version: protocol `SessionGeneration.Snapshot` gains the optional
  `rowsVersion`; `fence.ts` `generationSnapshot` (the one snapshot
  constructor) records `rowsVersion: 1` on every new materialization.
  Pre-cutover snapshots parse with the field absent — never defaulted.
  Measured: `rg -n 'rowsVersion' packages apps -g '*.ts' | rg -v
  'fence.ts|rows.ts|protocol/src|test/'` → no output (one writer).
- History: decision facts recorded under pre-cutover ids keep their bytes —
  they decode (`SessionHistory.PolicyDecision`) and replay (`GateDecision`
  by recorded `inputHash`) without rewriting `matchedRuleIds`/`rowIds`.
  A pre-existing session file read after the cutover is byte-identical
  (sha256-verified); a freshly materialized generation records
  `rowsVersion: 1`.
  A pre-cutover record that applied a CONTEXT-MATCHER row does not replay
  (the live entry's current id is absent from the recorded legacy rowIds):
  the gate decides fresh; in `recoverAdmission` an approval pending across
  the upgrade refuses fail-closed (`stale_approval`) — accepted, recorded
  deviation (#1319 review M1).
- Rename: `legacy-rows.ts` → `row-parse.ts` (`git mv`; the parser was never
  legacy), imports rewritten in `compile.ts`, `evaluate.ts`, `project.ts`;
  no re-export alias. Measured greps: `rg -c 'legacy/' -g '*.ts' packages
  apps` 1 → no output; `rg -c 'legacy-rows' -g '*.ts' packages apps` 5 → no
  output.
- Tests: `packages/agent/test/core/gate-row-writer.test.ts` (4 pass:
  schema-valid identities + same-name ordinals, production-shaped names
  (bundle id, dotted) parse and re-admit, pre-cutover decode/replay with a
  matcher-row fixture, snapshot version); `generation-policy.test.ts`,
  `permission-row-migration.test.ts`,
  `apps/openomni/test/policy-seed-rows.test.ts` pass unchanged.

## #1311 delegation lifecycle contract — typed cap refusals + once-only child settlement (epic #1303, rung 14)

On `stab/14-delegation-lifecycle-contract` (2026-10-08, base `2dc31be78`).

- Envelope: `Gateway.DelegationResult` in `packages/protocol/src/gateway/message.ts`
  (strict: `status: completed|failed`, `preview` max 4096 characters, `pointer: {session, action}`),
  exported through `MessageContract`; 3 parse-failure tests
  (`packages/protocol/test/send-message.test.ts` 16 pass). Protocol stays Effect-free.
- Typed refusal: `DelegationRefusal` zod in `apps/openomni/src/bundles/delegation-policy`;
  `capVerdict` deny payloads carry `reason: JSON.stringify(refusal)` as the single carrier so the
  canonical `delegation_refused` JSON reaches the model through the consulted-guard seam
  (`gate/evaluate.ts` → `ToolRefused`) with zero core gate/dispatch edits.
- Settlement: `parentReply` → `settleChild` (`rg -c parentReply packages apps` 19 → 0);
  waiting AND interrupted seals return undefined (interrupted leaves the parent's
  commission request OPEN — the deadline path bounds a silent child), `result`/`error`
  build the `DelegationResult` envelope (preview sliced to 4096 characters) and send it
  `delivery: "followUp"` (`SessionTransition.OutboundMessage` optional field, forwarded by
  `composition/message-session.ts`); `core/run.ts` guards once-only settlement (existing
  outbound rows targeting the parent → skip), so interrupt-then-resume settles exactly once.
- Tests: `delegation-policy.test.ts` 12 pass (typed refusal parse, settleChild arms,
  truncation), `send-message-e2e.test.ts` 6 pass (exact-event trace: parent turn seals →
  followUp delivery → settlement turn; interrupt-resume single settlement; composed cap
  denial parses `DelegationRefusal` off the ToolRefused content; 0 setTimeout),
  `message-terminal-boundaries.test.ts` 4 pass. Base repair: `approval-policy.test.ts`
  missing required `alarms` manifest field (pre-existing type error on the synthetic base).

## #1305 bounded tool output projection (epic #1303, rung 15)

On `stab/15-bounded-tool-output-projection` (2026-10-08, base `2dc31be78`).

- Protocol: `ToolOutputRef`/`toolOutputRefSchema()` + `TOOL_OUTPUT_PREVIEW_MAX_BYTES`
  in `packages/protocol/src/tool/result.ts` (Effect-free: `rg -c 'from "effect"'
  packages/protocol/src/tool/result.ts` -> no output); `Settings` gains optional
  `toolOutputBudgetBytes`.
- Store: `tool_outputs` table (output_id PK, bytes, media_type) in the session
  file; `SessionStore.toolOutputs.put` is INSERT OR IGNORE (identical bytes
  store once); fork copies only referenced outputs inside the same child
  transaction and counts their bytes against `forkCopyByteCap`.
- Core: `projectToolOutput`/`projectResultValue` in `core/tool-output.ts`
  replace the deleted `truncate`/`MODEL_OUTPUT_MAX_CHARS`
  (`rg -c 'MODEL_OUTPUT_MAX_CHARS|bytes dropped|function truncate' -g '*.ts'
  packages apps` -> no output; base counts 4/6/1); the gate projects the
  committed `result` to `{outputRef}` while `resultHash` stays the full-value
  digest and `revert` survives beside the ref; the dispatcher renders
  preview + `[output <id>: <n> bytes; read with tool_output("<id>")]`.
- Readers: `Inspect.toolOutput` (typed `unknown_output`), optional `outputRef`
  on `session_read` page action rows, and the codemode prelude
  `tool_output(output_id)` over a host op (`CodemodeOptions.toolOutput`) - the
  12-factory catalog stays sealed, no new journal kind.
- Bus: `publish` skips `publishUnsafe` when no subscriber holds matching
  interest for the event name (interest counted per event name; the wildcard
  `observations` surface counts for every name; publish-time `match`
  predicate evaluation is deliberately omitted - the stream still filters by
  `match` on the consumer side, recorded deviation from #1305 solution 6);
  `onPublish(eventName, delivered)` seam for rung 16 measurement
  (`packages/agent/test/core/bus.test.ts` zero-publication and
  non-matching-name cases).
- Config: `OPENOMNI_TOOL_OUTPUT_BUDGET_BYTES` -> `resolveToolOutput` ->
  genesis `session.configure{settings.toolOutputBudgetBytes}`
  (`apps/openomni/test/tool-output-budget.test.ts` through the shipped
  composition).
- Measured (1 MiB fixture, `packages/agent/test/core/execution/tool-output-projection.test.ts`):
  row bytes before projection 1048770, after 16617; read-plane / row-event
  proxy (the serialized history-page action node - size-faithful to the
  committed-row `ActionCommittedEvent` payload, not a captured bus event)
  before 1049184, after 17030; the stored bytes read back whole through
  `Inspect.toolOutput` and the codemode `tool_output` (1048576 bytes).
- Kept reader: `rg -c 'toolResultText' -g '*.ts' packages apps` sums to 23.

## #1315 retire the input-queue and job-title vocabulary (epic #1303, rung 11)

On `stab/11-retire-inbox-worker-vocabulary` (2026-10-08, base `4b36d0f73`).

- Rename (no alias exports): protocol `Inbox` namespace -> `Delivery`,
  `inboxId`/`inboxIds`/`inboxKind` -> `deliveryId`/`deliveryIds`/`deliveryKind`,
  `LedgerSession.Role` `worker`-byte -> `child`; agent core/plugins/tests,
  channels router/store, codemode/machines Python prelude (`max_concurrency`
  kwarg), apps/openomni composition/tools/policy-seed/message-policy
  (`message.child.*` ids, tool visibility `child`) and the desktop `inbox`
  route -> `automations` all follow (231 files). Ingress drops the retired
  string/object subordinate target with a typed parse refusal
  (`packages/protocol/test/ingress/target.test.ts`).
- Versioned reads (#1315, read-side folds deleted by #1351): prompt/signal/turn
  declarations stay at version 2 and stored bytes stay frozen, but
  `foldDeliveryPayload`, `LedgerSession.foldLegacyRole`, `V1_DELIVERY_FIELDS`,
  `LEGACY_CHILD_ROLE` and `LEGACY_INGRESS_POLICY_KIND` grep to zero; the
  session-file pending/input SQL reads only `deliveryId`/`deliveryIds`/
  `deliveryKind`. The real-data gate that makes the deletion safe (every Owner
  session file carries zero version-1 delivery fields) is the Owner receipt
  tracked in #1466.
- Catalog v3 -> v4 (#1351, `CATALOG_SCHEMA_VERSION` 4): one `immediate`
  transaction rewrites exactly the retired bytes — `session_index.role` and the
  `policy.match` paths `$.role`, `$.message.senderRole`, `$.message.targetRole`
  `worker` -> `child`, pre-phase `policy.kind` `inbox.deliver` -> `ingress` —
  then copies rows into tables whose CHECK constraints exclude the retired
  values; any other off-vocabulary byte or key collision fails the whole
  transaction with the typed `CatalogUpgradeRefused` and leaves the file at
  `user_version` 3 byte-identical (`packages/agent/test/store/catalog-upgrade.test.ts`,
  `packages/agent/test/alarm-recovery.test.ts`). The Owner catalog backup
  before the first v4 boot is also #1466.
- Legacy bytes now appear only inside the v4 upgrade literals in
  `packages/agent/src/core/store/catalog.ts` and the tests that prove each is
  rewritten or refused; `rg '\["in", ?"box"\]'` and `rg '\["wor", ?"ker"\]'`
  stay 0.
- Deliberately kept wire-frozen vocabulary: `Actor.Kind internal_worker`,
  `TrustTier assigned_worker`; third-party names untouched: Playwright
  `workers: 1`, Python stdlib `ThreadPoolExecutor(max_workers=…)`.
- Conformance snapshots (`script/conformance/*.json`) and `crash-matrix.json`
  crash points refreshed to the renamed enum; `bun run lint:tools` passes.
- Follow-ups (not in this rung): a pre-merge session-file fixture e2e over the
  version-1 fold (the fold is unit-tested and the v2->v3 catalog rebuild is
  integration-tested) — recorded in the epic receipt.

## #1309 executable product policy moved into app bundles behind seams (epic #1303, rung 9)

On `stab/9-core-policy-to-bundles` (2026-10-08, base `c11ae7148`).

- Seam: `packages/agent/src/core/approval-policy.ts` declares `ApprovalPolicy`
  (plain data: `responders`, `recentOpen{limit, windowMs}`, `defaultExpiryMs`,
  `defaultBudget`) plus `ApprovalPolicySeam`, exported through the root `Core`
  namespace (`core/index.ts`; no plugin consumes it, so it never reaches the
  `core/api.ts` plugin surface). No callbacks, no defaults in core.
- Core purge (measured): `rg -n '\["owner"\]|count >= 8|3_600_000|86_400_000|BUDGET_DEFAULTS'
  packages/agent/src/core` → no output; `rg -c 'BUDGET_DEFAULTS' -g '*.ts'
  packages apps` (7 before) → no output; `rg -n '86_400_000'
  packages/agent/src/core` (1 before) → no output; `rg -n
  'expectedResponders: \["owner"\]' packages/agent/src` (1 before) → no
  output. `exceedsApprovalBudget`/`openApprovalCount` take `limit`/`windowMs`
  as parameters from the command's resolved policy.
- Threading: `createApprovalRequest` takes `responders`; the gate expiry chain
  is `binding.timeoutMs ?? options.approvalTimeoutMs ?? policy.defaultExpiryMs`;
  `budget.ts` lost `BUDGET_DEFAULTS` — the loop resolves
  `resolveAgentBudget(policy.defaultBudget, budget)` once at entry and
  `ChatAgentConfig.defaultBudget` is required. The policy rides required
  ports: `SessionRuntime.approvalPolicy`, `SessionEntityPorts.approvalPolicy`,
  `ExecutorOptions.approvalPolicy` (no optional fallbacks).
- Product bundle: `apps/openomni/src/bundles/approval-policy/index.ts` owns the
  shipped literals (`["owner"]`, 8 per 3,600,000 ms, 86,400,000 ms, 24 turns /
  40 tool calls / 5 min wall / 2 min tool wall) and provides the seam;
  `appManifest` lists it (six bundles). `send-message` requires the seam, so a
  manifest without the provider refuses typed `seam_missing` at compose — no
  silent in-core fallback.
- Tests: `packages/agent/test/approval-policy.test.ts` (4 pass: quota
  injection limit 2 vs 3, responders land verbatim with the injected expiry,
  default-budget resolution with per-field explicit wins, `seam_missing`
  compose refusal) and `apps/openomni/test/approval-policy.test.ts` (3 pass:
  shipped values through the bundle's `index.ts`, default compose includes the
  provider, stripped manifest refuses `seam_missing` naming `send-message`).
  `delegation-policy.test.ts` unchanged and green; durable request bytes
  unchanged (`packages/protocol/test/request-schema.test.ts` 2 pass, zero
  snapshot churn).

## #1308 one composition root: sealed boot options, single monitor declaration, entity-drained process child (epic #1303, rung 10)

On `stab/10-composition-root-dedupe` (2026-10-08, base `0373ed38c`). Boot
options carry no tool list: `StartOptions`/`ResidentOptions` lost
`toolDefinitions` (`rg -c 'toolDefinitions' -g '*.ts' apps/openomni` prints
nothing) and app tests that need an extra tool declare it through a test
manifest bundle (`appFixture`'s `bundles` option / `testToolsBundle`), so the
12-factory catalog is the manifest's tool projection and nothing else.
`monitor` is declared once, by `monitorBundle`: `createMonitorTool` appears
under `apps/openomni/src` only in `bundles/monitor/index.ts`,
`catalogDefinitions` returns 11 factories, and the generation-construction
name-collision keep rule is replaced by the typed `duplicate` compose refusal
(`manifest.test.ts` pins a two-`monitor` manifest refusing closed). The dead
`monitorSeedRows` export is deleted (`rg -c 'monitorSeedRows' -g '*.ts'
packages apps` prints nothing); tests seed the composed wake-budget row via
`gateRowPolicySeeds` over the monitor bundle's rows.

The process child is a transport into the same root: `ProcessSessionRequest`
grew `hooksPath`/`off` (the #1306 name), the child rebuilds `config -> manifest ->
compose` and boots `gatewayRuntime` with the composed holder (its generation
lists the five shipped bundles), and `process-entry.ts` holds no admission
loop — it binds `SessionEntityBinding` (inline detach: the child owns the
whole turn's lifetime, a typed turn failure is recorded and surfaced as the
child's non-zero exit, and a failure that left the journal unmoved dies as a
wiring defect) and wakes the session entity once through the entity client's
entity-internal `rescan` Alarm, so fence rotation, consume folds and
passivation arming belong to the entity alone (`rg -c
'decideSessionAdmission' apps/openomni/src/process-entry.ts` prints nothing).
`emptyComposition` is deleted and `AppRuntimeOptions.composed` is required;
`cli/main.ts` hands `startOpenOmni` the config only, and
`test/helpers/generation-services.ts` composes its own empty manifest.
`packages/agent/test/helpers/composition-fixtures.ts` and
`apps/openomni/test/composition-drift.test.ts` are deleted; the five
shipped-behavior suites moved to `apps/openomni/test`.

Ruled deviations: the send-message bundle also declares its tool on the base
catalog, so the duplicate-name compose refusal exempts `send_message`
(folding it is its own issue); `app-surface.test.ts` was a seventh
`toolDefinitions` site; `packages/agent/test/helpers/session-services.ts` was
the seventh composition-fixtures consumer and now rides a reply-seam stub.
Implementation deviation: the child surfaces the first typed turn failure
after the entity wake instead of deferring consume decisions to the parent
(the old `process drain deferred consume` path is gone — the entity fold owns
them), pinned by `process-session-e2e.test.ts`.

## #1313 typed idempotency_conflict and seam_missing deliver refusals (epic #1303, rung 13)

On `stab/13-typed-admission-idempotency` (2026-10-08, base `c11ae7148`).
The session entity's `deliver` door no longer reports success for a replayed
idempotency key whose payload differs and no longer falls back to the core
input table when the composed `inputRegistrations` port is unbound. A replayed
key's candidate is hashed with the same canonical digest the journal writer
uses (`packages/agent/src/core/store/action-hash.ts`) and compared against the
stored row's `actionHash`: equal returns `{seq, existed: true}` with zero new
facts; different fails typed `DeliverRefused{code: "idempotency_conflict"}`
before `decideSessionAdmission`, so nothing is appended and the loop is not
woken. The inner `appendReceived` dedupe branch applies the same comparison,
so any caller reaching the writer gets the same answer. An unbound
`inputRegistrations` port fails typed `DeliverRefused{code: "seam_missing"}`;
the `?? CORE_INPUT_REGISTRATIONS` fallback is deleted together with the const
(no remaining reader). `DeliverRefused.code` is exactly `unknown_kind |
missing_key | closed | denied | idempotency_conflict | seam_missing`.

Measured greps at head: `rg -c '\?\? CORE_INPUT_REGISTRATIONS' packages apps`
0 (was 1); `rg -c 'CORE_INPUT_REGISTRATIONS' packages apps` 0; `existed: true`
in production exactly 1 (`entity.ts`, identical-replay path; was 1) plus test
hits only; `setTimeout` in `deliver-idempotency.test.ts` 0; `Bun.spawn|
node:child_process` in `packages/agent/src/core` 0. Test helpers and app
fixtures bind `inputRegistrations` explicitly, so no production default
remains. `bun test packages/agent/test/deliver-idempotency.test.ts` 5 pass /
0 fail; `rpc-surface.test.ts` + `session/entity-admission-refusal.test.ts`
11 pass / 0 fail. No new journal kind, tool, gate point or wire method;
durable bytes of existing rows unchanged.

## #1312 unused helpers and silent fallbacks replaced by typed outcomes (epic #1303, rung 5)

On `stab/5-delete-fallbacks-dead-helpers` (2026-10-07, base `350612bff`, merged
with main `c68c9de5a`). Three lane branches (bands A/B/C) merged into one PR.

- Band A — protocol, machines, codemode, app tool bridge:
  `JsonShapedValueSchema` validates values at runtime (the unconditional
  `acceptJsonShapedValue` is gone) and the four `EvaluationRequest` record
  fields are JSON-shaped; host and daemon share one `isContained` export
  predicate (the trailing-slash disagreement is gone); a PTY command that times
  out removes its FIFO entry on the injected clock, so a late reply is dropped
  and the next command gets its own reply (TestClock test); `peekCode` with
  no runner refuses `kernel_not_available` beside `runCode`; the IPC callback
  dispatcher takes a required injected bound and refuses with a typed
  `IpcQueueFullError` (test helper bound 256, matching the app composition);
  host `callTool` is required and its absence is `host_tool_missing`;
  computer-use failures carry `spawn_failed | read_failed | probe_timeout`
  instead of `undefined`; the Python `_shutdown`/`_stop_chromium` paths
  return failure lists that `kernel.ts` decodes to `browser_cleanup_failed`.
- Band B — channels, desktop, ui: the telegram poller adopts
  `listenForAbort` (a pre-aborted poll makes zero requests); an invalid
  `OPENOMNI_WS_PORT` is a typed `DesktopConfigError` and main refuses to
  boot (unset still means 3000; `OPENOMNI_WS_URL` wins); `TranscriptMarkdown`
  is a required-payload paragraph union and the blank-element render branches
  are deleted.
- Band C — agent, app gateway: `replaceFileAtomically` and its test, eight
  single-file exports and `Inspect.forkAsideTransformer` are deleted;
  model-catalog source failures are typed
  `ModelCatalogError{cache | remote | cache_write}` (no `{}` cache
  fallback, remote not fetched on a corrupt cache); `createResidentGateway`
  requires its `requests`/`stores`/`messaging` ports and the error-contract
  fixture lists `ModelCatalogError`.

Measured on the branch: `grep -rl` over `packages/*/src apps/*/src` returns
no file for `replaceFileAtomically`, `forkAsideTransformer`,
`acceptJsonShapedValue`; 92 files, +1267/-696 against main.

## #1310 mailbox admission split, typed admission/origin refusals, required stop evidence (epic #1303, rung 8)

On `stab/8-mailbox-admission-split` (2026-10-07, base `03cd0c274`).
`packages/agent/src/core/mailbox.ts` is deleted and its five jobs now have one
owner each: `core/admission.ts` (entity admission over the composed
generation's registered capability kinds), `core/recovery.ts` (restoration)
and `core/request.ts` (request authority); `rg 'core/mailbox' packages apps`
prints nothing. Two permissive defaults closed with typed refusals: an
admission snapshot that registers no capability kinds is refused
`missing_capability_kinds` (the `BUILTIN_CAPABILITY_KINDS` fallback is
deleted, grep 0 → was 2), and a prompt whose action row records no origin
fails its turn typed via `InboundAuthorityViolation("missing_origin")`
instead of running with `act` authority (`origin === undefined` grep 0 → was
1). Deviation from the issue plan: the refusal reason unions live in
`packages/agent/src/core/failure.ts` (`unknown_origin | undeclared_treatment
| missing_origin`) and `core/admission.ts` (`unknown_kind |
missing_capability_kinds`) with a zod enum in `core/run.ts` — not in
`packages/protocol`, which has no such enum today. `stopEvidence` is now
REQUIRED on `ChatAgentConfig` (`core/types.ts`) and on the durable runner
input: `turn.ts` reads `config.stopEvidence()` with no empty-evidence
fallback, the prepared loop config is `Omit<ChatAgentConfig, "stopEvidence">`
and the durable runner always injects `input.stopEvidence`
(`rg 'stopEvidence\?' packages apps` prints nothing → was 3; test fixtures
pass an explicit `fixtureStopEvidence`). Tests:
`packages/agent/test/admission-kinds-refusal.test.ts`,
`packages/agent/test/stop-evidence-required.test.ts` (a config without the
port is a `// @ts-expect-error` compile probe; a wired port is consulted),
`inbound-authority`/`session-turn-authority`/`session-chat-runner`/
`request-authority` updated. `bun test packages/agent/test` 1740 pass /
0 fail. No new journal kind, tool or gate point; durable bytes unchanged.

## #1306 full-app boot tests for every capability off (epic #1303, rung 7)

On `stab/7-capability-off-boot-tests` (2026-10-07, base `03cd0c274` = rung 2
head merged with rung 1 head). The five removable capabilities now boot the
WHOLE app off through the product manifest, and the off list is one config
key:

- `apps/openomni/src/config.ts`: `bundlesOff` renamed `off` — the same
  `OPENOMNI_BUNDLES_OFF` JSON tuple now carries bundle and capability names
  alike; compose ignores names the manifest never declared. Measured:
  `rg -c 'bundlesOff' -g '*.ts' packages apps` 10 hits in 6 files before, no
  output after.
- `apps/openomni/src/bundles/resident/index.ts`: a composition with a nonempty `disabled`
  cascade leaves session genesis unstamped (`manifestHash` absent), so the
  first turn's existing single-writer adoption appends the
  `session.configure{operation: "compose", disabled: [{name, because}]}` row;
  an empty cascade keeps the genesis stamp and appends nothing. A composed-off
  `tool` capability returns zero model tool faces (`toolChoice: "none"`), so
  `eval`/`bash`/`read` vanish with the dispatcher's capability.
- `apps/openomni/test/capability-off-boot.test.ts` (8 pass / 0 fail): one
  boot per row through `suite.boot` with injected clock and entropy. Measured
  cascades on this base: alarm → alarm, monitor, cron, delegation-policy;
  action → action, hook, hooks-json, delegation-policy; hook → hook,
  hooks-json; compaction → compaction; tool → tool, monitor, send-message,
  delegation-policy (the issue text predates delegation-policy's alarm seam
  and send-message's tool seam). Each row asserts the compose row's
  `disabled` with `toEqual`, the absent surface (points, handlers,
  capabilities, inputs, tool faces) and a typed `unknown_kind` refusal with
  the journal length unchanged; extra rows cover `["monitor", "hook"]` (each
  cascade keeps its own root), an unknown off name (empty cascade, no
  adoption row) and a two-boot byte-golden check on the alarm row.
- App tests reach plugins only through the `Bundle` barrel:
  `createWatchVerb` is re-exported from `plugins/alarm` and
  `alarm-plane.test.ts` drops the deep import —
  `rg -c 'src/plugins/' -g '*.ts' apps/openomni/test` returns no output.

No new journal kind, point, tool or verb; the five-plugin layout table and
`plugins-layout.test.ts` are untouched.

## #1318 gate-escape closure and timing-test removal (epic #1303, rung 4)

On `stab/4-gate-escape-closure` (2026-10-07, base `c73bc03b3`). Three gates that
could report green without checking now fail closed, with the planted escapes
kept as regression tests, and no test in `packages`, `apps` or `script` passes
by timing luck.

- Patch coverage: `GATED` in `script/check-patch-coverage.ts` gates nested
  script paths (`script/quality-metrics/`, `script/quality-mutation/`) and
  excludes `script/fixtures/`; a planted uncovered nested-script line exits 1
  (`script/check-patch-coverage.test.ts`).
- Written types: `script/check-written-types.ts` scans `packages/*/test/**`,
  `apps/*/test/**` and `script/*.test.ts`; every test-source written
  `unknown`/`any` was rewritten (gate reports 0 on the real tree); a planted
  test-file `unknown` exits 1 (`script/check-written-types.test.ts`).
- Mutation campaign: an incomplete join exits 1
  (`script/quality-mutation-join.ts`), an incomplete shard with no errors
  exits 1 and errors still win with exit 2
  (`script/run-quality-mutations.ts`), and all three
  `.github/workflows/quality-mutation.yml` artifact uploads use
  `if-no-files-found: error` (regressions in
  `script/quality-mutation-shard.test.ts` and
  `script/quality-mutation-workflow.test.ts`).
- Timing tests: `entity-crash.test.ts` asserts not-before delivery from the
  recorded stale alarm fact's commit clock time (`fired_at >= armed_at +
  1500`, no upper bound; the child subscribes via `observationSink` and never
  reads `Date.now()`); the four `hook-plugin.test.ts` polling loops are
  `startImmediately` forks settled by one `TestClock.adjust` + `Fiber.join`;
  the `new Promise((resolve) => setTimeout(resolve` sleeps in test helpers are
  gone (`waitUntil`/`awaitGone` are interval observations of third-party
  state with timeout-as-failure-guard; `fixedClock.sleep` rides `Bun.sleep`);
  the duplicate `preserves the provided name` bus test is deleted.
- The four script gates (`check-topology`, `check-deps`,
  `check-import-cycles`, `check-dead-exports`) are unchanged in what they
  check; each names its invariant in a header comment.
  `knip-baseline.json` still reads `"grandfathered": []`.

## #1307 and #1353 compaction capability behind four core ports

The composed `CompactionSeam` in `packages/agent/src/core/compaction-ports.ts`
binds one run-scoped `CompactionPort` with exactly four operations:
`maybeCompact`, `window`, `pinAction`, and `prepareRestore`.
`maybeCompact(state, reason)` owns threshold checks, prepare-only continuation,
speculative candidate lifetime and execution in `plugins/compaction/policy.ts`;
`window(state)` reads the model window for yield admission without executing.
`core/turn.ts` calls `maybeCompact` at one site, with `"prepare"` on tool-loop
continuation, `"threshold"` at turn end, and `"yield"`/`"overflow"` at the
respective recovery boundaries. An in-flight speculative cut below grace
defers execution. `plugins/compaction/successor.ts` reads history through
injected `CompactionHistoryPorts`, wired by `packages/agent/src/bundle.ts`.
`appManifest` lists the capability; composing it off skips compaction without
writing a `compaction` row, while an unpinnable compaction append fails closed.
`core/compaction.ts` and the app strategy wrapper are deleted; the plugin owns
the default 4000-character tool-output elision with a 500-character head.
No new journal kind, schema version, tool, or gate point. Tests:
`packages/agent/test/compaction/{compact,capability}.test.ts`,
`packages/agent/test/core/execution/{compaction-deferral,compaction-off,overflow-recovery}.test.ts`,
and `apps/openomni/test/compaction-composition.test.ts`.

## #1316 tool plugin owns tool dispatch, monitor requires the tool seam (epic #1303)

On `stab/2-tool-dispatcher-plugin` (2026-10-06, base `c73bc03b3`). The tool
plugin directory holds the dispatcher source instead of a README scaffold:
`packages/agent/src/plugins/tool/dispatch.ts` carries `createDispatcher`
(catalog-wide dispatcher over an explicit or ambient executor; wave, single
and cell doors; result finishing, truncation, output validation) and
`createTurnDispatcher` (per-turn durable executor + dispatcher composition,
captured-catalog pinning, guarded-wave recovery paging), moved verbatim from
`core/tool.ts` and reaching the core only through `core/api.ts`, which grew
re-exports for the gate seams (`activeInvocation`, `createExecutor`,
`immutableInput`, `requireExecutor`, executor/ledger types), the ports
(`GenerationOwnership`, `SessionLayer`, `ToolCatalog`, `ProcessServices`) and
the tool-body seams (`executeToolBody`, `projectTools`, `ToolBodyOutcome`,
`ToolRefused`, the `Dispatcher` types). The agent `Bundle` barrel re-exports
the plugin; `core/index.ts` exports no dispatcher
(`rg -c 'createTurnDispatcher' -g '*.ts' packages/agent/src/core` → nothing)
and `apps/openomni/src/bundles/resident/index.ts` composes `Bundle.createTurnDispatcher`
(`rg -c 'Core.createTurnDispatcher' -g '*.ts' apps packages` → nothing).
Capability declaration: the `monitor` bundle (wake-budget row on `tool.pre`)
and the `delegation-policy` bundle (three consulted cap rows on `tool.pre`)
declare `requires: ToolCapabilitySeam`, so `off: ["tool"]` composes with a
typed cascade — `session.configure{disabled: [{name: "monitor"|"send-message"|
"delegation-policy", because: "tool"}]}` and zero surviving `tool.pre`/
`tool.post` rows — instead of rejecting the rows `unknown_point`
(`apps/openomni/test/manifest.test.ts`). A row on `tool.pre` from a bundle
that does not require the tool seam still rejects `unknown_point`. New
`packages/agent/test/plugins/tool-plugin.test.ts` pins the plugin door, the
two invalid-output edges and the guarded-page recovery cursor walk. Durable
bytes, the kind schemas, the point set and the 12-tool catalog are untouched.

## #1317 channel-facing persistence moved to the channels store (epic #1303)

On `stab/6-store-channel-split` (2026-10-07, base `c73bc03b3`). The channels
package owns the channel-facing SQLite plane:
`packages/channels/src/store/sqlite/schema.ts` carries the `CREATE TABLE IF
NOT EXISTS` statements moved verbatim from the agent catalog
(`actor_identity`, `actor_endpoint`, `channel_grant`, `reply_grant`,
`egress_debit`, `blacklist`, `surface_key`, plus `person`, `secret` and
`channel_instance` — the provisioning adapter that owns those three joins the
same module per the issue's plan), and `openChannelStore(db, now)`
(`store/sqlite/index.ts`) applies the schema and binds the seven adapters
(`git mv` from `packages/agent/src/core/store/storage/`) plus the handle-bound
write `transaction` to one database handle. The agent catalog
(`packages/agent/src/core/store/catalog.ts`) declares no channel-facing table
and constructs no channel-facing adapter; it exposes its raw `database`
handle, and the app composition
(`apps/openomni/src/composition/cluster-runtime.ts`) attaches
`openChannelStore(catalog.database, now)` once per boot as
`AppLedgerPlane.channel`. `apps/openomni/src/gateway.ts` builds
`ChannelStoreSource` from `plane.channel.*` plus the ingress session's
`decisionFacts`/`transaction`. Channels tests run on their own fixture
(`packages/channels/test/store/helpers/sqlite.ts`);
`packages/channels/test/store/sqlite/schema-roundtrip.test.ts` is the
round-trip guard proving `sqlite_master` DDL text and one row per table
byte-identical between a catalog opened by the agent opener and
`openChannelStore` on the same file (a pre-#1317 catalog file opens as an
`IF NOT EXISTS` no-op over its existing tables). `StoredIdentity` /
`StoredEndpoint` export from the channels barrel and left the agent barrel;
the check-deps channels→agent named-import pin shrank by
`createSurfaceKeyStore` (now channels-internal). Verification greps all at 0:
`createSqlite*Adapter` under `packages/agent`+`apps` (22 → 0), `plane.catalog.*`
channel fields under `apps` (6 → 0), agent test fixtures in channels tests
(4 → 0), channel-facing `CREATE TABLE` under `packages/agent` (7 → 0).

## #1304 action plugin owns its implementation source (epic #1303)

On `stab/3-action-plugin-source` (2026-10-06, base `c73bc03b3`). The fifth
capability plugin directory holds source instead of a README scaffold:
`packages/agent/src/plugins/action/index.ts` exports `actionCapability()` —
the `action` journal kind (schema and version read from the protocol's
`Journal.CAPABILITY_DECLARATIONS`, identity reducer), the `action` deliver
input and the `action.pre` gate point — plus `ActionSeam`
(`@openomni/action/Action`), both public through the agent `Bundle` namespace
(`packages/agent/src/bundle.ts` re-exports the plugin beside `plugins/hook`).
`apps/openomni/src/manifest.ts` now composes `Bundle.actionCapability()`
instead of calling `Bundle.Capability.define` locally; the app-owned
`ActionCapabilitySeam` is deleted from `apps/openomni/src/bundles/seams.ts`
(`rg -c 'ActionCapabilitySeam' -g '*.ts' packages apps` returns nothing) and
`bundles/delegation-policy` requires `Bundle.ActionSeam`. The cascade is
unchanged because compose resolves `requires` by name: `off: ["action"]`
still disables `action`, `hook`, `hooks-json` and `delegation-policy` with
`because: "action"` (`apps/openomni/test/hooks-json.test.ts`), and the new
`packages/agent/test/action-plugin.test.ts` proves the plugin-owned cascade
over a minimal `actionCapability()` + `hookCapability()` manifest. Durable
bytes, the kind schema, the point set and the 12-tool catalog are untouched.

## #1258 one send_message tool for every contact, delegation-policy caps (epic #1260)

On `epic1260/1258-send-message-contacts` (2026-10-05, base `ab62ca98`). The
agent owns one session; every other party is a contact behind the single
`send_message` tool. The tool face moved (git mv) from
`apps/openomni/src/bundles/tools/send-message.ts` to
`apps/openomni/src/bundles/messaging/send-message/index.ts` (`Bundle.define`, requires
tool; the sealed 12-tool catalog is unchanged — the bundle face shares the
catalog definition name). Contact registry: `telegram:<id>` / `discord:<id>` /
`human:<id>` / `cli:claude-code|codex|omp`; one Effect connector per kind over
injected ports (`ChannelEgressPort`, `HumanNotifyPort`, `CliRunnerPort`,
`ContactReplyPort`); a connector never throws — failure is the journaled
`{contact, status: not_sent, reason}` fact, and captured CLI stdout returns as
the sender's prompt. Session/new-session sends keep riding the gateway ingest
door; a `to.new` send with `deadline_ms` arms the `delegation.deadline`
purpose for the created child.

`apps/openomni/src/bundles/delegation-policy/` (`Bundle.define`, requires
action + alarm — composing `action` off cascades the bundle off) owns the
delegation policy as generation data: three consulted gate rows at `tool.pre`
(`spawn_depth` limit 3 from catalog parent links, `spawn_children` limit 4
from the parent's ACTIVE children — a child counts while it has an open turn
or an undelivered inbox message, so a finished child frees the slot —
spend-cap refusal when `spend_cap` is unset —
`DEFAULT_DELEGATION_CAPS`, row params, never code constants), the
`delegation.deadline` alarm purpose (its wake cancels the silent child through
the injected entity door — the new `cancel` control riding the `signal`
journal kind — and prompts the parent), and the child-reply prompt wording
(`composition/parent-reply/` deleted; `parent-reply` greps zero in app src).
Core resolves `consult` rows to synchronous `NamedGuard` handlers (one
consulted-row vocabulary shared with #1256: a `consult` row's ref names an
async consultant or a sync guard) with the `when` context
(`op`/`role`/`sessionId`) at the point; guard reads bind in
`composition/generation-layers.ts` to the live catalog plane and register
unconditionally so persisted consult rows compile under any composition (the
process child boots the empty composition). Tests:
`apps/openomni/test/send-message-contacts.test.ts` (routing per kind, scripted
CLI stdout -> parent prompt, boot-bind of both bundles, idempotent first-prompt
replay `{seq, existed: true}`, action-off cascade) and
`apps/openomni/test/delegation-policy.test.ts` (cap matrix fail-closed,
deadline wake cancel + parent prompt, typed wake failures).

## #1256 hook capability and hooks-json bundle (epic #1260, draft PR #1292)

Branch `epic1260/1256-hook-capability`, base `5362b3bd` (#1255). Shipped: the removable hook capability `packages/agent/src/plugins/hook` — `hookCapability()` is `Capability.define({name: "hook", requires: ["action"], seam: "@openomni/hook/Hook"})` with the single handler `hook/process` (`HOOK_PROCESS_REF`), and `process.ts` owns the one external hook surface: `acquireHookProcess` spawns one JSON-lines child process per acquisition Scope (one PID per distinct command per generation — the pool key is the command argv, so two rows with the same command share one child while `timeoutMs`/`maxLineBytes` ride each call; the Scope finalizer drains in-flight calls, stops the reader fiber, then kills the PID), multiplexes concurrent calls by request id, bounds every call with `Effect.timeoutOption` on the injected Clock, and returns the closed `HookOutcome` union `gate{verdict: allow | deny | require_approval} | rewrite{args} | observe | failure{code: "hook_timeout", cause: timeout | framing | exit}`; one malformed stdout line is a framing failure that poisons the process fail-closed — every in-flight call fails, the PID is marked dead and killed, later calls refuse (garbage cannot be attributed to one request or trusted afterwards); spawn refusal is the typed `HookSpawnError`; the plugin imports only `core/api.ts` and `Bun\.spawn|node:child_process` greps 0 under `packages/agent/src/core`. App side: `apps/openomni/src/bundles/hooks-json` compiles the Owner's hooks JSON file (config `hooksPath`, env `OPENOMNI_HOOKS_PATH`, read once in `index.ts` before any listener exists) into gate rows over the hook handler at the four mapped events — `PreToolUse→tool.pre`, `PostToolUse→tool.post`, `UserPromptSubmit→prompt.pre`, `SessionStart→session.open` — with row ids `hooks-json/<point>#<n>` at order 500+; an unmapped event key, unreadable bytes or an invalid shape refuse boot with the typed app invariant failure (no seventh compose code: the file is validated before compose; a missing hook capability still rejects `seam_missing` inside the closed set); the in-process `hooks-json/secrets-guard` rewrite transformer masks secret-shaped tokens and guard rows declare their rewritable `fields` (`UserPromptSubmit` defaults to `["body"]`, tool events declare explicitly, a `SessionStart` guard refuses at compile); a command entry may declare `do: "rewrite"` with its `fields`, compiling to a consult row with the protocol `rewrite` flag whose PREPARED consultant response the fold applies as a contained rewrite (a reply that is not a plain record within the declared fields folds to deny with one `incompatible_response` fact), and the live policy seed discriminates consultant refs from synchronous transformers so an external rewrite row seeds `consult{rewrite}`; command entries otherwise compile to consulted gate rows served LIVE through the hook consultant at all four points: the fold is fail-closed (a hook response incompatible with its row — e.g. a rewrite answering a gate — folds to deny with one recorded `incompatible_response` fact), a reply that lands after its call's deadline re-enters the session through the entity deliver door as a `hook.late` action row carrying its stale cursor (bounded late window, default 256), prompt-policy refusals fire at BOTH doors (turn start and the mid-turn run boundary draining steer deliveries), refusal errors are typed `AppInvariantError`s carrying machine-consumed codes — `AppInvariantError.code` is an OPTIONAL string field, so the code set is NOT closed at the type level; the hooks-json reader emits exactly `unmapped_event | not_json | unreadable_path | invalid_config | missing_rewrite_fields | session_start_rewrite`, and a gate row naming a synchronous kernel service as its consultant refuses at seed time. The manifest (`apps/openomni/src/manifest.ts`) grows the non-exported `action` capability (identity reduce over the protocol `action` declaration) as the hook capability's `requires` root: `off: ["action"]` cascades `hook` and `hooks-json`, `off: ["hook"]` cascades `hooks-json`, and a mid-session recompose journals `session.configure{operation: "compose", disabled: [{name: "hook", because: "hook"}, {name: "hooks-json", because: "hook"}]}` at the next turn start. Tests: `packages/agent/test/hook-plugin.test.ts` (scripted echo child, TestClock timeout, PID rotation proving child receipt via an ordered ack round-trip, death mid-call, split frames via an injected fake child with an exact chunk boundary, framing poison, spawn refusal, late rewrite/observe routing and late-window eviction; no sleeps) and `apps/openomni/test/hooks-json.test.ts` (row compilation incl. consult/observe seeds, typed refusal codes, secrets guard, off cascades, `seam_missing`, catalog policy seeding through real boot, the capability-removed one-turn gate with the journal chain byte-identical across two pinned runs, and the real-boot e2e set: prompt gate deny/allow decision rows, mid-turn steer deny at the run boundary, body and `bash.command` rewrites reaching model/executor, incompatible-response deny fold, the late `hook.late` row, and the one-PID-per-command pool with teardown kills). Measured at the r4 head: root and app check-types 0; root lint green; check-deps band ratchet 25 unchanged; check-dead-exports 0 new; check-written-types 0; check-journal-writers 12; check-effect-boundaries green; suites stable 5x each — hook-plugin 19/0, hooks-json 21/0, policy-seed-rows 3/0, stale-action-backlog 6/0, retryable-once 2/0; a manual real-run tool.pre denial (journaled deny decision + refused tool slot) is recorded in the lane evidence.

## #1257 fork sessions into verifiable chains (epic #1260, draft PR #1291)

On `epic1260/1257-fork-chains` (2026-10-05, base `3ccafed1`). `Core.forkSession`
(`packages/agent/src/core/fork.ts`) forks a parent session at a verifiable
boundary — exactly a `turn{terminal}` row, a `prompt` row, or a `compaction`
row (`signal` rows are NOT boundaries); any other anchor refuses
`anchor_not_boundary`, an unknown hash `anchor_not_found` — into a NEW session
file with its own hash chain. The
child genesis is `session.configure{operation: "fork", forkedFrom: {session,
anchor, parentSeq, parentHead, copied}}` (schema in
`packages/protocol/src/journal/core/session-configure.ts`), pinning the parent
head hash at fork time so both chains verify independently forever; a later
parent append never perturbs the child (`verifyChain` on both stays `intact`).
Copied rows keep their original ids except input rows and their
`<inboxId>:delivery` rows, which rename to `fork:<parentSessionId>:<id>` with
`inboxId`/`turnId` payload references remapped: consumed inputs stay consumed,
and replaying a pre-fork idempotency key against the child admits fresh. Exclusions: `alarm{arm}` rows and
`fold.checkpoint` are never copied — the child re-registers zero alarms while
the parent occurrence still runs, and a copied orphan `alarm{fired}` folds to
#1254's `skip{unknown}` (occurrence ids are minted from the parent session id,
so a child re-arm can never collide). The parent file's schema stamp
(`SESSION_FILE_SCHEMA_VERSION` via `PRAGMA user_version`,
`packages/agent/src/core/store/session-file/`) is probed read-only first; a
mismatch refuses `schema_version` with zero child writes. The copy cap is generation
configuration per the issue's "cap copied bytes in generation configuration":
`session.configure{settings.forkCopyByteCap}` is folded off the parent
generation like the consumption widths (`DEFAULT_FORK_COPY_BYTE_CAP` 4 MiB when
unset), and the app's resolved startup value (env `OPENOMNI_FORK_COPY_BYTE_CAP`)
is the input written into each new session's genesis settings.
`SessionStore.fork` appends genesis plus copies in one transaction; an existing
child id refuses `child_exists` leaving the first chain intact.

Ancestry and the aside are inspect projections only.
`packages/agent/src/inspect/tree.ts` exposes `forkAncestryOf` (reads the child
genesis pin), `forkAside` (the "Forked from session …" text), and `inspectTree`
(depth-3/limit-64 bounded tree over catalog `parentId` edges with continuation
cursors). `session_read` pages carry optional `ancestry {parentId, forkedFrom,
aside}` plus the optional fork `children` list (id + anchor + title where
known) the desktop renders as a clickable Forks list opening each child as a
bound local session, the `session_fork` gateway method + websocket frame land in
`packages/protocol/src/gateway/session-read.ts` / `packages/channels` /
`apps/openomni/src/composition/session-fork.ts`, and the desktop session header
renders the aside. `foldSessionHistory` never reads `session.configure`
intents, so the aside cannot reach model context or compaction; the only
promotion path is `forkAsideTransformer`, an opt-in `prompt.pre` gate handler
registered nowhere by default.

`receivedMessages` and its fold state (`foldReceivedAction`, `ReceivedEntry`,
`DeliverIntent`) are deleted — `rg -c 'receivedMessages' packages/agent/src`
returns nothing. The kernel reads inputs by SQL (`inputMessages` on
`Storage.ActionSubAdapter` and `SessionKernel`), and `run.ts` resolves a
prompt's origin by `actionById` point read. No new journal kind exists:
`rg -c 'kind: "session\.fork"' packages apps` returns nothing. Tests:
`packages/agent/test/store/session/{session-fork,fork-exclusions,inspect-tree,inspect-aside}.test.ts`
and the wire roundtrip `apps/openomni/test/session-fork.test.ts`.

## #1255 declarative capabilities and bundles (epic #1260, PR #1289, merged `5362b3bd`)

Branch `epic1260/1255-declarative-bundles`, base `77e1375b` (#1254). Shipped: the three declaration contracts `Capability.define` / `Bundle.define` (the `Bundle` namespace barrel's `define` = `defineBundle`) / `Manifest.define` in `packages/agent/src/core/capability.ts`, surfaced through `core/api.ts` and the root `Bundle` namespace (`packages/agent/src/bundle.ts` is now a 19-line re-export barrel); `compose(manifest) → Generation` in `packages/agent/src/core/compose.ts` is the one loader path and rejects exactly the closed six codes `requires_cycle | duplicate | product_declares_kind | seam_missing | unknown_handler | unknown_point` (the former `BundleError.namespace` refusal moved to define time); the `off` cascade (`requires` fan-out) is recorded on the existing writer as `session.configure{disabled: [{name, because}]}` with `ConfigureIntent.operation: "compose"` and no new journal kind; generations are recomputed from empty state on every manifest change and adopted by each session at its next turn start (`manifestHash` stamped on the configure row); the handler table of a composed generation is built once at compose and provided as the `GenerationHandlers` Context tag (`HandlerTable`/`createHandlerTable` in `core/gate/`; the `NamedPolicyRegistry` name greps zero); the three tool projections (`Tool.Spec`, `SessionGeneration.Tool`, the dispatch table) are derived once from the composed generation and `sessionTool()`/`toolSpec()` are deleted from `packages/agent/src`. App side: `apps/openomni/src/manifest.ts` declares the product manifest, `composition/composed.ts` holds the `ComposedGeneration` service the generation Layers read, boot composes the manifest and fails closed on a typed `ComposeRefused`, product bundles live under `apps/openomni/src/bundles/{monitor,cron}` (replacing `tools/monitor.ts` and the composition bundles, both grep zero), `provision{bundle_enable | bundle_disable}` recomposes the manifest with the four consent rows pinned, and `apps/openomni/test/monitor-bundle.test.ts` proves the monitor bundle end to end through `index.ts` wiring (restart fire, mid-turn disable, off at boot). D5: the tool-result split `content / details / structuredContent` lands as protocol owner fields in `packages/protocol/src/tool/result.ts` (`toolResultJsonSchema` bounded at 262,144 bytes, `toolResultText` the one fallback reader) and is consumed by eval and code mode (`composition/codemode.ts` maps `structuredContent` onto `ToolCallResult.value`; the cell door is typed-only). `script/check-deps.test.ts` ratchets the deletion tokens (`#1255 T5` records `@openomni/llm` at 0, already met by #1246). Recorded deviations: adoption bypasses `authorizeConfigure` (the manifest change is the authorized act; the per-session append is mechanical); `Generation` carries `inputs/capabilities/bundles/disabled` beyond the body's seven fields (needed by rotation and admission); protocol `Disabled` is `.readonly()`; `compose.ts` helpers split under the lint complexity cap; desktop/ui rendering of `details` and the gate `ToolBodyOutcome.output` name are follow-ups, not D5 consumers. Sweeps on the merged head: `rg --files apps/openomni/src | rg 'tools/monitor\.ts|composition/monitor-ports\.ts'` → empty; `sessionTool\(|toolSpec\(` in `packages/*/src` and `apps/*/src` → 0 (two app tests keep a local `toolSpec` helper); `BundlesLive|BundleDefinitions|bundlePolicyTag|NamedPolicyRegistry` → 0; `Bun\.cron\(` → 0; `Effect.succeed(true)` fail-open in `packages/agent/src` → 0; `approvalBindings` → 0. Lane-measured suites before the final gate: protocol 526/0, agent 1685/0, apps 658/0; the final gate chain is recorded in the PR.

## #1254 alarm split: core timer, removable alarm capability (epic #1260, PR #1285, merged `77e1375b`)

On `epic1260/1254-alarm-split` (2026-10-04, base `4ecb41f3`, merged with main
`c8ae79d4` at `277b3ce5`). The timer plane
is split in two. The core (`packages/agent/src/core/alarm.ts`, the `alarm`
kind's single declared writer) keeps the cluster `DeliverAt` message, exactly
four loop-reserved purposes (`step_watchdog`, `retry`, `deadline`, `resume`;
`RESERVED_PURPOSES` in `packages/protocol/src/journal/core/alarm.ts`), one
occurrence-id minter `Alarm.occurrenceId(sessionId, alarmId, armSeq, sourceKey)`
= `canonicalDigest(["alarm.occurrence", …])` minted from the arm row's own
journal sequence inside the committing transaction, and one chain guard
`alarmDisposition` (fresh iff the latest `arm` row still names the occurrence,
is not retired by `at: null`, and no `delivered|exhausted` firing settled it);
the per-purpose dispositions and `hasNewerAttempt` are deleted. The `alarm`
declaration is tightened to `arm{purpose, at, supersedes, alarmId, sourceKey,
payload} → effect{occurrenceId}` and `fired{occurrenceId, outcome:
delivered|stale|exhausted}`; an unregistered purpose folds to a recorded
`fired{stale}` fact with zero execution (`rpc-surface.test.ts`,
`alarm-chain-guard.test.ts`). The armed set is an index, not a second
truth: `armed_alarms(alarm_id PK, occurrence_id UNIQUE, fire_at)` lives in
the session-file schema and its delta is derived from the appended `alarm` row
inside the same `appendAction` transaction (an arm upserts, `at: null` and a
settling `fired` delete; a schema-refused row rolls the index back with the
row), read through the kernel ports `armedAlarms()`/`armedCount()`; the
catalog gains `session_index.has_armed` at `CATALOG_SCHEMA_VERSION` 2 (a v1
file upgrades in place in one immediate transaction; a newer file stays
read-only with `markArmed` in the refused set); activation re-sends every
armed row as its ORIGINAL occurrence id (the cluster dedupe key) and boot runs
`rescanOccurrences` over `has_armed ∪ idle ≥ idleDays` (`full` ⇒ all) as
`${sessionId}:rescan:${bootId}` (`alarm-recovery.test.ts`). The entity admits
through one queue writer (`Entity.toLayerQueue` + `Replier`): the revision CAS
is bounded at 3 attempts then fails typed `AdmissionFailure{code: revision}`,
queue close fails every queued envelope `AdmissionFailure{code: shutdown}`,
`Entity.keepAlive` holds the entity while a turn is open and `maxIdleTime` is
D3's `idleMs`, passivation with unconsumed input arms a `resume` alarm, the
fence is compared inside the session commit, and the four reserved purposes
are consumed by the loop (`retry`/`resume` wake the drain, `deadline` expires
its request iff still open, `step_watchdog` is reserved with no step budget —
nothing arms it; `admission-writer-fiber.test.ts`, `rpc-surface.test.ts`). The
removable capability `packages/agent/src/plugins/alarm/` imports only
`core/api.ts` (`AlarmCapability{purposes, wake → delivered|exhausted}`,
`AlarmWakeContext`, `ArmVerb`,
`ArmRefused{alarm_budget|unknown_purpose|reserved_purpose|not_live|stale_turn|stale_activation|revision}`,
`AlarmFired`,
`AlarmWakeOutcome`, `RESERVED_PURPOSES`) and owns the purpose registry
(`Core.composeAlarmPurposes` refuses the reserved four, the entity-internal
`rescan`, and duplicates with a typed `AlarmComposeError`), wake dispatch, the
`alarm.fired` point, the `watch(command|path)` handlers with budget and
exhaustion (a watch is an armed alarm `alarmId = watchId`, `sourceKey:
"monitor"`; re-arm = `supersedes`, cancel = `at: null`; timeout = a second
arm), and the `arm`/`watch` verbs. The app composes the capability in
`apps/openomni/src/bundles/alarms/index.ts` (chain fold, chain-guard reads,
typed prompt port; the app never commits an arm row itself — tool-facing arms
delegate through the live-activation registry to the entity's one committing
verb, bound at creation to the authorizing activation (a turn token alone
cannot distinguish recovery) and carrying the calling turn's token, with typed
refusals: `not_live`, `stale_turn`, `stale_activation` when the authorizing
activation is no longer live (including a fence-stale zombie commit), and
`revision` when the entity's bounded commit retry exhausts) behind two
bundles `composition/bundles/{monitor,cron}.ts` (each documents its
`requires: alarm` edge; the manifest/compose mechanics that enforce the
capability-off cascade land with #1255); `composition/monitor-ports.ts` and
`tools/core/monitor-ports.ts` are deleted, `composition/watch-sources.ts` is
the native source adapter and `tools/core/watch.ts` is epoch-free; the
hibernation e2e pins a native hit landing as a recorded chain fact. The
merge with main `c8ae79d4` (`277b3ce5`; #1271 brain host as machine `self`,
#1273 tmux `pty.session`) joins the terminal watch source to the
`ArmedWatch`/occurrence shape, makes the native install part of the `watch`
verb (the plugin's `WatchInstallDeps.install` is awaited after the arms commit
and before the verb returns, so a terminal subscribe is never interrupted by
the tool's `waiting` commit; a refused install retires the armed chain and
its timeout with reason `install` and surfaces `WatchRefused`), returns
`armSeq` from `ArmVerb`, binds the composed capability into the entity ports
(`alarmCapability`; before the bind every `monitor.hit`/`cron.tick` wake
folded to a recorded `fired{stale}` fact), and exempts `monitor.hit`
occurrences from the entity's `sendAlarm` time delivery (the installed native
source resends them with the hit; `monitor-app.test.ts` pins the second turn,
the alarm prompt, the `<occurrenceId>:delivered` row and the re-armed chain).
The armed budget bounds the index, so only an arm that adds a chain (non-null
`at`, no armed row for its id) consults `maxArmed`; a retire or a re-arm of an
armed chain commits at a full budget and a retire frees its slot
(`alarm-budget.test.ts`). Two activation-order defects surfaced by the
restart e2e (`request-owner-e2e.test.ts`, red 3/3 before, green 3/3 after)
once activations resend their armed occurrences and hold `keepAlive`: the
cluster host redelivers a crashed process's persisted messages as soon as it
starts, so a session activated before the composition root bound the entity
ports and the late-bound slot died typed — the ports now carry an optional
`ready` gate an activation awaits before its first port call
(`createSessionEntityPortsSlot` settles it at `bind`; the entity activation
yields it first; `rpc-surface.test.ts` parks an activation at the gate and
observes no port entry until release, `cluster-runtime.test.ts` pins the
slot's settle-at-bind). And the entity `Resolve` path committed the answer
but woke nobody: the turn that activation had recovered was parked on the
still-open request, the drain deferred to that live turn, and the app's
direct answer route (`notifyLiveApprovals`) never saw a turn that was not
live when the answer was dispatched — `requestCommand` now rings the optional
`onRequestReady(sessionId)` port after each committed transition (resolve,
cancel, deadline expiry) and the app binds it to `notifyLiveApprovals`, the
same doorbell the direct path rings; a refused transition stays silent
(`rpc-surface.test.ts`, `resolve-stale.test.ts`).
`Protocol.Cron.next(expr, fromMs, tz)` / `Cron.occurrences(expr, afterMs,
untilMs, tz, limit)` is a dependency-free Vixie grid over `Intl.DateTimeFormat`
zone math (DST gap skipped, overlap fires once, 366-day `unreachable` bound,
typed `CronParseError{code}`; `packages/protocol/test/cron-next.test.ts`), and
`monitor({kind: "cron", expr, tz})` is the entry (derived tool snapshot
regenerated: one added source variant, one description line). Assumed (Owner
ruling D3): loop consumption defaults — alarms before prompt 4, armed-alarm cap
64, passivation idle 60 s, `sweep{full: false, idleDays: 7}` — typed once as
`Core.AlarmDrainConfig`, values from `apps/openomni/src/config.ts`. Lead fixes
after the lane merge: `Protocol.canonicalJson` is the one canonical byte owner
for persisted text payloads (alarm payloads, message origins), so the stored
bytes and the digest minted from them agree; the live-wait fold `openAlarmIds`
(`core/run.ts`) folds by `alarmId` (latest arm wins, `at: null` retires, a
`fired` for the armed occurrence settles) and excludes the reserved purposes,
so a settled chain or a request deadline is not live-wait evidence;
`SessionHistory.Cause` drops its `{kind: "alarm", alarmId, epoch}` variant
(no producer after the per-purpose scheme left; a read-model DTO, never
persisted, so no ledger-fold upcast exists) and
`script/conformance/schema-snapshot.json` is regenerated — one removal
(`SessionHistory.Cause#alarm`) plus the additive drift main accumulated since
#1247, this PR being the `--update` review moment. Deviations: the timer
module keeps its file name `core/alarm.ts` (it is the kind's declared writer;
the issue's `core/timer.ts` would rename the writer for no behavior); cron
enters through the sealed 12-tool catalog as `monitor({kind: "cron", expr,
tz})` instead of a new tool; only the `monitor` and `cron` bundles exist (the
issue's `reminder`/`compaction-timing` bundles have no consumer and would be
dead code; the seed `bundles/alarm.ts` was deleted as an unconsumed export);
the `armed_alarms` delta is derived inside the append transaction from the
appended row rather than supplied by the caller; the `alarm` declaration stays
`version: 1` (no deployed journals exist, a v2 with no v1 reader is dead
code); `step_watchdog` is reserved-and-refused only (no step budget exists in
the loop). Pre-existing flakes met and recorded: in a combined
`bun test packages/agent packages/protocol` process Bun 1.4.1 intermittently
materializes `new Error().stack` as `undefined` with `Error.stackTraceLimit`
intact, so `Failure.pretty` now renders `name: message` whenever `stack` is
not a string (`failure-of.test.ts` reproduces it with `Error.stackTraceLimit =
0`); the `watch-sources` native path-create signal timed out once (15 s)
inside a full app run and passes alone — test and `pathSource` logic are
identical on main (an `fs.watch` create race, not changed here); the
`durable-reconstruction` fresh-process tests fail with `Cannot find module
'@openomni/protocol'` when root `check-types` emits `protocol/dist`
concurrently — gates run serially. Sweeps at HEAD: `hasNewerAttempt` 0,
alarm-scoped `epoch` 0, `Bun\.cron\(|alarm\.cancel` 0,
`monitor-ports|watchOccurrenceKey|watchTimeoutKey|:occ:` 0; one writer for
`alarm` (`script/check-journal-writers.ts`). Deferrals: capability manifest /
`requires` cascade mechanics with recorded reason and the `action` writer land
with #1255.

## #1053 machine plane epic landed (six children, 2026-10-03/04)

The machine plane moved from a localhost Unix-socket endpoint frozen at 2026-08-24 to a network-attachable WHERE with persistent terminals, computer use and browser use, all reached through the existing twelve-tool catalog and code-mode handles; no new model tool was added. Children, in merge order: #1272 code mode extracted into `packages/codemode` (`3e36a657`, PR #1280); #1274 `screen.read`/`input.write` via macOS shell-out (`a004bdb0`, PR #1282); #1270 TCP transport with host-certificate chain validation + SPKI pin and automatic reattach (`76598609`, PR #1281); #1271 brain host attaches as machine `self`, local execution path removed from the tools (`a66dc3a7`, PR #1284); #1273 persistent `pty.session` terminals over tmux with `bash{session}` (`a1a3de0f`, PR #1283); #1275 `browser()` over CDP inside a `pty.session` (`05bb44dd`, PR #1286). Each child merged after CI all-green and an independent line-level review with zero High/Medium findings; real-surface evidence (attach transcripts, restart/reattach logs, typed refusals, screenshot bytes) is attached to each child's closing comment. Not claimed: native computer use (#887), media streaming, sandbox/egress hardening (#950), cli contact (#1180), embedded desktop browser (#1023). Open design decision recorded on the epic: host-side chain validation of daemon certificates (today the listener judges the daemon key against enrollment at handshake).

## #1275 browser automation recipe: browser() over CDP in a pty.session

On `machines/1275-browser-recipe` (2026-10-03, draft PR #1286). The codemode
Python prelude gains `browser(machine_id, *, headless=True, profile_dir=None,
executable_path=None)` returning a thin `BrowserClient` around Playwright's
`connect_over_cdp`; Chromium runs persistently in a cell-owned tmux
`pty.session` (name `openomni-browser-<sha256(profile)[:12]>`), with the CDP
port probe-bound from 9222 and port + pid retained in the session output.
Profile dirs are export-confined via the existing `openCwd` rule
(`path_escapes_export` before launch); loss at any client accessor raises the
typed `browser_lost` refusal with the captured tmux output; a missing
executable refuses typed naming the path and install command and tears the
launch session down. No new capability id, wire method, or model tool.
`PythonKernel.close()` is EOF-first (bounded grace before hard discard) so the
driver's cleanup stops each client's browser process. Recipe documented in
`docs/machines-and-delegation.md` section 2.7; end-to-end tests in
`packages/codemode/test/codemode/browser.test.ts` run real tmux + Chromium.
Close-race fix (fix/1275-browser-close-race): `pty_close` removes the daemon
record when the session's shell already exited on its own (the launch line
exits once Chromium stops), and is fail-closed otherwise: a `kill-session` or
`kill-window` failure is re-checked against the server and propagates (record
kept) unless the session/window is confirmed absent. Interpreter `close()`
sends stdin EOF and waits on the driver's explicit `browser-cleanup-complete`
ack (bounded 2s) before cancelling any active cell, so an in-flight cell can
no longer bypass the witness through the cancellation discard path; an
unacknowledged teardown (idle or wedged-cell) fails typed instead of
resolving as success. Nothing writes to the driver after that EOF: a tool
answer or request racing close() becomes a typed refusal instead of a stream
write, and asynchronous stdin errors land in the typed driver-failure path,
so a normally resolving tool callback can no longer crash the process with
`ERR_STREAM_WRITE_AFTER_END`. Caveat: `BrowserClient.close()`
itself still swallows pty `ToolError`, so its successful return alone does not
prove the session record is gone on failure paths - the listing guarantee
belongs to `pty_close`'s `ok`. The interpreter-close test awaits the shell's
`chromium-exited` reap line instead of assuming the pid is unprobeable the
instant `close()` resolves.

## #1273 persistent terminals: pty.session over tmux

On `machines/1273-pty-session` (2026-10-03, base `a004bdb0`, draft PR #1283).
The machine protocol gains the `pty.session` capability and six wire methods
`machine.pty_open/pty_write/pty_read/pty_resize/pty_close/pty_list` with
strict bounds (`PTY_READ_MAX_BYTES` 256 KiB, `PTY_WRITE_MAX_BYTES` 16 KiB,
`PTY_LIST_MAX_SESSIONS` 1000, cols/rows <= 1000, read `waitMs` <= 30 s long
poll) and typed refusals `pty_not_found`/`pty_not_available`/
`path_escapes_export`; `machine.pty_output` is a reserved wake-up
notification, never output authority. The daemon adapter
(`packages/machines/src/pty.ts` + `pty-control`/`pty-decode`/`pty-registry`)
runs one `tmux -C` control client, decodes octal-escaped `%output` into
per-session cursor streams (opaque `p1:<generation>:<offset>` tokens, replay
= `capture-pane -S -` snapshot then live bytes, no duplicates, over-cap reads
return the bounded suffix with `truncated: true` and advance past all
observed output, 1 MiB live retention), confines `pty_open` cwd under the
exec `openCwd` rule before any session exists, reattaches same-name opens,
links session windows into the reserved `omo-pty-control` session, and
rediscovers sessions by name after a daemon restart (the tmux server owns
session lifetime). Server death marks sessions `lost`, settles pending reads
`pty_not_available`, and withdraws the capability until the next attach
probe. Host handles gain `pty` (`src/pty-host.ts`, one routed-call seam);
code mode exposes `m.pty(name).open/write/read/resize/close` and
`m.ptyList()`; the sealed `bash` tool gains optional `session` (per-session
cursor state inside the tool, empty command = read-only drain) and `monitor`
watches a named terminal without closing it. Tests: protocol machine suite,
real-tmux adapter suite on a private socket (`packages/machines/test/pty.test.ts`),
attach offer gating + enrollment withhold + export refusals, and app-door
e2e including a daemon restart over a live tmux server.

## #1253 four session entity RPCs (epic #1260, merged as `4ecb41f3`, PR #1279)

On `epic1260/1253-four-entity-rpcs` (2026-10-03, base `58b7f18d`). The session
entity's outside surface is exactly four RPCs in
`packages/agent/src/core/messages.ts` — `deliver`, `resolve`, `alarm`, `read`
— handled in `core/entity.ts`. `deliver{kind, body, source, idempotencyKey}`
is the one input door: the kind is checked against the activation's input
registration table (core registers `prompt` and `signal`; `action` arrives
with its capability, #1255), a blank key is a typed `missing_key`, a replayed
key resolves to the original seq as success (`{seq, existed: true}`) with zero
new facts (`deliver-idempotency.test.ts`), and a refused admission is a typed
`denied` rejection that appends nothing — never a success ack
(`entity-admission-refusal.test.ts`). `resolve{requestId, outcome, payload,
inputId}` settles one request: a missing request is `unknown_request`, a
settled one `already_resolved`, both with zero new facts, and a redelivered
`inputId` replays the recorded resolution through the pure request authority's
dedup (`resolve-stale.test.ts`). `alarm` carries one `AlarmOccurrence`
(cluster PrimaryKey = `occurrenceId`, DeliverAt = `fireAt`): an applied
occurrence drives the chain-guarded fold and wakes the loop; a superseded one
is recorded as an `alarm{fired, outcome: stale}` fact — a fact, not a
rejection (`rpc-surface.test.ts`). `read{model, cursor}` is the fourth RPC and
deliberately not cluster-persisted: nine models (`history`, `decisions`,
`requests`, `alarms`, `generations`, `tree`, `metrics`, `control`, `outbound`,
`packages/agent/src/core/read.ts`) are pure paged projections over the
journal fold covering all 12 public kinds with `fold.checkpoint` excluded by
construction (`inspect-renderers.test.ts`); the app `session_read` surface
stays thin and `attemptUsage` is byte-equal to the fold DTO
(`gateway-frame.test.ts`). Consumers switched: the gateway inbox commits
through `deliver` (interrupt/resume as `signal` + control op,
`apps/openomni/src/composition/message-session.ts`), out-of-turn answers
through `resolve`, and watch fires, watch timeouts and request deadlines
through `alarm` occurrences (`apps/openomni/src/index.ts`). The nine legacy
RPCs (`Prompt`/`Interrupt`/`Resume`/`RequestResolve`/`RequestCancel`/
`RetryScheduled`/`Deadline`/`WatchFired`/`WatchTimeout`), the `receive` and
`timerWake` handler bodies and the `driveInbox` name are deleted; the four
issue sweeps (`RetryScheduledRpc|DeadlineRpc|WatchFiredRpc|WatchTimeoutRpc`,
`timerWake`, `cluster/timers`, `driveInbox`) grep to zero. The cluster host
takes `SqlClient` and `Crypto.Crypto` as injected layers
(`apps/openomni/src/composition/cluster-runtime.ts`); a deterministic Crypto
layer hosts the full deliver round-trip (`deterministic-crypto.test.ts`).
Boundary consumption (C2): inputs are consumed at loop boundaries only —
`steer` at `after_tools` and turn end, `followUp` at turn end — with widths
from the latest `session.configure` settings and consumed seqs recorded on the
turn checkpoint (`boundary-consumption.test.ts`). Deviations: the queue
table/drain were already fold-based since #1252; the keyless-frame
`missing_key` refusal shipped with #1245; the kernel timer imports were
relocated by #1276 (only two comment tokens remained to sweep); dedup is
two-layer (cluster envelope replay is byte-identical for the same envelope,
the handler returns `{seq, existed: true}` for keys already on the journal).
Deferrals: the `action` writer and `turn.consumed.stale` land with #1255;
alarm purpose registration/occurrence ownership with #1254.

## #1274 macOS computer use: screen.read / input.write

On `machines/1274-screen-input` (2026-10-03, base `3e36a657`, draft PR #1282).
The machine protocol gains `screen.read`/`input.write` capabilities with wire
methods `machine.screen_read`/`machine.input_write` and bounded schemas
(`SCREEN_PNG_MAX_BYTES` 4 MiB, `SCREEN_AX_MAX_BYTES` 256 KiB,
`INPUT_MAX_ACTIONS` 32, `INPUT_MAX_TEXT_CHARS` 10k; the accessibility tree is
bounded JSON, not `unknown`). `packages/machines/src/computer-use.ts` is the
macOS adapter — `screencapture`/`sips`/`osascript` (JXA)/`cliclick` behind the
injectable `CommandRunner` port in `src/commands.ts` (argv spawn, no shell,
256 KiB cap) — owning attach-time probes (screen = tiny real capture, input =
cliclick on PATH + Accessibility grant; failing probes withhold the offer and
mid-session failures re-probe and withdraw), a per-display point-bounds cache
(regions and coordinates refuse `invalid_region` before any command),
`sips -Z` downscaling to the PNG cap (never truncation; unfittable refuses
`capture_failed`) and the latest-capture registry (`input.write` with any
other capture id refuses `stale_capture` before executing). cliclick 5.1 has
no middle-click/scroll: both refuse `unsupported_action` while staying in the
protocol vocabulary. daemon.ts only registers the two wire handlers and the
attach probe filter; host handles gain `screen`/`input`. No model tool: code
mode exposes `m.screen()`/`m.input(actions)` (Python remembers the last
captureId) and SDK handle `screen/input`; `codemode.screen` is query-class in
the app composition. Tests drive host+daemon over the real socket wire with a
recorded fake runner (probes, crop offsets, downscale, every refusal,
withdrawal) plus an opt-in real-surface capture test
(`OPENOMNI_REAL_SCREEN=1`).

## #1272 code mode extracted into packages/codemode (reverses part of #1246)

On `machines/1272-codemode-package` (2026-10-03, base `58b7f18d`). The
repository has six packages: `packages/codemode` (`@openomni/codemode`, deps
`@openomni/protocol` + `@openomni/machines`) now owns the reusable
Python-backed cell runtime shared by the application host and the machine
daemon — `createCodemode`, machine object handles, one lazy `PythonKernel` per
tenant, the cell registry and `cell.run/peek/stop`, the Python prelude
(`parallel`, `completion`, `tool.<name>()` proxies),
`listMachines`/`getMachine`/`findMachine`, `CodemodeError`/`DriverFailure` and
`decodeCodeFailure`. The move is behavior-preserving: the public shape of
`createCodemode` is unchanged and no configuration keys, capability ids, wire
methods, or refusal reasons were added. `packages/machines` keeps transport
and device access and exports the structural contracts code mode consumes
(`CodeRunner`, `MachineHost`/`MachineHandle`/`MachineInfo`, `onAbort`,
`machinesFallback`); its barrel no longer re-exports `./codemode` and
`git ls-files packages/machines/src/codemode` is empty. The daemon CLI
(`apps/openomni/src/cli/machine.ts`), app composition
(`src/composition/codemode.ts`), eval tool and all code-mode tests import
`@openomni/codemode` directly; application policy, completion budget, ledger
and model rendering stay in the app. `script/topology.ts` carries the
`codemode` row (own CI test + coverage lane, knip workspace, tsconfig
verification); the app allowlist gained `@openomni/codemode`.

## #1252 twelve journal kinds (epic #1260, merged as `58b7f18d`, PR #1278)

On `epic1260/1252-journal-kinds-12` (2026-10-04, base `6a9063d7`). The journal
kind set is closed at 12 — nine core (`prompt`, `signal`, `turn`, `llm`,
`message`, `session.configure`, `policy.decision`, `request`, `alarm`) plus
three capability (`tool`, `compaction`, `action`) — each declared
`{kind, version, schema}` with one writer in
`packages/protocol/src/journal/{core,capability}/` and fixed by
`packages/protocol/test/kind-census.test.ts`. Retired kinds and their readers:
`reply` → `request{phase: answered}` (lifecycle phases
`open|answered|resolved|expired` via `lifecyclePhase`, answered-request SQL and
inspect read phases; channels' reply decision is `answer` over the same rows —
the reply-grant store keeps only claim/listLive, no answer lookup);
`attempt` → `llm` rows pinning their ordinal in the intent (`attempt: n`),
with metrics/model-pin SQL/crash tests discriminating on the ordinal or durable
`usageProvenance`; `inbox.deliver` → `prompt`/`signal` delivery rows
(`effect.phase: "delivery"`; control admissions interrupt/resume are `signal`);
`outbound` → `message{op: open|ack}`; `alarm.arm`/`alarm.fired`/`alarm.paused`
→ one `alarm` kind (`op: arm|fired`, fired outcome
`delivered|stale|exhausted` with `via` provenance for cancel/paused/timeout).
Writes are fail-closed: `appendAction` validates every row body against its
kind's declaration schema (`Journal.declarationFor`) and refuses the whole
commit with the typed `SchemaRefused` — nothing partial lands
(`journal-fail-closed.test.ts` pins row count and hash head) — and entity
admission runs `Journal.admitInputKind`, rejecting capability-off input kinds
as `unknown_kind` (`packages/agent/src/core/mailbox.ts`). One writer module
per kind is enforced by `script/check-journal-writers.ts` (registered in CI
next to `check-written-types`; a planted second append site for a kind fails
the script). Reads degrade on every read port: a row that fails decode emits
exactly one `journal.corrupt{seq, kind, reason}` observation; the fold
(`range`) keeps it as opaque while the projection ports
(`decodeOne`/`decodeRows`: requestById, turnTailPage, outboundsPage, lastChat,
pendingMessages, messagesFor and the rest) skip it and still answer — one bad
row never blocks session load or an inspect read
(`journal-corrupt-degrade.test.ts`). The catalog stamps a schemaVersion into
`PRAGMA user_version` at create; a catalog whose marker is greater than the
build's version opens read-only — reads work, Deliver (fence rotation) and
fork (session indexing) are refused with the typed `CatalogVersionRefused`,
and the file bytes stay identical (`old-session-readonly.test.ts`). `prompt`
and `action` declare `delivery: steer|followUp` (default `followUp`,
`input-admission.test.ts`); the gate emit set is
`message | alarm{arm} | compaction`. The six retired-kind searches in the
issue grep to zero across packages and apps. Deviations: only
`delivery: "followUp"` is produced in this PR — the `action` kind's writer,
`steer` production, `action.after` consumption and the `turn.consumed.stale`
closure (acceptance test `stale-action.test.ts`) are declared and
census-tested here and land with #1255, which builds the action capability
plugin (#1253 owns the `deliver` RPC that refuses unregistered `action` rows
`unknown_kind`); the catalog policy-table CHECK keeps
`inbox.deliver`/`alarm.fired` tokens because the #1251 legacy point mapping
still converts those historical rows; policy point ids (e.g. the
`alarm.fired` hook point) are point names, not journal kinds, and stay
unchanged.

## #1276 one core, five plugins (epic #1260, merged as `6a9063d7`, PR #1277)

On `epic1260/1276-core-plugins-move` (2026-10-03, base `66d56edb`).
`packages/agent/src/{kernel,session,store}/` merged into one `src/core/` by
`git mv` (store under `core/store/`; 61/63 moves detected as renames at
R095-R100, the two directory barrels merged into `core/index.ts`); changes
beyond import lines are the composition seams below. Exactly five plugin
directories under `src/plugins/` — `alarm`, `action`, `hook`, `compaction`,
`tool` — and `plugins/compaction` imports only `src/core/api.ts` (the one
plugin-facing core surface) plus `@openomni/protocol`. The product
compositions `parent-reply/` and `model-selection.ts` moved to
`apps/openomni/src/composition/` and enter through new optional core seams
(`ChatAgentConfig.restoreModelSelection`, `SessionChatRunnerOptions.pinnedModel`,
`SessionRuntime.parentReply`) wired in `resident.ts`/`index.ts`/
`process-entry.ts`; `attemptRouteChange` stays private inside
`core/gate/decide.ts` (gate evidence, not a product choice). The root barrel
exports five namespaces (`Core`, `Bundle`, `Model`, `Inspect`, `Testing`) and
the unchanged pinned S8 named-export perimeter. `script/check-deps.ts` gates
the five-band table with three new edge checks — core→plugin banned,
plugin→sibling or non-api core banned, apps→agent internals banned
(`appsAgentInternalViolations`) — each with fail-before tests in
`script/check-deps-agent-bands.test.ts`; the band ratchet is re-keyed to the
new paths with TIGHT pins (review r3: every pin equals the file's HEAD actual
count, a pin above the actual fails closed) — band ratchet 25 at HEAD with
tight per-file pins; the pre-move tree measures 45 under the same classifier,
of which 16 were plugins/compaction imports now routed through core/api and 4
were product-choice edges the move removed (see the reconciliation receipt);
the gate prints the computed total.
Deviation from the issue body: the app did NOT already compose
parent-reply/model-selection — core called them directly at four sites — so
the seams above were added (~10 lines) beyond import-line-only.

## #1251 fourteen-point gate registry (epic #1260, merged as `66d56edb`, PR #1269)

On `epic1260/1251-point-registry` (2026-10-03, base `d34218c6`). Unknown hooks
no longer pass: `packages/protocol/src/policy/point.ts` defines fourteen
`{id, owner, allowedDo, rewritableFields, whenFields}` point records — eight
core (`ingress.pre`, `session.open`, `prompt.pre`, `turn.pre`, `turn.post`,
`llm.pre`, `llm.post`, `message.pre`) and six capability points present only
while their owning builtin is composed (`tool.pre/post`, `compaction.pre/post`,
`alarm.fired`, `action.pre`) — plus the emit allowed set
`message | alarm.arm | compaction`. `row.ts` is the single gate-row contract
(`{id, on, when, do, how, order, generation}`), the decision/consulted/fact
records, the `emittedRowKey` idempotency digest, and the #1255 compose
rejection codes. `packages/agent/src/kernel/points.ts` composes the merged
core+capability table (`composePointTable`; duplicate registration and core
removal are typed `GateComposeError`s) and `executionPoint` is the one lookup
executor and monitor consult — the issue's `core/…` paths map to the #1247
kernel shape (`core/points.ts` → `kernel/points.ts`, `core/gate/compile.ts` →
`kernel/gate/compose.ts` beside the existing row compiler). `compose.ts`
compiles rows fail-closed (`unknown_point` including off-capability points,
`unknown_handler`, `duplicate`, `bad_action`/`bad_field`, `post_end_emit`),
folds deny > require_approval > allow recording every matched row id, applies
rewrites only through declared fields in row order, guards handler service
requirements (an escape records a `requirement_escape` fact and denies), keeps
unrecorded responses observe-only, and replays an identical decision from a
recorded inputHash. Boot derives the latest catalog generation once
(`assertPointGenerationRows` inside the policy-seed derive): historical bytes
are untouched and an unmappable row rejects boot transactionally. The
executor fails closed (`unknown_point`) on unregistered points, prompt and
message have no post consultation, compaction consults `compaction.pre/post`
(the seeded mandatory row moved there), and `policyPoint(`/`row-compiler`
grep to zero; the kernel ledger/llm/timers import baseline shrank from
20 lines/11 files to 1 comment line (#1255 deletes it). Suites:
point-registry, gate-fold, requirement-guard, builtin-seal, decision-replay,
permission-row-migration (byte-preservation over a real SQLite catalog), plus
the apps boot-rejection test.

## #1249 observation bus on Effect PubSub/Stream (epic #1260, merged as `4978236b`, PR #1268)

On `epic1260/1249-bus-pubsub` (2026-10-02, base `d34218c6`, #1248's merge).
The manual-subscriber observation bus is replaced by an app-owned Effect
PubSub: `packages/agent/src/session/bus.ts` builds one unbounded `PubSub` per
owning Scope (`makeObservationBus`), publication is synchronous, nonblocking
and lossy (`PubSub.publishUnsafe`; observations are never journal-durable),
and subscribers are Streams (`bus.observations` / `bus.stream(event, match)`)
or callback drains forked on a bus-scoped `FiberSet` — closing the owning
Scope shuts the PubSub down and interrupts every drain, so overlapping
generations unsubscribe independently at Scope closure. The kernel
`ObservationSink` port is unchanged; `observationBusLayer` provides it as a
Layer. The app mounts the root bus in the runtime's own Scope
(`apps/openomni/src/runtime.ts`; injected fixture sinks mount as
`Layer.succeed`) and builds one bus per generation inside the generation
Layer's Scope with a finalizer that gates publishes off before shutdown
(`apps/openomni/src/composition/generation-layers.ts`); root fan-out and
`active` gating semantics are preserved. A throwing callback subscriber is
caught per element, logged on the subscriber's own fiber as a typed
`ObservationSubscriberFailure` via `Effect.logError`, and never blocks the
publisher or ends the subscription; scoped-sink delivery failures keep the
#1244 failure-as-data contract (`observation.delivery_failed`). No new Effect
runner sites: the bus publishes with `publishUnsafe` and forks through
`FiberSet.makeRuntime` inside its own Scope; test fixtures (agent `testBus`,
app `Bus`, channels `Bus`) are PubSub-backed and constructed through each
package's named runner owner. `createObservationBus`, `withIsolation`, the
two `queueMicrotask` fan-outs and the `AsyncLocalStorage` isolation store are
deleted to grep zero; `newTraceId` already rode injected entropy
(`packages/channels/src/support/trace.ts`), unchanged. The deleted manual-bus
suite (`packages/agent/test/observation/bus.test.ts`, 7 tests) is superseded
by four Deferred/state-signal suites under `packages/agent/test/session/`
(8 tests: PubSub delivery + Scope closure, Layer-provided sink, generation
rotation, typed subscriber failure). Found en route: dropping the microtask
hop makes interrupt commits durable one boundary earlier, so
`session-wave-e2e` pins the `after_tools` drain boundary.

## #1248 channel timers on Effect Schedule/Fiber/Deferred (epic #1260, merged as `d34218c6`, PR #1267)

On `epic1260/1248-channels-effect` (2026-10-02, base `0ebef4b0`, rebased onto
#1250's merge `9b4e4b8c`). Every channel-driver timer is an Effect program on
an injected runtime: drivers compose Effect values and the app supplies the
one runner port (`EffectRunner` in `packages/channels/src/types.ts`, bound to
`runAppEffect` in `apps/openomni/src/index.ts`). `setTimeout(`/`setInterval(`/
`new Promise(`/`calculateBackoff` grep to zero in `packages/channels/src`.
One shared reconnect policy (`src/support/schedule.ts`): exponential from 1s
capped at 60s via `Schedule.min` (this pin has no either combinator), ±20%
jitter, and a 10-attempt supervisor bound. One close starts ONE retry streak
(`src/support/socket-shell.ts`): `Effect.retry` raced (`Effect.raceFirst`)
against a halt `Deferred`, so `stop()` interrupts mid-backoff; exhaustion is a
typed dead shell that publishes `reconnectFailed` and drops sends — generation
counters are deleted, custody is fiber interruption and AbortController
identity (Telegram poller). `fetchWithRetry` is `Effect.retry` with at most
three attempts honoring 429 retry-after; the Discord heartbeat is an
`Effect.delay`/`Effect.forever` loop whose missed-ACK watchdog closes with the
resume-safe code; the process reply wait is `Effect.timeoutOrElse` on the app
runtime clock (`apps/openomni/src/composition/process-replies.ts`). Uncertain
deliveries stay `unknown`, are never resent, and now publish one Owner-visible
Warn per physical attempt (`src/support/deliver.ts`). Tests drive the fake
clock through per-test `ManagedRuntime(TestClock.layer())` helpers (the named
runner owners); new suites: backoff-schedule, socket-shell-interrupt,
heartbeat-watchdog, poller-interrupt, process-replies-timeout,
supervisor-bounce, unknown-no-resend. Found en route: Effect v4 `Effect.race`
resolves with the first SUCCESS, so racing a failable wait against a halt
Deferred hangs on failure — every such race uses `Effect.raceFirst`.

## #1247 agent package reorganized by responsibility (epic #1260 P5, merged as `a5ee6c4d` (PR #1266))

Superseded by #1276 (receipt at the top of this file): the seven directories
below merged into one `core/` (store under `core/store/`), the namespaces are
now five, and `parent-reply`/`model-selection` live in
`apps/openomni/src/composition/`. Paths in this receipt are the #1247 state.

On `epic1260/1247-agent-dirs` (2026-10-02, base `9b4e4b8c`, merged as `a5ee6c4d`, PR #1266). `packages/agent/src`
had exactly seven directories plus `index.ts`: `kernel/` (turn loop, gate,
tool dispatch, ports, failures), `session/` (entity, run, mailbox, request,
bus, commit, alarm), `store/` (fence, session-file, storage adapters),
`model/`, `plugins/` (compaction, model-selection, parent-reply), `inspect/`
(history, index) and `testing/` (registry, controller — the session registry
and `requireCommit` are test-only). `index.ts` exports seven namespaces (`Kernel`,
`Session`, `Bundle`, `Journal`, `Model`, `Inspect`, `Testing`) plus the pinned
nine-name S8 perimeter consumed by `packages/channels` (legal channels -> agent
band edges; no lane owns retiring it); `script/check-deps.ts` fails if the pin grows or changes. The legacy
timer and lease vocabularies are renamed to the alarm and fence names on TS
surfaces only — the durable SQLite columns stay `lease_owner`/`lease_fence`
byte-identical. The old flat controller module and `core/settled.ts` are
deleted; the issue's retired token families (the timer-port pair, the
camel-case lease trio, the flat controller module name, and the registry
symbol outside `testing/`) grep to zero across packages/apps/script/docs
(see the lane report for the literal commands). Intra-agent imports are banded
(kernel→session→store…) with a shrink-only ratchet in `script/check-deps.ts`.

Measured deviations, accepted by the Owner
([PR #1266 comment](https://github.com/INONONO66/openomni/pull/1266#issuecomment-5951852779)):
`kernel/` measures 6,090 LOC against the issue's ≤4,200 target — the issue's
own routing table places `gate/decide.ts` in `kernel/`, and the size shrink is
deferred to #1251/#1255, not re-planned in this lane. The band-ratchet
baseline is 36 violations across 15 files against the issue's 20/11 estimate —
20/11 was measured at `f7e36984`, before #1246 folded policy/ledger/llm into
`packages/agent`, so those edges were cross-package imports there and are
intra-package band edges now; the baseline is pinned shrink-only, every surviving
entry is a pre-existing edge (one scanner hit on a lane-written comment was
reworded away in review r1), and the provenance table is in the lane evidence.

## #1259 slop cleanup band b1: protocol core and gateway tests (epic #1260)

Band b1 of the #1259 cleanup ladder landed on `epic1260/1259-b1-protocol`: thirteen protocol items fixed (dead `NamedError.Unknown`, `Tool.Events.PermissionDenied` and `Operational.envelope` deleted with their tests, four stale/false doc comments rewritten, zod-4 `code: "custom"` spelling unified, redundant `EpochMs.nonnegative()` dropped, hand-rolled test try/catch patterns replaced with `.toThrow()`, `const it = test` aliases removed, the author's personal path replaced in the `SurfaceKey` fixture and doc example), three kept with rationale, two deferred (154 to the channels band, 145 `Inbox.Port` to #1258's `ledger/l0.ts`); receipts in the `docs/SLOP.md` §L row.

## #1250 model and desktop unified on AI SDK 7 (epic #1260, merged as `9b4e4b8c` (PR #1265))

On `epic1260/1250-ai-7` (2026-10-02, base `0ebef4b0`). `packages/agent` and
`apps/openomni` pin `ai@7.0.93` (the exact desktop version) with provider
majors 4 (`@ai-sdk/anthropic@4.0.49`, `@ai-sdk/openai@4.0.60`, both resolving
against the same `@ai-sdk/provider@4.0.10`); no ai 6 or provider-utils 4
resolution remains in `bun.lock`, whose diff is the ai dependency closure (the
`ai`/`@ai-sdk` entries plus the transitive keys they drop or re-resolve). The model plane uses `isStepCount`, passes
the system prompt as `instructions` (a `SystemModelMessage` carrying the
Anthropic cache breakpoint), and reads the nested
`inputTokenDetails`/`outputTokenDetails` accounting; the v6-only flat
cached-input usage alias is gone. One shared 7-signature ai test mock
(`packages/agent/test/model/helpers/ai-mock.ts`) replaces the three copies;
`model-stream-v7`, `usage-v7`, and `max-retries-zero` pin stream-event order,
nested token totals, and the `run()` boundary around retries: one `streamText`
call per attempt, handed `maxRetries: 0`, with the failed attempt surfacing as
a typed failure (the mock replaces `streamText`, so in-SDK retry suppression
itself is the SDK's `maxRetries` contract, not re-proved here). SDK retries,
tool approval, runtime contexts, and default AI Gateway routing stay off. Desktop pins (`ai@7.0.93`, `@ai-sdk/react@4.0.96`) are
untouched; the desktop boundaries recompile and their transport/session tests
pass unchanged.

## #1246 ten packages merged into five (epic #1260 P4 after #1245, merged as `0ebef4b0` (PR #1264))

(Historical receipt; #1272 later re-extracted code mode into `packages/codemode`, making six packages.)

On `epic1260/1246-packages-10-5` (2026-10-02). The repository has exactly five
packages plus two apps; the retired directories and their package names grep to
zero everywhere, including scripts, CI, and docs.

- **Package list.** `packages/protocol` (schemas and pure folds, no deps),
  `packages/agent` (durable-session kernel; absorbs the former policy engine at
  `src/kernel/gate/{compile,match}.ts`, the durable store plane at `src/store/`
  with SQLite adapters under `src/store/storage/`, and the model plane at
  `src/model/`; depends on protocol), `packages/machines` (raw machine
  endpoints; absorbs the ipc transport at `src/ipc/` and the code facade at
  `src/codemode/`; depends on protocol), `packages/channels` (drivers +
  perimeter router; absorbs the channel-facing stores — actor, blacklist,
  channel-grant, reply-grant, egress, provisioning/vault — at `src/store/`;
  depends on protocol + agent), and `packages/ui` (data-blind design system,
  no deps). `apps/openomni` composes protocol/agent/machines/channels;
  `apps/desktop` sits on protocol + ui.
- **Wiring.** Everything external imports through each package's one root
  barrel; no re-export file exists at any old package path. `AgentFailure` and
  `MachinesFailure` are the surviving untyped-cause carriers
  (`LedgerFailure`/`LlmFailure`/`IpcFailure`/`CodemodeFailure` deleted).
- **Gates.** `script/topology.ts` is the five-package inventory consumed by the
  dependency, cycle, knip, CI-lane, and tsconfig gates; `script/check-deps.ts`
  S8 pins the only two channels→agent surface bands (judgment band
  `src/router/` + `src/authn/`: `evaluatePermission`, `decisionFromEvaluation`,
  `PolicyEvaluationInput`, `createDecisionFactPort`, `createSurfaceKeyStore`;
  store band `src/store/`: `requireSubAdapter`, `withStoreTimestamps`,
  `StoredIdentity`, `StoredEndpoint`); drivers stay on `{protocol}`.
- **Verification.** `ls packages` prints the five directories;
  the five retired package names, the ORM name, and the gate-hook token grep
  to zero across `packages apps script docs .github`. Historical receipts
  below this section may still name pre-#1246 paths; path claims in them are
  historical, and this section plus `AGENTS.md` are authoritative for current
  wiring.

## #1245 injected configuration, clock and entropy (epic #1260 P3 after #1244, merged as `c1d5ebd2` (PR #1263))

On `epic1260/1245-inject-clock-entropy` (2026-10-01, base `a4478b0e`). Ambient
time, entropy and environment reads are replaced by injection; seven
permissive defaults become explicit typed outcomes.

- **Three environment owners.** `process.env` is read only by
  `apps/openomni/src/config.ts` (vault key resolved once into
  `OpenOmniConfig.kek` via `resolveKek(env, home)` and injected into declared
  provisioning), `apps/openomni/src/cli/env-file.ts` (`processEnvironment()`
  for cli/main and watch-sources spawn env), and
  `packages/llm/src/model/loader.ts` (`resolveAuthFilePath(env)`, called
  once when `LlmLive` is constructed; the Layer closes over the path and
  `Auth.all/get/set/resolve` and raw `run`/`Provider.resolveModel` take
  `authFilePath` explicitly, so `auth/storage.ts` has no env read and no
  resolver call). The desktop reads env only
  through `bootstrap(process)` → `resolveDesktopConfig(env)` in the new
  `apps/desktop/src/main/config.ts` (`gateway-endpoint.ts` deleted); the
  config is pinned once at module load.
- **Effect Clock and agent Entropy.** The custom agent Clock service is
  deleted from `packages/agent/src/services.ts`; Effect code uses the
  built-in `Clock` (`Clock.currentTimeMillis`, TestClock-replaceable).
  `packages/agent/src/core/entropy.ts` (since #1247 `packages/agent/src/kernel/ports.ts`) owns the temporary `Entropy` service
  (`EntropySource { id(): string; random(): number }`, `Entropy.layer`);
  the executor derives plain `clock`/`entropy`/`random` functions from both
  services and threads them through execution. #1247 places Entropy finally.
- **Promise-side injection.** channels, llm, ledger, ipc, codemode and the
  desktop renderer take required plain function options — `now: () =>
  number`, `id: () => string`, `random: () => number` — with inline types and
  no fallback defaults (`?? Date.now` deleted everywhere). Representative
  owners: `ChannelProvider.create(credentials, config, publish, { now, id,
  random })`, `GatewayRouterPorts.now/id`, llm `RunInput.now/id` and
  `Retry.decide(..., { now, random })`, `openCatalogStore`/`openSessionStore`
  `{ now }`, ipc `PeerRequestTable` required `idSource`, `createCodemode({
  id })`, renderer `createPlatform({ clock, ids })` bound once in `main.tsx`
  (`RendererPlatform { now(): number; id(): string }`; minting before
  `bindStorePlatform` throws `RendererInvariantError`). Composition roots
  supply sources: `apps/openomni/src/composition/platform.ts`
  `platformEntropy()` holds the tree's only `node:crypto` randomUUID import,
  and protocol `traceIdFromUuid` alone formats trace IDs.
- **Seven defaults replaced.** (1) Unknown-provenance external mail runs
  with `evidence_only` authority plus a typed `InboundAuthorityViolation`
  fact (`session.inbound_authority.violation`), never `act`; (2) a missing
  failure reason becomes typed `reason: "unclassified"`; (3) a missing llm
  sink snapshot is `Effect.die(AgentInvariantViolation)`, not an empty
  assistant; (4) the tool wave bills injected-clock elapsed time instead of
  0ms; (5) absent runner output returns typed `RunnerOutputMissing`, not a
  policy `invalid_output` refusal; (6) `drain()` refusal is a typed
  `SessionDrainOutcome` and the append receipt carries required
  `admission: "stop" | "refused" | "turn"`; (7) a websocket frame without
  `eventId` returns `{ admitted: false, reason: "missing_key" }` — the
  perimeter never mints a deduplication key. Anonymous-session admission in
  `external-message.ts` is kept; only its minter is injected.
- **Verification.** `rg -n 'Date\.now\('`, `rg -n 'Math\.random\('` and
  `rg -n 'crypto\.randomUUID\('` over `packages/*/src apps/*/src` print zero
  lines (122, 2 and 42 sites removed); `rg -l 'process\.env'` over the same
  scope prints exactly the three owner files. Tests advance time with
  `TestClock.adjust` or fixed `now`/`id`/`random` stubs — no sleeps, no
  `Date.now`/`Math.random` spies. Mutation campaign and full CI are not
  claimed complete.
- **Receipts:** `.omo/evidence/ulw/01a0f656-c9f6-795d-9bfb-786c6699559b/1245/`
  holds the issue body, lane briefs and the eight lane reports with
  per-lane searches and test counts.

## #1244 package-owned typed failures (epic #1260 P2, merged as `a4478b0e`, PR #1262)

On `epic1260/1244-typed-failures` (2026-10-01, base `fb709568`). The shared
`ForeignFailure` tag is gone; every runtime package owns its failure
identity, and no production module throws a bare `Error`.

- **Seven package-owned failures.** `AgentFailure`, `LedgerFailure`,
  `LlmFailure`, `IpcFailure`, `MachinesFailure`, `CodemodeFailure` and
  `ChannelsFailure` (each a `Data.TaggedError` with `operation`/`cause`)
  replace `ForeignFailure`; `Failure.of` synthesizes `AgentFailure`. The
  ledger/llm/ipc/codemode ones are temporary until #1246 folds those packages.
- **Refusals are values, failures are typed, invariants are defects.**
  Policy refusals are plain result data returned to the caller
  (`SessionPolicyRefusal`). Expected Effect failures are the typed
  `Data.TaggedError` classes in each package union (the package `*Failure`s,
  `ContextRestoreError`, `CompactionExecutionError`, ...). Broken invariants
  are defects — thrown Errors or `Effect.die` (`AgentInvariantViolation`,
  `LedgerInvariant`). Two synchronous surfaces throw caller-handleable
  refusals instead of failing an Effect: `requireCommit` throws
  `SessionCommitError` and the actor registry throws `ActorRegistryRefused`.
  Pure tool bodies and protocol/ui/desktop throw
  named error classes (`CliError`, `AppInvariantError`,
  `ConfigurationError`, `TranscriptRecordingDefect`, ...).
  `rg 'throw new Error\\(' packages/*/src apps/*/src` is zero.
- **Deleted, not replaced.** `AlarmRefused`, `InboxCommitRefused` and the
  never-built `inbox`/`alarms` capability values; the five
  `executor-context` guards fold into `requireExecutor()`;
  `SessionCommitError` and `ReplyGrantProjectionError` move into their
  packages' errors modules; `DataPaymentRequired` (no producer puts a status
  under `.data`).
- **llm keeps the SDK error.** `APIError` is a thin tagged identity over the
  AI SDK's own `APICallError` (`cause`); provider facts (status, headers,
  body, retryability) are read from the SDK error and never copied, detection
  is `APICallError.isInstance`, and `LlmRunFailure.cause` carries the SDK
  error for classification. `ai` becomes a devDependency of agent and app so
  fixtures construct real `APICallError`s.
- **Logging without runners.** ipc/ledger/agent `console.*` calls are gone.
  ledger returns publish failures to an injected `ObservationFailurePort`;
  the agent observation bus reports a subscriber or sink failure through an
  injected reporter, else as an `observation.delivery_failed` fact on the
  same sink (a throwing reporter yields both failures in that fact; a failing
  failure report is dropped). Effect code logs through `Effect.log*`, asserted
  with a captured `Logger` through each package's one test-runner owner. No
  new runner site: `effect-runner-sites.json` stays `[]`.
- **Receipts:** `.omo/evidence/ulw/01a0f656-c9f6-795d-9bfb-786c6699559b/1244/` holds
  `gate-1244.log` (static gates + 15 CI lanes), `verify-1244.txt` (the
  issue's four searches), `patch-coverage-1244.txt`, `dod-1244.txt`,
  `checks-1244.txt`, the lane briefs/reports and review rounds.

## #1243 shared JSON/failure/interrupt helpers (epic #1260 P1, merged as `fb709568`, PR #1261)

On `epic1260/1243-shared-helpers` (2026-10-01, base `5641cff8`). Three
behaviours that were repeated across packages now have one owner each;
every consumer keeps its drop/warn/default and abort-once semantics.

- **One JSON wire parser.** `parseJson(schema, text)` in
  `packages/protocol/src/json.ts` returns the schema-typed value or
  `undefined` for text that is not JSON, a value that fails the schema, or a
  validation that throws. Consumers: discord gateway frames, slack socket
  envelopes (each now emits one warn string per dropped frame), ipc
  `LineDecoder` malformed reporting, llm retry payloads, the desktop renderer
  transport frame and saved window bounds (`?? WINDOW_DEFAULT`).
- **One Cause-to-failure fold.** `packages/agent/src/failure.ts` (since
  #1247 `packages/agent/src/kernel/failure.ts`) exports
  `fromCause(cause, synthesize)` (typed error if the Cause carries one, else
  `synthesize(Cause.pretty(cause))`) and the agent profile `of(cause,
  operation)` that synthesizes `AgentFailure` (#1244; `ForeignFailure` until then). Consumers: executor tool and
  completion outcomes, `session-turn` results, and app boot (`Failure.fromCause`
  with the app-owned `AppLifecycleFailure`). The remaining
  `Cause.findErrorOption` sites are Option extractions, not synthesis.
- **One abort listener owner.** `listenForAbort(signal, listener)` in
  `packages/protocol/src/platform.ts` is the only `addEventListener("abort")`
  in `packages/*/src` and `apps/*/src`; an already aborted signal fires at once
  and registers nothing. Effect bridges are `onAbort`/`interruptOn` in
  `packages/agent/src/core/interrupt-on.ts` (since #1247 `packages/agent/src/kernel/ports.ts`) and the one-expression `onAbort`
  connector in `packages/machines/src/interrupt-on.ts` (agent and machines
  cannot import each other; protocol is their common dependency). Consumers:
  executor body fibers, `tool-body`, `session-turn`, retry timers, approval
  waits, invocation close, machines exec/host cancellation, codemode kernel
  cancellation and cell launch, the CLI follow signal, and the desktop
  transport. `packages/machines/src/abort.ts` and the desktop renderer copy are
  deleted.
- **Waiters and fan-out.** The `Set<() => void>` listener sets in
  `executor-raw.ts` and `compaction/speculate.ts` are `Deferred`s (per raw
  slot; per preparation generation). `concurrency: "unbounded"` is gone:
  `BOUNDED_CONCURRENCY = 16` (`packages/agent/src/core/concurrency.ts`; since #1247 `packages/agent/src/kernel/ports.ts`) for
  session close, tool waves and approval stages, `CLOSE_CONCURRENCY = 16` for
  codemode kernel close, and `2` for the two-element app shutdown join.
- **Kept, with reason.** The four `Promise.withResolvers` sites
  (`executor-raw.ts` retain settlement, `process-replies.ts` first/answer,
  `watch-sources.ts` eof) hand promises to promise-world callbacks; a
  `Deferred` there would need a `runPromise` runner site, which the
  `effect-runner-sites.json` `[]` law forbids. They are promise handles, not
  waiters, and stay.
- **Deviation from the issue text.** #1243 proposed three local
  `interrupt-on.ts` copies; two identical copies measured as one jscpd
  production clone (main is at 0), so `listenForAbort` lives in protocol and
  only the Effect wrappers are local.
- **Gates on the branch:** build, check-types, lint (including
  `noExcessiveCognitiveComplexity`; the desktop `sendMessages` optional-signal
  guard is the named `stopOnAbort` function), lint:tools, topology, deps,
  effect boundaries, written any/unknown 0, dead exports, import cycles,
  tsconfig inheritance, jscpd production clones 0, and
  `bun run ci test --lane <key>` over the 15 CI lanes (4828 pass / 0 fail across 15 CI lanes (gate r5, 2026-10-01)); patch coverage
  `all changed executable lines covered` (`script/check-patch-coverage.ts --base origin/main`, lane lcov union).
- **Receipts (HEAD `ec247818`):** `.omo/evidence/ulw/01a0f656-c9f6-795d-9bfb-786c6699559b/1243/`
  holds `gate-1243.log` (lane totals), `patch-coverage-1243.txt`, `dod-1243.txt`
  (ultracite on the 32 changed sources, written any/unknown 0, jscpd 0 clones for the
  three touched packages and `quality:clones:production` 0 clones over 473 sources,
  dead-export ratchet 0 new), `verify-1243.txt` (the issue's rg searches), `checks-1243.txt`
  (CI 30 pass / 0 fail), `review-1243-r1.md` + dispositions, and
  `gate-1243-watch-sources-flake.md` (a pre-existing `watch-sources` flake met by
  the local gate on untouched code; its own subgoal, not this PR).
- **Desktop checks:** the two renderer/main behaviours touched here are covered by
  automated counterparts, `gateway-transport.test.ts` "ignores malformed frames and
  retains unsolicited reply correlation" and `window-bounds.test.ts` "Given malformed
  or undersized JSON, When parsed, Then the default" (desktopApp lane 443 pass / 0
  fail). A native Electron run was not performed.

## W5.3 #1113 closure receipt (2026-09-29, merged as `f7e36984`, PR #1240)

W5.3 on `kernel/1113-w5-closure-20260929` (draft PR #1240, HEAD `03f70089` plus this docs commit,
base `8390912c`) closes the W5 absolute-quality lanes. Lane receipts live
under `.omo/reports/kernel-campaign-w53/`.

- **Effect runner owners (A1):** `script/conformance/effect-runner-sites.json`
  is `[]` (48 → 0). `script/check-effect-boundaries.ts` names exactly one
  test-runner owner per package (`RUNNER_OWNERS`: the openomni, agent,
  channels, ipc, ledger, llm, and machines test helpers) plus the two named
  bench entrypoints (`packages/agent/bench/turns.ts`,
  `packages/ledger/bench/index.ts`); the production edges remain
  `apps/openomni/src/cli/main.ts` and `apps/openomni/src/gateway.ts`. No
  production `src/` file changed for A1.
- **Written any/unknown 0 (A2/A2b/A3):** repository-wide written
  `any`/`unknown` type keywords went 68 → 0 (A2 protocol 16 → 0, A2b the last
  4 protocol sites, A3/A3b the script/app/package sites). The new AST gate
  `script/check-written-types.ts` (`check-written-types` package command,
  wired into CI next to `check-effect-boundaries`) has no baseline and
  excludes only `*.test.ts(x)`; it exits 0 with
  `OK: written any/unknown types: 0`. A2 also deleted 53 dead protocol export
  identities (`app-connector/`, `Mcp.Events`, `McpConfig`, `Deadline`, and the
  Tool/Transcript/Policy/Machine/Ingress aliases with zero production
  consumers).
- **One app-owned read model (A4/A4b):** the single read surface is the
  `session_read` handler in `apps/openomni/src/gateway.ts`; channels only
  parses and transports the frame. Every read wire DTO is Zod plain data in
  `packages/protocol/src/gateway/session-read.ts` (`SessionRead.Request` /
  `Cursor` / `Page` / `Gap` / `Receipt`); the `session_snapshot`,
  `session_page`, and `session_gap` frames are additive. Usage provenance is
  `reported | estimated | unknown`, forked at the provider accounting site
  (`packages/llm/src/processor/stream-events.ts`) and written once by the
  durable attempt-result writer. Inspection is bounded
  (`packages/agent/src/inspect/index.ts`: limit 1-256, shared
  descendant budget, indexed catalog child pages, zero `kernel.listRows`
  loops). Desktop owns one query per durable session ID; tabs, drafts and
  selection stay local, and `DEFAULT_PROJECT_ID` plus the renderer
  `phase: "idle"` seeds are grep-zero.
- **A5 mutation baseline fix:** the #1049 baseline-compiler rejection is fixed
  by root-file candidate ownership (each compiler project diagnoses only its
  `getRootFileNames()`); the execution-copy tracked-deletion mirror is scoped
  to git roots (non-git fixture roots no longer fail); `quality-audit` gained
  TypeScript function metrics — cyclomatic (<22), Halstead difficulty (<80),
  CRAP (<25) — implemented in `script/quality-typescript-metrics.ts` and
  pinned in `script/conformance/quality-contract.json`.
- **W4 #1112 disposition (A6):** inert `RunInput.maxSteps` and orphaned
  `Retry.sleep` are deleted; the named executor files have zero duplicate
  abort/race owners; `tool-body.ts` keeps its one invocation-scoped
  cancellation bridge; channel HTTP retry and reconnect stay transport
  behavior. Full audit: `.omo/reports/kernel-campaign-w53/W4-1112-receipt.md`
  (H10 closed).
- **Review r1 findings 1-7 landed** (`review-r1.md`; fixes in `F1.md`,
  `F2.md`, and commits `cb4bf00e`/`f4542212`): (1) session-level terminal
  pages no longer settle other turns' pending chats; (2) an empty same-epoch
  same-head continuation keeps the cached page; (3) the descendant budget is
  independent of the mandatory root visit; (4) paged turn ancestry resolves
  through indexed `actionById` reads; (5) script entry points use top-level
  try/catch instead of inferred-`any` `Promise.catch`; (6) `phaseSince`
  derives from the phase-establishing transition; (7) the resume regression
  asserts exactly one delivery again. Each fix has a fails-before /
  passes-after regression.
- **Review r2 finding 1 (F1-r2):** the accepted receipt is restored to its
  frozen base shape `{type:"receipt",status:"accepted"}`; the durable binding
  moved to the additive `session_bound` frame (`SessionRead.Bound`), sent
  immediately after the receipt on the same socket; desktop binds from
  `session_bound` and ignores receipts.
- **Review r2 findings 2–7 (F2-r2..F6-r2):** (2, 6) the mutation baseline
  and candidate compilers share one root-file diagnostic ownership rule
  (`projectRootPaths`/`ownsDiagnostic` in `script/quality-mutation-input.ts`)
  and the generator's covered set is canonical root ownership, so
  transitive-only inventoried files enter the fallback deterministically;
  (3) the scheduled audit decodes the persisted version-1 summary footer
  (`previousTotalsSchema`) and skips regression rows for dimensions the
  footer never measured instead of comparing against invented zeros; (4)
  overlapping desktop `readSession` calls keep every waiter — same cursor
  coalesces onto the in-flight read, a differing cursor is rejected with the
  typed `SessionReadSupersessionError`, and close/error/session-scoped error
  frames reject all waiters;
  (5) paged turn ancestry resolves through descending 256-action history
  windows (zero point reads; a one-action page over a 300-link chain costs at
  most three window reads, attribution exact); (7) `readSessionCursor`
  captures every phase fact before the fence/revision check, so an
  interleaved commit surfaces as a typed `session_gap` instead of an old page
  with a newer turn's `phaseSince`; F6 sizes the durable-reconstruction
  child-exit deadline (60 s, exact exit signal) for cold hosted runners. Each
  fix carries a mutant-killed regression.

Wave-B gate line (`B-verify.md`, run locally at branch HEAD): build 0,
check-types 0, lint 0, lint:tools 0, lint:docs 0, check-topology 0,
check-deps 0, check-import-cycles 0, check-dead-exports 0,
verify-tsconfig-inheritance 0, check-effect-boundaries 0,
check-written-types 0; root `bun test --timeout 15000 --coverage`:
**4671 pass / 0 fail** after the r2 fix lanes (4635 before them); script
lanes serially 253/81/336 pass, 0 fail.

Honest audit deltas (`quality-audit --dry-run`; the W5.3 column had no local
LCOV lanes, so `complete: false`; the sweep column ran all 15 lanes locally
with LCOV, `complete: true`, `missingLanes: []`):

| Kind | `8390912c` baseline | W5.3 HEAD | quality-debt sweep (2026-09-29) |
| --- | ---: | ---: | ---: |
| coverage (uncovered lines with LCOV; missing-file records before) | 3116 | 485 | 1777 uncovered lines / 162 files |
| complexity | 17 | 14 | 0 |
| cyclomatic (new, <22) | — | 1 | 0 |
| halstead (new, <80) | — | 0 | 0 |
| crap (new, <25; needs LCOV) | — | 761 (no coverage input) | 0 |
| clones | 280 | 280 | 0 |
| types (transitive inferred sites, not written keywords) | 2779 | 2123 | 479 |

The sweep's residual coverage is enumerated in `docs/SLOP.md` §J (CLI
`main()`/violation-print paths in `script/`, race-guard tails in `agent`); the
479 type sites are Zod boundary parses and inferred generics, not written
keywords (`check-written-types` stays 0).

Not claimed: CI green, patch coverage, or mutation completion. B-verify
measured 71 patch-uncovered changed lines across 12 files locally; wave C
lanes C1/C2/C3 close them, and the authoritative gate is the CI
patch-coverage job on PR #1240. The full mutation campaign remains the
scheduled `quality-mutation.yml` run.

## W5.2 session entity receipt (#1197, 2026-09-28)

W5.2 merged as `8390912c` (PR #1239, 2026-09-29) on
`kernel/1197-session-entity-20260928`; it
ships one `Session` entity per `sessionId` on the `effect/cluster`
`SingleRunner` exposed by Effect `4.0.0-rc.118`. Each activation opens one
fresh-schema SQLite file under the configured sessions directory and shares a
catalog SQLite file for cross-session facts and cluster coordination. There is
no legacy migration path: the former `catalog.db` and other old database files
are neither read, migrated, nor deleted.

The entity owns mailbox FIFO followed by `decideSessionAdmission`, rotates the
session fence once per activation, drains the complete admitted backlog, and
uses `DeliverAt` messages for retry, request-deadline, and monitor timing. The
entity port now exposes `settle`; interruption detaches a running turn at the
entity boundary, and shutdown awaits quiescence before closing stores.
`localInboxCommit` borrows the active entity authority only while that entity
is running, preserving live-turn fence ownership while unrelated callers still
fail closed.

Historical deletion receipt: the former lease/alarm/inbox/migration planes are
deleted to the plan §5(a) grep-zero contract. Deleted symbols are `LEASE_TTL_MS`,
`HEARTBEAT_INTERVAL_MS`, `renewLease`, `acquireLease`, `sweepSessions`,
`wakeSession`, `createAlarms`, `Storage.get`, and `Storage.initialize`.
Deleted source surfaces include `packages/ledger/migration/`,
`packages/ledger/src/storage/migration-runner.ts`, the `u967-*`, `u969-*`,
`historical-projections`, and `historical-request-format` migration readers,
`packages/agent/src/executor-retry-alarm.ts`, and
`apps/openomni/src/composition/alarm-worker.ts`. The obsolete script gates
`check-ledger-schema-drift`, `verify-ledger-rename`,
`generate-ledger-archive-manifest`, `ledger-archive-snapshot`, and
`ledger-producer-manifest` are also deleted.

The crash matrix remains exactly 27 faults on the entity plane. Parent-measured
gates at this branch state are: `apps/openomni` 529/0, packages 1443/0,
channels 576/0, script 717/0, `check-types` exit 0, dead exports 0 known/0 new,
`check-effect-boundaries` exit 0 with its runner-site allowlist reduced 54 → 48,
and the §5(a) deletion grep at zero.

This receipt does **not** claim full CI, the pending L4.2 patch-coverage 100%
gate, or a mutation campaign. The 16 pre-existing protocol `unknown` sites
remain carried to #1113. Known findings are explicit: cluster entity reaper
resolution is at least five seconds; `ConfigProvider.fromEnv()` snapshots the
environment at module load; and protocol still retains the `Inbox.Commit` and
`Alarm.Watch*` wire schemas even though their consumer moved into the entity.

## Historical receipts retained below

The remaining sections preserve the evidence and scope claimed by earlier
campaign increments. Their source names are historical context, not live W5.2
ownership.

W5.0 (#1195) Effect pin `3.22.2` → `4.0.0-rc.118` (exact, published 2026-09-28) on `kernel/1195-effect-v4-pin-20260928` (PR #1198, ⏳ pending merge): zero behavior change — mechanical v4 renames across nine workspaces, `FiberRef` → `Context.Reference`, `Effect.withFiberRuntime` → `Effect.withFiber`, `Cause` reason filters, `Effect.all` failure semantics of `shutdownSessions` preserved under v4 `mode: "result"`, `effect/testing` `TestClock`; protocol/ui/desktop/tool bodies stay Effect-free (`check-effect-boundaries` 233 allowlisted ratchet sites, allowlist 224 entries, both unchanged from main); no `effect/unstable` cluster or workflow import. Receipts under `.omo/reports/kernel-campaign-w50/`. W3 (#1111) merged as `75d28562` (PR #1193, 2026-09-26): single ledger policy-generation writer (compiler `append: () => false` deleted), executor dispatch table with captured toolsGeneration, ToolCatalog Layer built once per generation with tools/** effect-free and sealed 12-tool catalog (read, write, edit, ls, find, grep, bash, eval, monitor, send_message, provision, completion), and typed evidence-only authority (`SessionRunnerInput.authority` from inbox `origin.inboundTreatment`) with OBSERVATION prose prefix deleted. W0.5 (#1184) source wiring inspected on `kernel/1184-consumed-layers-20260924`, 2026-09-24. This stamp covers the Layer/bundle slice below, not a re-verification of historical receipts or a merge/CI claim.

| Slice | Status | Scope |
| --- | --- | --- |
| Consumed Effect Layer floor (#1184), 2026-09-24 | wired in worktree; full acceptance not asserted | Effect factories consume Tags; AppLive composes package Layers and an app-owned generation map; validated bundle definitions and named policy contributions build in captured generation scopes. Sources and remaining boundaries follow below. |

At the #1184 inspection paths (since #1247: `packages/agent/src/kernel/gate/decide.ts`, `packages/agent/src/kernel/tool.ts`, `packages/agent/src/kernel/turn.ts`): `packages/agent/src/executor.ts` resolves Clock, Entropy, ObservationSink and
SessionLayer; `packages/agent/src/tool-dispatcher.ts` (since #1247
`packages/agent/src/kernel/tool.ts`) resolves ToolCatalog.
`packages/agent/src/core/execution/run.ts` (since #1247 `packages/agent/src/kernel/turn.ts`) and
`apps/openomni/src/composition/completion.ts` resolve Llm and ObservationSink.
App boot and gateway thread the ledger plane explicitly
(`apps/openomni/src/index.ts`, `apps/openomni/src/gateway.ts`);
`createAppLedger` (`apps/openomni/src/composition/cluster-runtime.ts`) owns
storage acquisition/release.

`apps/openomni/src/runtime.ts` builds AppLive with a final Layer.mergeAll.
`apps/openomni/src/composition/generation-layers.ts` constructs the selected
catalog, scoped local observations, named registry and compiled policy; its
session-keyed managers use `packages/agent/src/session-generations.ts`
(since #1247 `makeSessionGenerations` in
`packages/agent/src/session/run.ts`; the `GenerationRawSlots` raw-slot
service lives in `packages/agent/src/kernel/gate/decide.ts`) for
capture/configure and retirement. Boot initializes immutable role definitions
before recovery. Installed bundle names are passed to new sessions, and bundle
rows enter existing policy seeding (`apps/openomni/src/index.ts`,
`apps/openomni/src/bundles/core-policy/index.ts`). Existing configure operations carry recorded
membership unchanged (`packages/agent/src/session-configuration.ts`; since
#1247 `createSessionConfiguration` in `packages/agent/src/session/run.ts`).

`packages/agent/src/bundle.ts` (since #1247
`packages/agent/src/kernel/bundle.ts`) validates definitions and ordered composition,
including named policy services. The executor records original arguments when
pre-transforms apply (`packages/agent/src/executor.ts`,
`packages/agent/src/executor-record.ts`; both since #1247 `packages/agent/src/kernel/gate/decide.ts`). These are source-inspection claims,
not receipts for every runtime, crash, performance or patch-coverage gate.
B6 remains open: configure authority and approval-binding callbacks survive
([SLOP](SLOP.md#w05-consumed-layer-floor-1184)); W0.5 does not claim their W1
migration, a bundle membership API, full W3 G1, or concrete production bundles.

Policy/ledger ownership was updated on `kernel/s1-authority-cut-2`, 2026-09-18: G002 (#930) deletes the unused composition schema and moves app action reads to narrow SQL-backed ports.

**G003 durable spine (`kernel/s1-durable-spine`, 2026-09-18, #930):** the volatile `waitRetry` seam is deleted; a provider retry commits an `alarm.arm` action carrying a `retry.scheduled` spec (kind `at`, id `<intent>:retry:<attempt>`) before any wait, and the live waiter or boot alarm worker consumes it exactly once through the fenced cancel CAS (now admitting one-shot alarms) and wakes the session without an inbox prompt (`packages/agent/src/executor-retry-alarm.ts`, `apps/openomni/src/composition/alarm-worker.ts`). A boundary-flagged execution (compaction) commits summary + successor projection + accounting as one ledger transaction before result commit or publication; crash recovery settles the open intent executed-from-boundary without resummarizing (`packages/agent/src/executor.ts`, `executor-recovery.ts` — since #1247 `packages/agent/src/kernel/gate/decide.ts` — and `compaction/execute-cut.ts`, since #1247 `plugins/compaction/execute-cut.ts`). Commit-time writer fencing is recorded as taxonomy: a stale fence gets the typed `{ok:false, reason:"stale"}` rejection atomically with no partial row, proven fence-only under the same owner name (`packages/ledger/test/session/commit-fencing.test.ts`). Crash-matrix rows `retry_backoff_wait` -> `rearmed`, `compaction_summary_before_result_commit` -> `resumed_without_reexecution`, `owner_reclaimed_before_stale_transcript_flush` -> `rejected`.

Single source of truth for current wiring, not a declaration that every target in [Core Model](core-model.md), [Kernel Contract](kernel-contract.md), [Architecture](architecture.md), or [Machines and Delegation](machines-and-delegation.md) has shipped. [Epic #930](https://github.com/INONONO66/openomni/issues/930) supersedes #459 for kernel delivery; #966 and #968-#973 are the subsequent lifecycle campaign.

[Kernel reference pins](kernel-references.md) are owned by `docs/kernel-references.md`.

**#945 absolute census (2026-09-19, main `f5ea0e32`):** the Quality ratchet is green as a no-growth gate; the admitted baseline still holds 60,509 rows (99,601 multiplicity) across coverage, type, CRAP, clone, export, publisher, complexity and store gates. #945's literal-zero definition of done is not met; the per-gate table and the full-mutation campaign outcome are in [SLOP](SLOP.md#945-absolute-census-receipt-2026-09-19-main-f5ea0e32).

**#969 cutover (2026-09-07):** waiting and authenticated consent are original-action state. Source-owned outbound obligations feed the receiving kernel and inbox. Migration 0038 removes the independent stores with guarded archival retention. Final HEAD, gate outputs and acceptance receipts are recorded in the PR and local report.

**#971 cutover (2026-09-08):** alarm occurrence identity, deadline and notification budget are decided by the ledger from the committed row and its persisted spec; the evaluator reports a transport `sourceKey` and redelivery commits nothing. No schema change, no migration, no new table.

**#970 cutover (2026-09-08):** interrupted executor operations settle from classified durable evidence, never by rerunning a body. Attempt ordinal, cap, retry reason, usage, visible-output boundary and a non-secret credential handle are pinned on attempt actions. `restore_model_selection` and `restore_context_projection` are recorded, policy-evaluated actions that append; no schema change, no migration.

**#973 conformance (2026-09-08):** the unified lifecycle is proven on the real tree, not declared. `runLifecycleTrace` (`packages/agent/test/session-lifecycle-conformance.test.ts`) runs the six section 6.7 registrations of the [lifecycle contract](session-lifecycle-contract.md) over the real store, controller, executor waves, request port, outbound path and alarm rows, asserting append-only history, causal parents, terminal uniqueness, single input consumption, one observation per commit and effect-free replay from the reopened SQLite image. No production writer moved and no fixture was deleted; the #945 all-dimension quality receipt stays with #945.

**#1030 policy dead-code removal (2026-09-09):** the general effect-composition implementation and its 29 conformance tests are removed without replacement. Searches of updated `origin/main` (`47bc4299`) found no external production or test consumer of any of its 31 exports; the PR body records every command, result and census/prose/substring false positive. The retained engine evaluates compiled rows and permissions; it does not implement general deny/pending/allow composition, safe-deny effect ceilings, conflict merging, deduplication or retry-ceiling merging. Captured row budget limits and channel ceilings are unchanged. Protocol `Policy.EffectiveDecision` was deleted in G002 (#930), including its schema/type, parser/module-surface entries and snapshot. Shared `PolicyEffect` and `PolicyDecision` contracts still have separate consumers and are not deleted (the obligation contract followed in #1246).

**Source baseline:** #946 stage 2 includes main `678d357e` (#993/#949 stage 1), #991 codemode, #988's protocol contract and #990's desktop gateway selection. Historical #948 receipts below retain their `c4fb7748` source pin. [SLOP](SLOP.md) records deletion ownership; the PR body records the final gate commands and exit codes. Closed issue labels are not implementation evidence.

**W1 (#1108) durable reconstruction (merged `851a71fc`, 2026-09-24):** checkpoint folding commits `fold.checkpoint` at the 256-action threshold and at compaction/restoration boundaries (`packages/ledger/src/storage/l0-action-builders.ts`, `packages/agent/src/session-lifecycle/history.ts` — since #1247 `packages/agent/src/inspect/history.ts`). Bounded hydration validates the checkpoint seed before a capped range load; corrupt seeds refuse with `FoldCheckpointIntegrityError` — zero full-tree fallback, zero runner entry (`packages/ledger/src/session/kernel.ts`). The whole-tree kernel `tree` export is removed; production `.tree(` consumers grep to zero across agent/openomni/ledger src, and the fold oracle remains test-only (now `packages/agent/test/store/helpers/session-tree.ts`, #1246). `authorizeConfigure` is a required pinned pre-policy authority on the session runtime (`packages/agent/src/session-contract.ts:129`); the optional-callback `?? Effect.succeed(true)` fail-open in `packages/agent/src/session-configuration.ts` is deleted (grep zero). Retry scheduling persists the unchanged `retry.scheduled` alarm payload (kind/attempt/reason/notBefore — `packages/protocol/src/ledger/l0.ts` `Alarm.RetrySchedule`) before any wait; restart sleeps only the residual `notBefore - now` with the recorded row byte-identical and no new jitter drawn (`packages/agent/src/executor-retry-alarm.ts`, deleted by W5.2 #1197; retry alarms live in `packages/agent/src/session/alarm.ts` since #1247). NOT in W1: durable alarm-level deadline/route/jitter/provenance/remainingBudget fields (protocol change required) and a durable route cooldown store (no owner exists); residual/jitter/provenance are proven only at the derived level (`notBefore` embeds the drawn jitter; provenance/budget live in attempt-intent metadata). Crash-matrix v2 reconstruction rows (`script/conformance/crash-matrix.json`): `fold_checkpoint_committed_before_wake`, `context_restore_checkpoint_committed_before_publish` and `same_id_result_after_checkpoint_before_wake` → `resumed_without_reexecution`; `fold_checkpoint_tampered_before_load` and `captured_generation_missing_after_restart` → `rejected` (typed refusal, no fallback or generation substitution); `open_tool_checkpoint_before_terminal` → `lost` (identity preserved, `outcome_unknown`, no re-entry); `recovery_dispatch_identity_committed_before_rpc` → `resumed_without_reexecution` (not the `rearmed` target: no separately durable recovery-dispatch identity).

**W2 (#1110) one message plane (merged `d5b48a1b`, PR #1190, 2026-09-25):** the Resident no longer replies on its own initiative. The post-turn block that dispatched `send_message` to the last external-origin actor is deleted from `apps/openomni/src/bundles/resident/index.ts` (grep zero for `send_message` in that file); external replies happen only through an explicit `send_message` tool call, and a child's terminal still reaches the parent inbox as the kernel obligation. One alarm writer: the request-deadline `INSERT` in `sqlite-l0-write.ts` is gone; `requestDeadline` (`packages/ledger/src/storage/l0-action-builders.ts:24`) builds the row and the transaction-local `insertAlarm` (`packages/ledger/src/storage/sqlite-l0-write.ts:122`) is the single `INSERT INTO alarm` site, called by explicit `armAlarm` (`sqlite-l0-alarms.ts:87`) and by request/reply state projection in the same commit. The app alarm worker mints no occurrence ids and renders no timeout verdict; a watch timeout is delivered as a clock observation (`timer:<fireAt + timeout_ms>`) and the ledger alone decides expiry (`apps/openomni/src/composition/alarm-worker.ts`). Channel provisioning is declared-only: `channelsFromEnv`, `config.channels` and the `source: "env"` selection are deleted; `loadConfig`/`doctor` refuse nonblank legacy tokens with `ConfigurationError` `legacy_channel_credentials` naming `provision`/`channel_add` (`apps/openomni/src/config.ts:253`); the supervisor reports `source(): "declared"` only (`apps/openomni/src/bundles/provision/supervisor.ts:76`). Physical delivery reports facts: adapters return `sent | not_sent | unknown` (`packages/channels/src/support/deliver.ts:8`), `DeliveryReconciliation` holds custody per idempotency key and releases it only on a proven `not_sent` (connection never established, typed `DeliveryNotSent`, or platform rejection); the kernel `accepted | rejected | unknown` receipt is a translation at that one boundary (`kernelDeliveryReceipt`), and the expiring outbound `DedupeWindow` is deleted. GitHub reports unopened webhooks as a typed `unsupported_event` refusal observation (`packages/channels/src/provider/github/surface.ts:23-35`) while keeping HTTP 200; PR events are still not ingested. Matcher bearer/identity-less branches and the resolver's `legacyActorFields` copier are deleted (SLOP H14). Agent ports: outbound recovery reconciles against the receiver's durable receipt before any redispatch (`packages/agent/src/session-outbound.ts:112`) and `SessionRequestPort.cancel` shares the original-action CAS (`packages/agent/src/session-requests.ts:127`). The IPC client drops frames once disconnected or closed (`packages/ipc/src/client.ts`). Crash-matrix rows (`script/conformance/crash-matrix.json`): `platform_send_committed_before_local_ack_reconciled_sent` → `resumed_without_reexecution`; new `alarm_fire_committed_before_hibernated_doorbell` → `rearmed`; `platform_attempt_marker_before_send_reconciled_not_sent` and `outbound_flood_deadline_before_timer_rearm` stay `rearmed` and `platform_send_ambiguous_without_reconciliation` stays `replayed` because the ledger outbound projection admits only `pending | delivered` (no durable attempt, `outcome_unknown` or `notBefore` state); that protocol change is NOT in W2.

## #947 stage-1 branch receipt (2026-09-06)

The stage-1 branch extends the existing alarm owner with fenced evaluation,
atomic fired/prompt delivery, persistent PTY and path sources, durable dedupe,
policy-budget pause/rearm, and boot discovery. The additive `monitor` tool uses
`op:create|rearm|cancel`. The app band outlives session hibernation; its committed
inbox doorbell re-enters the existing session controller, not a second loop.
The focused 30-test run passes, including a real PTY, SQLite reopen and a
one-model-call waiting terminal followed by a hibernated-session wake.

The Owner-approved input now nests an op-discriminated `operation`, with create
payload under `source` and required `alarmId` on controls. `lint:tools` passes
without an exemption or lowered floor. Path sources reconcile stat identity in
the same app scan as native notifications: unchanged observations write zero,
and a missed native event no longer strands a durable create. The path test
subscribes before mutation and drives reconciliation without yielding to the
native callback, proving atomic delivery independently of callback timing.
Evaluator entry captures the app async context, preventing tool-wave abort
inheritance. A real WebSocket/PTY/FIFO regression verifies that a tool-created
source wakes a hibernated app session after its original tool wave has ended.

Rebased production checkpoint `6a912340` passes the complete gate chain:
3377 tests across 359 files, zero failures, and all 11 coverage lanes plus the
unchanged coverage ratchet. The real app WebSocket/path exercise reaches a
hibernated-session wake at revision 59 with two model calls. Removing the app
async-context binding makes the PTY/FIFO regression fail with AbortError.

[Decisions and operational limits](alarm-monitor-stage-1.md) include the
at-most-once restart gap. Stage 2 after #946 still owes only the
message-deadline consumer -> `at` alarm migration, its answer/deadline CAS and
restart tests, and B4 deletion proof. #969-#972 receipts are consumed by their
own sections below; #973's executable evidence is in the conformance section.

### PR #994 R1 correction receipt

The R1 implementation merges main `678d357e` (#993): all six fs/bash tools,
monitor and existing tools remain in the catalog; placement stays deleted.
Callback deadline precedence now applies before ordinary match/exit admission.
Command cleanup kills its process group, including HUP-ignoring grandchildren,
and stale cleanup is fenced from a rearmed source. Migration validates the
complete shared WatchSpec before committing 0035. Synchronous inbox/action
assertions kill the path-reconciliation mutant before native callbacks can run.
A compiler-backed boundary test reports zero inferred unsafe values and rejects
its deliberately planted JSON/catch mutant; runtime payloads are schema-checked.
The earlier 3377-test receipt above remains historical, not a claim that R1
was already addressed at that checkpoint.

Production checkpoint `21675e12` passes the merged full suite: 3435 tests,
zero failures, 11167 assertions across 365 files. All ten current coverage lanes
and the unchanged ratchet pass (app 97.08%, ledger 99.34%). The full build/type/
dependency/cycle/lint/export chain, including tool-lint self-test, exits 0.
The reviewer's added-line compiler probe emits no unsafe values. The real-app
WebSocket/path wake still commits one fired pair and reaches revision 59.

## Deployed shape

| Component | Current wiring | Source |
| --- | --- | --- |
| Kernel app | Boot/shutdown, Resident, channels, gateway, provisioning, machines, messaging, cells, and compaction. No built-in curated memory or replacement port. | `apps/openomni/src/index.ts` |
| Desktop console | Electron shell and app-owned AI SDK chat state; the renderer selects the configured gateway or the explicit preview transport. Gateway admission receipts and later message frames are distinct. Presentation is shared with the UI showcase. | `apps/desktop/`, `packages/ui/` |
| Channel drivers | Discord, GitHub, Slack, Telegram providers and a separate WebSocket bootstrap surface. Providers own credential/settings validation and outbound rendering; the app composes them. | `packages/channels/src/provider/`, `packages/channels/src/websocket.ts`, `apps/openomni/src/channels.ts` |
| Perimeter gateway | Blacklist, physical request correlation, channel ceiling, actor identity, surface sessions, durable route decisions, and grant/egress/idempotency-controlled sends survive. Removed dialogue stores confer no routing rights. WebSocket credentials use the canonical auth subprotocol; query-only authentication is rejected (#974). | `packages/channels/src/router/`, `packages/channels/src/authn/websocket.ts`, `apps/openomni/src/gateway.ts` |
| Provisioning | Durable persons, channel instances, and encrypted secrets; declared instances are the only channel provisioning owner, and nonblank legacy channel env credentials are refused at config load with `legacy_channel_credentials` (W2 #1110). The vault key and channel supervisor are composed at boot. The one-shot environment import command is deleted. | `packages/channels/src/store/provisioning/`, `apps/openomni/src/bundles/provision/` |
| Runtime administration | The `provision` op union uses the live supervisor for channel/secret changes and status. Person mutations suspend their original invocation for authenticated approval when `approvalRequirement` demands one (editing the existing owner Person, or raising a tier above collaborator); other declarations and non-sole-owner `person_remove` apply directly. `contact_promote` and `contact_merge` suspend under the `require_approval` policy row until the Owner's answer re-admits the original invocation; the separate `approval` tool was deleted in `239b4273` (2026-09-08). | `apps/openomni/src/tools/provision.ts`, `apps/openomni/src/provisioning/supervisor.ts` |
| Resident and native workers | Shared durable session handles and one app runner. The Resident sends no automatic reply after a turn; external replies are explicit `send_message` calls (W2 #1110). Native and real process child-to-parent delivery pass targeted tests; the old app delegation subtree and tools are removed. | `apps/openomni/src/bundles/resident/index.ts`, `apps/openomni/src/process-entry.ts`, `apps/openomni/src/composition/process-session.ts` |
| Session durability | Fenced single-flight execution, durable inbox/alarms, parent-linked rows, action history, generation snapshots, boot recovery, idle release, authoritative reads, revision-gap observation, bounded revision history pages (`history()`) and redacted causal inspection (`inspect()`) derived from committed actions (#972). Legacy public CRUD/message/TTL ownership is removed, not aliased. | `packages/agent/src/core/store/fence.ts`, `packages/agent/src/core/run.ts`, `packages/agent/src/inspect/index.ts`, `packages/agent/src/core/store/session-file/index.ts`, `packages/agent/src/core/store/storage/` |
| Action executor and policy | Session-pinned compiled policy rows govern prompt/turn/model/tool/message pre/post decisions; message post is obligation-only. The executor owns model/tool intents and linked terminals; prompt/turn records remain session-owned. Old policy callback registries are deleted (#965); configure-authority and approval-binding seams remain tracked by B6/H6. Unconsumed general effect composition is deleted without replacement (#1030). | `packages/agent/src/core/gate/decide.ts`, `packages/agent/src/core/gate/compile.ts`, `apps/openomni/src/bundles/core-policy/index.ts` |
| LLM | Canonical model/auth resolution, provider classification, retry-after/backoff, and corrected additive token accounting. The processor performs one attempt; session execution owns retry and re-admission. The unused public fact tap is removed (#976); ephemeral transcript folding and message/tool callbacks remain. | `packages/agent/src/model/`, `packages/agent/src/core/gate/decide.ts` |
| Compaction | App-configured summarization and agent-owned speculative/synchronous compaction, with durable projection/range/hash/revert evidence and reconstruction from canonical actions. The summarizer is wired, not dormant. | `apps/openomni/src/bundles/compaction/`, `packages/agent/src/plugins/compaction/`, `packages/agent/src/inspect/history.ts` |
| Observation | Scoped agent bus/component observations are projections, not durable authority. Ledger facts commit before observation. The old telemetry package and bus-persistence writer are absent. | `packages/agent/src/core/bus.ts`, `apps/openomni/src/observation/` |
| Machine body and raw endpoints | Stable list/get handles expose binary-safe confined fs read/write/list/stat, stateless exec(cmd,cwd), and runCode. Enrollment/offer intersection is fail-closed. Exactly two authorization boundaries: captured kernel tool.pre and daemon capability/export enforcement. The descriptor-pinned no-follow confinement driver remains; the injected interpreter runner lives in `packages/codemode` since #1272. Old app filesystem/list-machines tools remain absent. #1270: the host binds a listener set (unix always; TCP+TLS only with the full `OPENOMNI_MACHINES_TCP_*`/`OPENOMNI_MACHINES_TLS_*` tuple) into one registry; network trust is chain-verified on the daemon side (the configured `hostCertificate` PEM is the trust anchor and its key fingerprint the pin) and key-pinned on the host side (`Enrollment.publicKey`, sha256 over SPKI DER), refusing `peer_key_mismatch` before admission; a known machine's dropped/in-window calls fail once typed `disconnected`; the daemon's opt-in reconnect redials with full-jitter backoff (250ms base, 30s cap, injected scheduler), reattaches the same identity to the existing handles, and closes terminally on a refused reattach; the `machine attach` CLI config gains the pinned-TLS tcp shape (see `docs/key-generation.md`). #1271: the brain host attaches as machine `self` — `machines.self {id?="self", capabilities, exports}` + `machines.default?="self"` (`OPENOMNI_MACHINES_SELF`/`OPENOMNI_MACHINES_DEFAULT`), boot validates the plane, starts the listener, attaches an in-process daemon over the unix loopback and completes `machine.attach` before tool ports publish; every failure in that chain is the typed startup refusal `self_attach_failed {cause}`; `apps/openomni/src/bundles/tools/` has no local execution path (`node:fs`, `Bun.spawn`, `localBash`, `kind: "local"` all grep 0) — prefix-less paths resolve to the configured default machine via `parseLocus(input, {defaultMachine})`, relative paths refuse, bash runs on the daemon (absolute `cwd`, daemon-bounded execution), and `openomni machine attach` still attaches a remote daemon alongside self. | `packages/machines/`, `packages/protocol/src/machine/`, `packages/machines/src/ipc/`, `packages/machines/src/reconnect.ts` |
| Code mode | Public factory supplies machine object handles named after the tools (`read/write/ls/bash/eval`) and `cell.run/peek/stop`. The injected daemon runner owns lazy per-tenant Python processes, parallel/completion helpers and callback routing. The brain facade never spawns Python. Cancellation and close propagate across the attachment and await process cleanup. App VFS, cell registry and old machine methods are deleted; the single `eval` tool delegates to codemode: `run` waits `timeout` seconds then answers `running` with a `cell_id`, `peek` reads the streamed partial output (`machine.peek_code`), `stop` interrupts and settles the cell as `cancelled` with its output, never re-running it; a ten-minute ceiling bounds background cells. Cell-only `completion({prompt, model?, system?, schema?})` has a 32-call per-catalog budget; a `schema` answer is validated host-side and returned as canonical JSON; batching is the cell's `parallel()`. | `packages/codemode/src/`, `apps/openomni/src/composition/codemode.ts`, `apps/openomni/src/bundles/tools/eval/index.ts`, `apps/openomni/src/bundles/tools/completion/index.ts` |
| Tool catalog and prompts | The catalog is sealed (#949): eleven model-door tools `read`, `write`, `edit`, `ls`, `find`, `grep`, `bash`, `eval`, `monitor`, `send_message`, `provision` plus the cell-only `completion`; snake_case names, one `op` discriminator under `operation` for eval/monitor/provision, flat `tools/<name>.ts` (`_` written `-` in file names; `lint:tools` `[tool-file-name]` pins the correspondence). There is no `approval` tool: `provision.contact_promote`/`contact_merge` carry `require_approval` policy rows resolved through the kernel request path. `lint:tools` and the catalog test pin the exact set and refuse retired names. The prompt builder accepts model tuning only; deleted-domain injection/instructions are absent. Dispatcher-only model truncation caps at 32,000 UTF-16 code units on a Unicode code-point boundary, with exact dropped/original UTF-8 byte counts; cell values stay full. | `apps/openomni/src/bundles/tools/core/catalog.ts`, `apps/openomni/src/bundles/prompt/`, `packages/agent/src/core/tool.ts` |
| CLI and composition | Start/onboard/daemon/doctor/logs and npm staging belong to the app. The minimal `openomni machine attach <config.json>` composes the retained machine daemon wire; Resident `openomni daemon` remains unchanged. Reversible composition owns both boot rollback and reverse-order shutdown. | `apps/openomni/src/cli/`, `apps/openomni/script/build-npm-package.ts`, `apps/openomni/src/composition/boot.ts` |

#949 stage 1 removes the target-selection workspace and capability-based catalog fold; call-time admission belongs to executor `tool.pre`. Model fallback selection belongs to `packages/llm`. Together with #991's codemode workspace, the generated topology describes twelve workspaces. The standalone waiting/approval folds and stores are removed by #969. #949 stage 2 seals the catalog, folds approval into `provision`, and drops the catalog's conditional Proxy port scaffolding: every tool is constructed statically and refuses at execution when its port is absent. #949 stage 3 adds `eval` `peek`/`stop` over a background cell registry with streamed partial output, `completion` options `{model, system, schema}`, and renames the codemode handle methods to the tool names.

## G002 ledger authority cut (#930)

On `kernel/s1-authority-cut-2` (2026-09-18), session `action` is the single ordered action history. Each append stores `prev_hash` and `action_hash`; `storage/l0-hash.ts` owns hash framing over the stored bytes and metadata. Migration 0039 validates contiguous per-session ordinals before backfilling links. `SessionHandleStore.verifyChain(sessionId)` returns an intact head/length or the first broken ordinal with expected/actual hashes; it verifies equality, not policy.

The separate `ledger-core` event/head store is deleted. `decision_fact` holds first-writer-wins keyed facts with a row hash: record returns either the newly recorded fact or the existing fact, and routing/admission callers replay that stored result. Migration 0040 preserves recognized historical stream heads as decision facts and refuses unrecognized stream classes before dropping the retired live tables.

App monitor, boot runner selection, message decision identities, platform-message lookup and outbound receipt recovery use `actionById`, `latestGenerationFor`, `policyDecisionRuleIds`, `messageActionByPlatformId` and `outboundReceipt`. SQL selects exact keys/kinds; schema decoding and the existing configuration fold remain ledger-owned. App source no longer loads `tree()`; agent history/fold consumers retain it. No new policy judgment or writer is introduced.

## #946 messaging cutover

The app exposes one `send_message` tool and one two-argument gateway ingest. Driver facts carry no authority. A/B message rows, tier and actor-grant preflight, transactional root/child inbox writes, source-owned outbound obligations and idempotent receiving inbox mail, durable reply-grant recovery and actor receipt distinctions are wired. Native, process, WebSocket and code-mode integration tests exercise the actual composition roots.

#969 replaces the former message-specific answer/deadline writer with the canonical request transition and an alarm projection. The request retains the original action binding and deadline; answer, timeout, refusal, and cancellation compete for one terminal action. Source terminal commits an outbound obligation; receiving acknowledgement is idempotent, and `LedgerSession.Commit.receive` is restricted to the committing session. **#947 supplies the shared live alarm worker; request deadlines use its `at` rows and the canonical request transition.** The earlier #946 deadline and native-delivery receipts do not, by themselves, verify these replacement paths.

The legacy tool trio, separate worker-run stores/process ACK lifecycle, channel return-value writeback, trigger rules and GitHub normalizer are deleted. Migration 0035 refuses nonempty retired tables rather than discarding their data; 0036 adds the bounded durable reply-grant projection. Historical migrations remain immutable. The coverage baseline is unchanged.

## #969 request waiting and delivery

The protocol exports SessionTransition under the existing session/action vocabulary. Gateway requestId/requestSpec/requestContext identify the original action; channels retains physical chain precedence, pins, responder matching, grants, egress budgets, idempotency and accepted/rejected/unknown receipts, while injected kernel ports decide request transitions. Typed Owner answers use the same authenticated gateway ingest, with no credential written to history. The model-facing protected-mutation tool no longer exposes request/decide operations or an approval-id bypass. Protected domain preconditions are checked again inside the actual mutation transaction.

Migration 0038 extends action/policy kinds with request/reply/outbound. It retains terminal legacy rows indefinitely in immutable archive_969_wait and archive_969_approval tables before removing the live tables. The preflight refuses unresolved, malformed, incoherent, or still-follow-up-visible rows before mutation; it cannot reconstruct an original invocation from old records. Historical migrations are unchanged. Unresolved legacy message alarms and native child inputs/turns also refuse; no captured invocation is guessed. Native message/part retention and the explicitly confirmed #967 archive procedure remain separate. Scoped pragma statements are finalized before rebuilding tables, including on Bun 1.3.6.

The executable census is `bun run script/request-authority-census.ts`; its test is `script/conformance/request-authority-census.test.ts`. It scans production, fixtures, and public schema with git grep, including untracked local files. Only enumerated archival SQL operations and one historical hash-chain event are excepted; no test tree or API-bearing file is excluded. Reintroduced store/interface, SQL writer, serialized correlation, and untracked fixture mutants must be rejected. This is a lexical/AST deletion guard, not proof against dynamically assembled SQL or renamed replacement engines. Behavioral tests exercise real Owner WebSocket consent after SIGKILL and two restarts, exact-invocation at-most-once execution, domain and principal refusal, answer/timeout/cancel CAS, real Telegram correlation, native/process replies and receiving-consumer failure discrimination. A copied-tree mutant that drops receiving intake fails the real app end-to-end test.

The producer manifest no longer permits independent waiting/approval streams or the deleted commit coordinator. The dependency manifest permits agent only for channels tests; production channels imports remain protocol/policy/ledger. Reviewed snapshots contain SessionTransition and the restricted protected-mutation catalog. The PR records the #969 gate results and unchanged coverage floors. This does not close the broader #945/#948 campaign.

## #970 durable recovery and typed restoration

`packages/agent/src/executor-recovery.ts` (since #1247 `packages/agent/src/kernel/gate/decide.ts`) owns the recovery product. Every intent records its `recovery` classification (`local_transactional`, `endpoint_idempotent`, `read_back_reconcilable`, `ambiguous_no_replay`; kernel-local compaction/message intents default to local-transactional, everything else to ambiguous-no-replay). A post-body exception at `post_policy`, `reverter` or `result_commit` reads the original terminal slot first, settles `failed` from the body's known evidence and treats a thrown reverter as no proof of rollback; a refused recovery commit propagates and the intent stays recovery-pending. `DurableExecutor.recover()` settles crash-open intents: an ordinary open tool records one `outcome_unknown` with no body, a lost provider attempt makes the logical llm outcome unknown rather than silently retrying, an llm whose attempts all settled fails from that evidence, and local projections fail from the ledger read-back. Request-bearing waves stay with the captured tool dispatcher, which now runs executor recovery before its captured waves and never runs a tool.

The provider retry owner is unchanged (`createAttemptRunner` in `packages/agent/src/executor-attempts.ts`, since #1247 `packages/agent/src/kernel/gate/decide.ts`); each attempt intent pins `attempt`, `maxAttempts` and `retryReason`, and the settled result carries the llm `AttemptEvidence` (usage, `visibleOutput`, finish reason, `Auth.reference` credential handle: type plus a 16-hex digest, never the key). Provider retry, crash-open resume and goal continuation remain distinct budgets with their own durable parents and IDs.

`restore_model_selection` (`packages/agent/src/model-selection.ts`, `packages/agent/src/core/execution/run.ts`; since #1247 `plugins/model-selection.ts` and `kernel/turn.ts`) runs at the turn boundary when the earlier turn's last chat attempt ended on a configured fallback: an executed action releases the primary, a refused one keeps the fallback pinned for the turn with the policy decision as the only record. `restore_context_projection` (`packages/agent/src/bundles/compaction/restore.ts` — since #1247 `plugins/compaction/restore.ts` — `SessionHandle.restoreContext`, `createSessionAdmission.restoreContextProjection`) rebuilds the projection from the compaction's own recipe under the held lease and appends it as a compensation with the compaction as parent; unknown or unexecuted compactions are refused before anything is recorded, and the original compaction facts are untouched. The contract's proposed relocation of admission/turn code into `session-lifecycle/*.ts` did not happen; the owners stayed in place until #1247 moved them into `session/` and `kernel/`. Tests: `packages/agent/test/executor-recovery.test.ts`, `core/model-restore.test.ts`, `model-selection.test.ts`, `session-context-restore.test.ts`, `session-chat-runner.test.ts`, `core/execution/llm-attempts.test.ts`, `packages/llm/test/run-outcome.test.ts`, `packages/llm/test/auth/storage.test.ts`.

## #971 monitor occurrences and evaluator recovery

The #947 alarm band is hardened against the transition contract without a second monitor, table or engine. `Alarm.Fire` (`packages/protocol/src/ledger/l0.ts`) carries the evaluator's transport `sourceKey`; the caller-minted `actionId`/`inboxId` and caller-supplied `limit` are gone. `alarmOccurrence` (`packages/ledger/src/storage/l0-action-builders.ts`) is the single admission judgment shared by the SQLite adapter and the in-memory test double: stale epoch/fence, pre-due time, consecutive equal poll batch, persisted `timeout_ms` deadline and persisted `notificationLimit` are decided there from the committed row. The occurrence action id is `Alarm.occurrenceId(alarmId, epoch, sourceKey)` and the prompt inbox id is derived alongside it, so redelivery of one committed occurrence appends nothing and leaves the session revision unchanged. Recurring matches stay armed; exit/timeout/one-shot complete; the N+1th match under a budget of N commits exactly one `alarm.paused` prompt and fences the evaluator; cancel and rearm fence before the band closes the source.

Recovery modes are unchanged in kind and now visible in identity: takeover (`acquire`) advances the fence and preserves epoch, notification count and dedupe digest, so a restarted idempotent poll that prints the same batch is suppressed and the next distinct batch delivers; explicit `rearm` advances the epoch and resets both. A non-persistent (timed) watch found running at band restart settles with a `restart` summary; live PTY output in the gap is never replayed; cursor-capable backends were not added. `createAlarmWorker` (`apps/openomni/src/composition/alarm-worker.ts`) keeps only OS handles, the per-source line counter and the recovery flag; the path source hands its stat identity to the ledger as the occurrence key and keeps its snapshot only to classify create/modify.

Tests: `apps/openomni/test/monitor-occurrence.test.ts` (distinct occurrences and zero-duplicate redelivery, takeover-vs-rearm dedupe, N+1 contenders, ledger-decided deadline, real PTY occurrence key), `packages/ledger/test/storage/alarm.test.ts` and `alarm-control.test.ts` (SQLite/memory parity, budget from the persisted spec), and the existing `alarm-boot-durability`, `alarm-worker-boundaries`, `monitor-budget`, `monitor-deadline`, `monitor-tool-boundaries`, `monitor-process-group` and `monitor-app` suites for evaluator restart, session hibernation and deterministic source shutdown. The contract's ALD/ALA/ALX relocation targets and `AlarmTransition` schema were not built; `session-lifecycle-contract.md` records the landed owners.

## #973 lifecycle conformance

`packages/agent/test/session-lifecycle-conformance.test.ts` is the section 6 HARNESS of the [lifecycle contract](session-lifecycle-contract.md). Each step of a trace runs against the real `SessionHandleStore`, session controller, `createExecutor.runBatch`, `createSessionRequests`, outbound dispatch and alarm rows, then snapshots the complete durable product of every traced session and checks: history only grows and keeps its prefix; every parent action precedes its child in the same session; at most one terminal per turn and per result slot; each inbox row is consumed at most once; exactly one `ledger.action.committed` observation per committed action. After the last step the file-backed SQLite image is reopened and the fold must equal the last prefix while dispatched bodies, tool observations and commits stay `[]`.

Measured against the landed #969-#972 tree: integrated wave revisions are 9/30/30/30/26 (ordinary, approved, refused, timeout, interrupt); the durable deadline fires once and a duplicate timer or late approve commits nothing; every losing contender on a closed request is recorded once per distinct input id as `duplicate`, `late_unknown` or `rejected` and never changes the winner (a seen reply id replayed by another principal is one `duplicate` in the pure authority, a record-free `rejected` at the store); a misrouted answer is refused before any record (destination revision, action count and `seenReplyIds` asserted unchanged; the request-id routing check is pinned in `session-request.test.ts`); the winning reply is delivered as pending inbox input keyed by its input id (inbox ids are store-wide); resume keeps the interrupted turn's messages and mints a new turn/result under the latest generation while crash-open recovery keeps the pinned turn, result and generation; a boot sweep resumes every open turn in the store; a child's reply survives a lost destination wake and a lost source ack with exactly one parent inbox row and one parent consumption; alarm takeover preserves epoch/count/digest and rearm resets them.

Not established here: the #945 receipt at final HEAD (any/unknown zero, clone zero, coverage 100%, complexity/Halstead/CRAP bounds, surviving mutants zero). The conformance file itself has no `any`, no `unknown`, and every unit below cyclomatic/cognitive 22 by the pinned analyzer; the campaign-wide receipt remains #945's.

## I09 deletion receipt synchronization

The A-row domain deletions below pass their exact production grep at the verified source. No production deletion is attributed to #948. [SLOP.md](SLOP.md) also records two archival-only semantic matches and three still-exported #944 G-CH9 callback types; those expanded acceptance gaps are not labeled zero. Exact identifiers and commands stay outside the active-contract grep surface.

| Rows | Disposition | Merged evidence |
| --- | --- | --- |
| A1, A2, A5 | Dormant transcript persistence, unused surface claim, and runtime integration client removed. The live ephemeral transcript fold survives. | #944 / PR #963, `b44cd76e` |
| A9 | Historical test-only export list was already zero; no invented deletion. The #948 source-pin empty-baseline Knip run reported twelve workspaces, zero issues. This is not proof of #945's stricter production-consumer census. | #944 / PR #963; current gate receipt in SLOP.md |
| A13 | Old task-ticket/completion domain, tools, schemas, and stores deleted. Later owner-schema correction consumed through #967. Generic provider-attempt history is unrelated and remains. | #940 / PR #960, `6c5d65d6`; PR #977, `eec7f7fc` |
| A14 | Built-in curated stores, mutation tool, config, and prompt injection removed without replacement. Local user files are not migrated by this docs update. | #941 / PR #958, `d35cdd39` |
| A15 | Blob store/schema/adapter/tools and spill removed; distinct model/cell output handling survives. | #942 / PR #959, `7edfe5d2` |
| A4, A16 | Dialogue-window, send-permission, and engagement domain stores/schemas/tools removed. Ordinary gateway send remains; #969 moves waiting to original-action request state. | #943 / PR #961, `23ad4f6b` |

Historical migrations remain immutable. The migration runner applies both 0030 deletion migrations, 0032's guarded dormant-table drops, 0033's session-handle lift, 0034's archive disposition, 0035's guarded retired-table deletion, 0036's reply-grant projection, and 0037's watch-alarm state. Source-level grep-zero does not mean that every historical identifier or every retained archival byte is gone.

## #937 and #967: merged corrections versus remaining retention

PR #985 (`c4fb7748`) completes session-loop convergence after #980: three inbox drains surround each model step/tool wave, then compaction and captured stop policy run. Approval covers the whole wave; positional results, sequential barriers, and live raw-effect lease retention remain. Visible text/tool output forbids provider replay. Missing/changed captured executable catalogs fail closed; crash-open recovery keeps captured IDs/generations, while terminal resume starts new ones. The #946 cutover replaces the earlier worker transport with session inbox messages.

The #967 corrections are merged: subprotocol-only authentication (#974), legacy session authority deletion (#975), unused fact-tap removal (#976), and native archive/retired-owner disposition (#977/#978). GitHub currently marks #967 closed. This document does not infer physical data deletion from that label: `message` and `part` remain in the source schema; #969 retains terminal waiting/approval records only in immutable archival tables; canonical history is written as actions.

The archive CLI creates a native SQLite image plus a v2 all-table receipt at explicit paths. Verification restores a temporary copy rather than opening the operator archive writable. `--dispose-967 --approve-manifest-sha256` revalidates the archive/receipt/source before guarded migration `0034_u967_archive_disposition`, in the migration transaction. Eligible retired Wait projections and archived bus rows are removed only with approval; the empty bus table is dropped. Ordinary boot does not archive implicitly. Message/part retention is not a DROP receipt and remains a final-convergence consideration for #945/#948, even though #937 is now merged.

## #1259 slop cleanup sub-PRs
Band b5 (`epic1260/1259-b5-openomni`) cleans apps/openomni composition, tools and delegation-cli items per the #1259 inventory: the dead `OPENOMNI_DB_PATH` test env var is deleted, the five boot-composition `console.error` incident sites publish `Operational.Events.Error` through the ObservationSink, `index-coverage.test.ts` is renamed `app-surface.test.ts`, `createMonitorTool` takes explicit `MonitorPorts | undefined`, find's `relativeTo` refuses a walk outside the search root, and eval's `signal` is the non-optional `AbortSignal`; items 118/133 defer to band 7's file ownership and eleven items keep with rationale — full per-item account in [SLOP.md](SLOP.md#l-1259-sub-prs).

Band b4 (`epic1260/1259-b4-channels`, commit `c1420c6e`) cleans packages/channels per the #1259 inventory: duplicated normalizer guards deleted from the telegram/discord surfaces, handler casts replaced by `requireHandler` binding, the floating telegram poll-loop promise annotated with `void`, the stale `DeliveringSurface` comment pruned, `verifyGitHubSignature` moved into `src/authn/` beside its only consumer, and a duplicate file-level `beforeEach` removed from the send suite — net LOC negative, zero behavior change; full per-item account in [SLOP.md](SLOP.md#l-1259-sub-prs).

Band b2 (`epic1260/1259-b2-agent-llm`) cleans packages/agent (core, session entity, compaction plugins, tests, model, store, gate) per the #1259 inventory: 17 items fixed (dead `runResult` options and `guardAborted`, one execution-authority refusal, a single `RetryReason` z.enum, deduped `requestSnapshot` reads, `Effect.retry`-native revision retry, zod-first `CompactionRecord`, zod row parsing in the surface-key adapter, the unreachable `writable()` gate, `evaluatedRuleCount`/`bucket` diagnostics, source-regex test ratchets, two stale comments, one rename, one flattened test loop), 23 kept with rationale, 11 deferred to bands 5/7, 11 re-verified as already resolved — net LOC negative, zero behavior change; full per-item account in [SLOP.md](SLOP.md#l-1259-sub-prs).

Band b7a (`epic1260/1259-b7a-xc`) sweeps the cross-cutting items outside `packages/agent`: knip.json stale ignore lists and eight redundant entry patterns deleted, `productionConsumerFindings` merged into `censusConsumerFindings`, the schema-only `runtime.workspace_lock` policy effect deleted, codemode's `decodeCodeFailure` rewritten as a plain instanceof dispatch, the provisioning `reconcile` pass-through inlined, cluster fixture clocks made deterministic, and stale H13 barrel claims corrected — 8 fixed, 18 already resolved upstream, 24 kept with rationale, net LOC negative; per-item account in [SLOP.md](SLOP.md#l-1259-sub-prs).

Band b7b (`epic1260/1259-b7b-agent-final`, the final #1259 sub-PR) cleans the packages/agent cross-cutting items and the four lead-owned apps/openomni files: eight items fixed (single tool-result resolution and a collision-only tool-metadata assertion in `core/tool.ts`, the `pendingBacklog` and `SessionActionCommitPort` wrappers deleted, a stop-evidence empty-page guard, one `node:crypto` sha256 API across the model fingerprints, a top-level `ai` import, provision `replaceAll`), eighteen re-verified as already resolved upstream, twenty-four kept with rationale, none deferred — net LOC negative, zero behavior change; full per-item account in [SLOP.md](SLOP.md#l-1259-sub-prs).

## Census and final quality: current versus required

**#1116 lean PR gate (2026-09-20):** the per-PR Quality ratchet stack (census
legs, exact statement evidence, coverage ratchets, metrics/clone legs, their
receipts and the `quality-baseline-lcov-bound`/`coverage-baseline` fragments)
is deleted. PR admission is build, types, lint (including cognitive-complexity
max 21), dependency rules, tests, and the diff-scoped patch-coverage gate
(`script/check-patch-coverage.ts`); deep audits run in the scheduled
`quality-mutation.yml` workflow only. The #945 absolute-distance receipt in
[SLOP](SLOP.md#945-absolute-census-receipt-2026-09-19-main-f5ea0e32) remains
the record of quality debt at its measurement HEAD; a green lean gate makes no
claim about it.

| Gate/row | Current evidence | Not established |
| --- | --- | --- |
| Export ratchet / A9 | `script/check-dead-exports.ts`, empty `script/conformance/knip-baseline.json`, package-entry export scan and synthetic Knip discrimination test are wired into CI. | Benchmark/test/barrel/adapter-only references are not yet comprehensively excluded as #945 requires. |
| Event pairing | `script/conformance/protocol-event-pairing.test.ts` checks declared start/terminal vocabulary. | This is not a declaration-to-production-publisher census. |
| Ledger producers | `script/ledger-producer-manifest.ts` and its drift test enumerate current append/SQL writers. | This is not an all-store production read/write consumer census. |
| E3 | No new fixture code or prose snapshots in this docs patch. | Reproducible separate production/test clone-zero receipts remain #945 work. |
| E4 | Required by the Owner-approved #945 amendment; **not parked**. | Explicit/implicit TypeScript any type0 and unknown type0, with no boundary exemption. |
| E5 | Script tests and the per-PR patch-coverage gate exist (#1116 deleted the script coverage ratchet lane). | Campaign-wide coverage100%, complexity and mutation guarantees, including the gates themselves. |
| E7 | Runtime prompt has no deleted injection or tool instruction; structural assembly assertions already exist. | `apps/openomni/test/prompt.test.ts` still pins code-mode prose. E7 is not closed by a documentation-only PR; a negative signature/sentinel mutation gate is not claimed shipped. |

#945 remains open. Its acceptance also requires cyclomatic<22, cognitive<22, Halstead difficulty<80, CRAP<25, surviving mutants0, frozen analyzer versions/inventory/settings/coverage dimensions/operators, and full scheduled/final-convergence mutation execution. A passing ratchet or lint command does not establish any of those absent receipts. Local verification results, including pre-existing failures, are recorded in [SLOP.md](SLOP.md); no zero-failure campaign receipt is claimed.

## Parked and otherwise unimplemented

- [#950](https://github.com/INONONO66/openomni/issues/950) remains `icebox`, outside #930, superseding closed [#811](https://github.com/INONONO66/openomni/issues/811). It owns machine-offer isolation capability/fail-closed execution and the gateway egress secret gate. Kernel trust-boundary placement does not decide sandbox profiles or scanner semantics. Re-triage follows #938/#939 and #946; all three are open at verification. No sandbox/scanner implementation is included here.
- #949 stays open after stage 3, which landed `eval.op = run | peek | stop` over a background cell registry, `completion` options, and tool-named codemode handle methods for the five operations the machine wire carries (`read/write/ls/bash/eval`). Not landed: the `edit`, `find` and `grep` handle methods from the Owner amendment. Those tools are compositions the app tool layer builds over `read/write/list/stat` (`apps/openomni/src/bundles/tools/{edit,find,grep}.ts` on `core/filesystem.ts`); the codemode plane (`packages/codemode/`, #1246 fold reversed by #1272) sits below that layer and the wire has no such op, so offering them in the cell without duplicating the tools means hoisting that composition into a package both can import. Until then the handle set is the five above and a cell reaches the other three through `tool.edit/find/grep()` proxies. Continuous alarm scheduling stays #947; #969 acceptance uses the behavioral and deletion receipts above, not only its census; machine handles and codemode are described above.
- Connector definitions and installation schemas are not an installed connector execution host. The dormant installation store is deleted.
- Governor/Jester/Voice, Stakes and effective-authority target consumers, dynamic reactive composition, and any later memory/search redesign are not promoted to shipped by retained design prose.

## #1259 slop cleanup ladder
Band b3 (machines + codemode) landed on `epic1260/1259-b3-machines-codemode`: the `RootWalk` alias is deleted, the duplicated `peek`/`stop` open-check is folded into `tenantCell`, and the unexported `Options` interface is renamed `CodemodeOptions`; the zod boundary parses in `exec.ts`/`failure.ts` stay (written-types gate: the untyped thrown value is owned by the parse), item 108 is deferred to PR #1293's ownership, and item 109 was already resolved on main.

Band b6 (`epic1260/1259-b6-ui-script-gates`) fixed item 171 (the quality-native-process excerpt-size comment now matches `ERROR_LIMIT`, 20 kB), and kept the remaining 15 ui and script-gates items with one-line rationales in the §L table of [SLOP.md](SLOP.md); the mechanical triage had labelled items 167/173/174/179 as resolved by #1241/#1037/#1015/#989, and review r1 disproved each against origin/main `79649f3c` (the symbols and concerns still exist), so the row records them as keeps with the inventory's own rationales.

## #1356 agent residue baseline

#1343 landed the shrink-only comment-residue gate (`script/check-comment-residue.ts`): every `packages/agent/src` file carries tight pins for issue-number comment lines and `// ───` dividers (491/52 at `d9800ad74`, plus one exact structural-header exemption in `inspect/index.ts`, allow-list budget <=10 enforced by the gate), comment lines classified from TypeScript comment-trivia ranges; the package comment ratio (1425bp = 3485/24454) is a growth-only CEILING (adding plain code passes), while the over-six-line JSDoc count (126) is a tight pin — growth and slack both fail, so cleanup (#1344) lowers pins in the same PR. The issue's 97 JSDoc count is not reproducible under any line-span definition; the ceiling is the measured 126 under "spans > 6 physical lines". `check-deps.ts` additionally pins direct agent-core responsibility tokens referenced from `apps/openomni/src` code (19 across five files: cluster-runtime 5, ingress-executor 2, message-session 1, index 6, process-entry 5), counted by AST walk — code references only, never comments, strings, template text, regex literals or JSX text; token-pin slack is judged inside a git checkout only (worktree `.git` files included) and the skip outside one is a single loud NOTICE. No residue was removed and no production code changed; the Dependency Rules CI job runs both gates.
