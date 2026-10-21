# Kernel Reference Pins

This document owns the tracked source pins for the kernel campaign. It grounds the
2026-09-17 owner decisions in `final-kernel-design-20260917.md` section 12.

## Pins

| Source | Repository | SHA | Role |
| --- | --- | --- | --- |
| Codex | `openai/codex` | `ee6814bf` | Append-only rollout, SQLite durability, retry, projection, and abort ordering reference. |
| OpenCode v2 | `anomalyco/opencode` | `7c5a4d01` | SQLite-owner layout and retry scheduling reference. |
| OmO | `code-yeongyu/oh-my-openagent` | `1d22bc26` | Durable task records, fallback chain, delivery fencing, and lost-terminal reference. |
| OpenClaw | `openclaw/openclaw` | `6c6dc442` | Reconnect, supervision, and delivery reconciliation reference. |
| Hermes | `NousResearch/hermes-agent` | `01382698` | Failover, cooldown, partial-response, and lease reference. |
| Effect cluster | `effect/cluster` from `effect` (npm) | `4.0.0-rc.118`, published 2026-09-28 (exact pin, no caret) | Shipped W5.2 `SingleRunner` entity runtime; rc.118 exposes the stable `effect/cluster` path, not `effect/unstable/cluster`. |
| Effect SQLite | `@effect/sql-sqlite-bun` (npm) | `4.0.0-rc.118`, published 2026-09-28 (exact pin, no caret) | Bun SQLite client used by the per-session files and shared catalog. |

W5.3 (#1113) closure runs on `kernel/1113-w5-closure-20260929` (draft PR
#1240, ⏳ pending merge): the app-owned `session_read` read model lives in
`packages/protocol/src/gateway/session-read.ts` (plain-data wire DTOs),
`apps/oni/src/gateway.ts` (the single read surface), and
`packages/agent/src/inspect/index.ts` (bounded inspection,
ancestry through 256-action history windows); the accepted receipt keeps its
frozen base shape and the durable binding travels in the additive
`session_bound` frame (`SessionRead.Bound`, review r2 Owner decision);
lane receipts are under `.omo/reports/kernel-campaign-w53/`. W5.2 (#1197)
merged as `8390912c` (PR #1239).

## Decision references

All citations below name a file and line range at the pinned SHA. The receipts at
`.omo/reports/kernel-s0/docs-pin-receipt.txt` and
`.omo/reports/kernel-s1/docs-pin-receipt.txt` record the path checks. New citations
use repository names; each resolves to its SHA in the pins table. These are source
references for adopted requirements, not claims of implemented crash guarantees.

| Decision | Decision value adopted | Reference source | Pin citation | What we absorb |
| --- | --- | --- | --- | --- |
| Persistence layout | One fresh-schema SQLite file per session plus one catalog under an `effect/cluster` `SingleRunner`; shipped in W5.2 #1197 with no legacy migration and old database files left untouched. | Codex; OpenCode v2; OmO | Codex `codex-rs/rollout/src/recorder.rs:77-89`; OpenCode v2 `packages/core/src/database/database.ts:34-47`; OmO `packages/senpi-task/src/store/record-write.ts:31-54` | Keep one durable owner store per session file, with append-oriented session evidence and atomic record replacement at the file boundary; keep cross-session facts and cluster coordination in the catalog. |
| WAL and synchronous policy | Session files use WAL plus `synchronous=NORMAL`; the catalog uses `FULL`. | Codex; OpenCode v2 | Codex `codex-rs/state/src/sqlite.rs:298-305`; OpenCode v2 `packages/core/src/database/database.ts:37-45` | Use the production WAL/NORMAL precedent only for recoverable session shards; isolate stricter catalog facts. |
| Retry, backoff, and retry-after provenance | Commit `retry.scheduled` with `notBefore`, bounded budget, and `retry-after` or estimated provenance; wait is not durable state. | Codex; OpenCode v2 | Codex `codex-rs/core/src/responses_retry.rs:92-113`; OpenCode v2 `packages/core/src/session/runner/retry.ts:63-81,130-148` | Take bounded exponential retry and provider-requested delay handling, but persist the schedule and its provenance in `packages/agent/src/model` instead of relying on an in-process sleep. |
| Fallback and model-switch recording | Append `route.changed` and child attempts; route changes never reset the logical budget. | Codex; OmO | Codex `codex-rs/core/src/responses_retry.rs:92-106`; OmO `packages/senpi-task/src/model-chain.ts:23-42,57-76` | Record each transport or model transition durably and retain one global turn budget across the fallback chain. |
| Deduplication and lost terminal | Blob content hashes are deduplication keys; owner death reaches `lost`, distinct from cancellation and unknown outcome. | OmO | OmO `packages/senpi-task/src/state/types.ts:3-13`; OmO `packages/senpi-task/src/state/transitions.ts:18-40`; OmO `packages/senpi-task/src/lifecycle/reconcile.ts:113-145` | Keep explicit loss/reconciliation semantics and use a content-hash identity for duplicate tool results. |
| Hash-chain absence | Add `prev_hash` and `row_hash` to Oni actions; this is an Oni audit addition, not a borrowed mechanism. | Codex; OpenCode v2; OmO | Codex `codex-rs/rollout/src/recorder.rs:77-89`; OpenCode v2 `packages/core/src/event/sql.ts:4-25`; OmO `packages/senpi-task/src/state/types.ts:3-13` | None of these pinned record shapes supplies a session record hash chain, so preserve the section 12 chain decision as an explicit local requirement. |
| Provider floor and logical retry budget | Persist the admitted retry deadline, provider provenance, and remaining logical budget. | OpenClaw; Hermes | openclaw/openclaw `src/agents/embedded-agent-runner/run/failover-retry-controller.ts:24-61,102-108,271-333`; NousResearch/hermes-agent `agent/error_classifier.py:33-91`; NousResearch/hermes-agent `agent/turn_recovery.py:1122-1234` | Adopt structured error classification and provider-floor/budget interaction, not volatile sleeps. |
| Error-domain separation and fallback replay veto | Coordination and repair errors are not model failures; committed work can veto fallback. | OpenClaw; Hermes | openclaw/openclaw `src/agents/model-fallback-runner.ts:588-639`; NousResearch/hermes-agent `agent/turn_api_error.py:276-372` | Classify before retry or route change; never replay committed effects through fallback. |
| Failover order and route rebinding | Walk configured routes in order, suppress equivalent backends, and fully rebind request/context identity. | Hermes | NousResearch/hermes-agent `agent/chat_completion_helpers.py:1803-1833,1905-2028` | Persist `route.changed`, perform new-route preflight, and retain the global logical budget. |
| Failure attribution and cooldown eligibility | Attribute failures to the failing route and apply eligible cooldowns only. | Hermes | NousResearch/hermes-agent `agent/fallback_cooldown.py:10-29`; NousResearch/hermes-agent `agent/agent_runtime_helpers.py:1111-1134,1175-1188` | Adopt attribution and eligibility, not in-memory cooldown durability or unconditional reset on attempted restore. |
| Visibility-aware partial-response retry | Retry before visible output; after visibility, preserve provisional/final distinctions and avoid replaying the prefix. | OpenClaw; Hermes | openclaw/openclaw `src/agents/assistant-error-transcript.ts:25-40,59-155`; NousResearch/hermes-agent `agent/chat_completion_helpers.py:3031-3062,3270-3323`; NousResearch/hermes-agent `agent/turn_truncation.py:238-349` | Use bounded continuation and durable attempt/offset evidence; upstream process-local fragments do not prove crash survival. |
| Incomplete tool arguments | Never execute an incomplete tool call. | Hermes | NousResearch/hermes-agent `agent/chat_completion_helpers.py:3487-3541`; NousResearch/hermes-agent `agent/turn_truncation.py:387-413` | Gate tool admission on complete arguments, including mid-stream failure paths. |
| Idempotent failure terminal | Flush durable buffered output before terminal publication and reject duplicate failure terminals. | OpenClaw | openclaw/openclaw `src/agents/assistant-error-transcript.ts:25-40,59-155`; openclaw/openclaw `src/agents/embedded-agent-subscribe.handlers.lifecycle.ts:297-359` | Adopt provisional replacement, writer-fenced terminal identity, and flush ordering, not in-memory text as durable state. |
| Canonical-write gates and paired tool errors | Commit the assistant call block before effects; return paired errors and stop on canonical-write failure. | Hermes | NousResearch/hermes-agent `agent/turn_tool_round.py:91-162`; NousResearch/hermes-agent `agent/tool_executor.py:1600-1703` | Preserve positional call/result pairing for invalid names, arguments, and exceptions; timeout/cancellation can leave effect outcome unknown. |
| Stable recovery-dispatch identity | Persist one continuation identity before RPC dispatch and reuse it across recovery crashes or ambiguous acceptance. | OpenClaw | openclaw/openclaw `src/agents/main-session-recovery/main-session-restart-dispatch.ts:435-507` | Admit at most one continuation under the stable identity; do not claim restoration of the crashed provider stack. |
| Explicit replay-safety boundary | Recovery must classify replay safety and retain `lost`/`outcome_unknown` for ambiguous effects. | OpenClaw; Hermes | openclaw/openclaw `src/agents/main-session-recovery/main-session-restart-recovery-resume-policy.ts:126-178`; NousResearch/hermes-agent `agent/tool_executor.py:1600-1703` | Restrict recovery tools rather than silently replaying non-replay-safe effects. |
| Commit-time writer fencing | Check holder/generation inside the L0 commit; liveness observations do not grant write authority. | OpenClaw; Hermes | openclaw/openclaw `src/config/sessions/session-accessor.sqlite-transcript-write-guard.ts:16-69`; openclaw/openclaw `src/infra/gateway-owner-lease.ts:118-125,137-218`; NousResearch/hermes-agent `gateway/turn_lease.py:75-137,139-179`; NousResearch/hermes-agent `hermes_state_messages.py:181-235` | Reject stale late writes and cover shared-lineage alias collisions; optional upstream fencing is not universal effect fencing. |
| Atomic compaction publication | Atomically commit summary/boundary, successor/handoff, parent closure, and accounting after prepared-scope revalidation. | OpenClaw; Hermes | openclaw/openclaw `src/config/sessions/session-accessor.sqlite-compaction.ts:41-133`; NousResearch/hermes-agent `hermes_state_compression.py:116-199,224-305`; NousResearch/hermes-agent `agent/conversation_compression.py:3057-3124` | Restore committed compaction before runtime publication without resummarizing; retain the pre-result-commit non-durable boundary. |
| Concurrent-tail watermark | Use a trustworthy bounded watermark and ceiling for concurrent parent-tail transfer. | Hermes | NousResearch/hermes-agent `hermes_state_compression.py:280-305`; NousResearch/hermes-agent `agent/conversation_compression.py:3073-3102` | Preserve concurrent tail exactly once; atomic publication alone does not establish this guarantee. |
| Generation-fenced reconnect and Retry-After floor | Fence retired sockets/sleepers and honor accepted server delay floors, adding fleet jitter. | OpenClaw | openclaw/openclaw `packages/gateway-client/src/client.ts:367-385`; openclaw/openclaw `packages/gateway-client/src/protocol-client.ts:67-71,500-578` | Keep transport reconnect distinct from logical-turn retry and cursor replay; reconnect does not transparently replay pending RPCs. |
| Durable admission after lost ACK | Reuse the persisted admission identity across reconnect and lost acknowledgments. | OpenClaw | openclaw/openclaw `src/gateway/server-methods/chat-send-handler.ts:380-441`; openclaw/openclaw `src/config/sessions/session-accessor.sqlite-transcript-store.ts:201-205,606-631` | Extend the existing admission requirement with identity-scope and stale-generation checks, not a second deduplication authority. |
| Sent/not_sent/unknown reconciliation | Proven sent records a receipt without resend; proven not_sent can rearm pre-send state; unknown never blindly resends. | OpenClaw; Hermes | openclaw/openclaw `src/infra/outbound/delivery-queue-recovery.ts:734-824`; NousResearch/hermes-agent `gateway/delivery_ledger.py:1-10`; NousResearch/hermes-agent `gateway/run_startup.py:394-443` | Adopt OpenClaw's three-way adapter contract and Hermes's uncertainty UX; bounded reconciliation may rearm, but terminal unknown is `lost` for the delivery effect. |
| Durable delivery receipt before cleanup | Commit ACK/settlement before owner cleanup and queue removal. | OpenClaw | openclaw/openclaw `src/infra/session-delivery-queue-recovery.ts:70-100,140-163,183-230` | Recovery with a durable receipt repeats cleanup only, never delivery; this is not recipient-read acknowledgment or universal exactly-once. |
| Persisted flood deadline | Persist platform refusal time and server delay, then reconstruct the remaining delay at boot. | Hermes | NousResearch/hermes-agent `gateway/delivery_ledger.py:125-134,350-367,443-466`; NousResearch/hermes-agent `gateway/run_startup.py:337-395` | Rearm the edge timer without consuming an attempt early; this does not establish durable model cooldowns. |
| Cancellation ownership and suspect-backend quarantine | Separate cancellation request, reader-owned transport cleanup, lease ownership, and effect disposition. | Hermes | NousResearch/hermes-agent `agent/deadline.py:217-278,284-298`; NousResearch/hermes-agent `agent/chat_completion_helpers.py:3379-3461` | Quarantine suspect backends and mark user cancellation before abort; abandoned workers may still act, so retain effect fences and unknown outcomes. |
| Service crash-loop budget | Bound host restarts and treat configuration exit as non-retryable, separately from model-call budgets. | OpenClaw | openclaw/openclaw `src/daemon/systemd-unit.ts:93-118`; openclaw/openclaw `src/daemon/launchd-plist.ts:354` | Take the systemd restart-rate/configuration-exit policy without claiming that launchd KeepAlive supplies the same budget. |

## Absorb list

- Codex projection anomaly counter: use a projection-versus-fold mismatch counter for
  `visible_transcript`. Citation: Codex
  `codex-rs/thread-store/src/local/thread_history_materialization.rs:19-32` at
  `ee6814bf`.
- Codex flush-before-terminal-on-abort: preserve the durable flush before publishing
  an abort terminal. Citation: Codex `codex-rs/core/src/tasks/mod.rs:930-940` at
  `ee6814bf`.
- OpenCode retry-after provenance parsing: carry provider retry-after input and its
  bounded delay classification into `packages/agent/src/model`, then record whether the delay was
  provider-requested or estimated. Citation: OpenCode v2
  `packages/core/src/session/runner/retry.ts:63-81,130-148` at `7c5a4d01`.
- OmO `yield_sha256` dedup plus `lost` terminal: adopt content-hash deduplication and
  an explicit `lost` terminal. The `lost` half is verified at OmO
  `packages/senpi-task/src/state/types.ts:3-13` and
  `packages/senpi-task/src/state/transitions.ts:18-40` at `1d22bc26`.
  The research report's `packages/senpi-task/src/workpool/reconcile.ts` citation for
  `yield_sha256` is absent at this pin and is intentionally not cited here; implement
  the dedup key only under the independent section 12 decision and replace this note
  when a pinned OmO source is available.

- OpenClaw/Hermes provider floors, error-domain separation, and replay veto: persist
  retry schedules/provenance and preserve a global logical budget across routes.
- Hermes ordered failover, equivalent-backend suppression, full request/context
  rebinding, route-specific failure attribution, and cooldown eligibility.
- OpenClaw/Hermes visibility-aware provisional/final output; Hermes incomplete-tool
  admission rejection; OpenClaw idempotent failure terminals and flush ordering.
- Hermes canonical-write gates and paired tool errors, retaining unknown effect
  disposition for timeout or cancellation.
- OpenClaw stable recovery-dispatch identity and replay-safety classification,
  without treating a new continuation as the crashed invocation.
- OpenClaw/Hermes commit-time writer fencing, distinct from heartbeat liveness,
  with shared-lineage alias-collision coverage in the existing L0 authority.
- OpenClaw/Hermes atomic compaction publication, accounting, and scope revalidation;
  Hermes bounded concurrent-tail watermark/ceiling as a separate obligation.
- OpenClaw generation-fenced reconnect and Retry-After floor with fleet jitter;
  durable admission identity coverage for lost ACKs, not another deduplication store.
- OpenClaw sent/not_sent/unknown reconciliation and durable receipt before cleanup;
  Hermes explicit uncertain-delivery UX, not its replay-with-warning guarantee.
- Hermes persisted outbound flood deadline and boot rearm without an early attempt.
- Hermes cancellation/cleanup ownership and suspect-backend quarantine, without
  assuming cancellation stops effects.
- OpenClaw host crash-loop budget and non-retryable configuration exit, without
  assuming systemd/launchd parity.

These additions use the corresponding decision-row citations at `6c6dc442` and
`01382698`; they transfer mechanisms, not parallel stores or unmeasured guarantees.

### Conflicts resolved

- Ambiguous delivery: adopt OpenClaw's sent/not_sent/unknown contract over Hermes replay-with-warning; retain honest uncertainty UX and never blindly resend unknown effects.
- Slice numbering: use the synthesis S1-S4/section 9 crosswalk; authority precedes Effect, `llm.call` leads section 9.5, and delegation-await removal stays in section 9.4.
- Compaction overlap: one post-commit/pre-publication scenario covers accounting and successor publication; concurrent-tail preservation remains a separate scenario.
- Volatile retry/continuation: persist `retry.scheduled` and `route.changed`, retain one logical budget and provider floors, and require retry-wait rearm rather than importing sleeps or route-counter resets.
- Competing stores: absorb mechanisms into one L0 owner with same-PR legacy deletion; do not add transcript, ledger, or lock authorities.
- Liveness versus authority: require commit-time holder/generation checks and alias coverage; distinguish `cancel_requested`, cleanup, and `outcome_unknown` despite heartbeats or worker cancellation.
- Timing policy: add fleet jitter, persist admitted schedules, and attribute route failures correctly; stop/escalate when an accepted provider floor exceeds budget instead of retrying early.
- Earlier "only OmO" crash-safe delivery claim is superseded: OpenClaw delivery-queue recovery (sent/not_sent/unknown) and Hermes's delivery ledger are additional crash-aware references; OmO supplies the epoch-fenced record+reconcile reference, not an exclusive delivery precedent.
- Hash-chain/dedup evidence: retain both as local requirements; verified OmO lost-terminal sources do not prove `yield_sha256`, and rejected paths remain excluded.
- Durability/platform limits: NORMAL shards and FULL catalog remain explicit policy; process-crash evidence proves neither power-loss safety nor systemd/launchd restart-budget parity.

## Drift and verification

The local Codex, OpenCode, and OmO clones used during research drifted from these
pins. Every path cited in this document was verified to exist through the GitHub
contents API at its pinned SHA. The prior research citation
`packages/opencode/src/session/retry.ts` at OpenCode `7c5a4d01` and the prior OmO
citation `packages/senpi-task/src/workpool/reconcile.ts` at `1d22bc26` returned 404;
they are not cited as evidence above. See the S0 receipt for the original 200/404
record and the S1 receipt for this campaign's checks.

Both new pins were verified on 2026-09-18 via
`gh api repos/<repo>/commits/<sha>`: OpenClaw
`6c6dc44250d66eb8ec84f949c4a433c2dfcd8059` and Hermes
`01382698fc32ec7740b6a204d9b7a6abeac74d33`. Cited paths were checked at their pins
with `gh api repos/<repo>/contents/<path>?ref=<sha> -q .sha`; the S1 receipt records
the 200/404 results. Source existence is not runtime conformance: the synthesis's
nine proposed crash scenarios remain unmeasured, including compaction publication,
concurrent tail, stale writer, and remote-send/receipt-cleanup cuts.
