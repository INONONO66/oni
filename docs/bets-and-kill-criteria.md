# Bets and Kill Criteria

This project's founding principle is *evidence over self-report*. This document applies that principle to the project itself: the strongest standing criticisms of the design, the falsifiable bets the impact rests on, and the pre-committed criteria under which claims get downgraded. Written 2026-06-11 after a full adversarial review; extended 2026-07-03 with the philosophy-v2 bets; revisit at each checkpoint below.

## 1. Standing criticisms (the indictment)

Kept here so they cannot be quietly forgotten. None are refuted yet — they are answered only by the measurements in §2–3.

1. **An OS with one app is not an OS.** The dispatch "syscall table" currently has exactly one caller — our own Resident. Until third parties target the ABI, "OS" is branding. (→ T1, #216)
2. **The kernel is a convention, not a privilege boundary.** Kernel and userland share one Bun process; only three guarantees are mechanism-enforced today, and the Resident still holds direct MCP tools — a gate with a side door. (→ T2, #218)
3. **`await world` is less novel than claimed.** Temporal/Restate/BPM have done day-scale suspend/resume for years. The genuinely new part — correlating messy human replies — is also the most fragile part. If disambiguation-by-Resident becomes the common case, we built a clerk's inbox, not a primitive. (→ H1)
4. **The evidence loop is statistically anemic at personal scale.** ~10–50 tasks/week fragmented by (cause × task type × executor) gives n=1–3 cells; the ratchet has no statistical power; model swaps reset evidence. The gate verifies *occurrence*, not *quality* — "trust through evidence" is honestly "receipts plus a different LLM's opinion." (→ H2, H3)
5. **The Governor presumes stable root causes; LLM failures are often stochastic.** Confabulated causality hardened into policy; policies accumulate with no garbage collection. (→ H3, ossification guard)
6. **The single Resident is a bottleneck and an injection surface.** External content flows through worker reports into the judge's context; the gate checks evidence *existence*, not content *safety*. Prompt injection via a seller's reply is the most under-addressed threat. (open design item)
7. **The control group is cheap.** Claude Code + cron + a Telegram bot + a notes file covers much of the value if the bets fail. One operator maintaining a kernel is the homelab trap: the OS becomes the hobby, not the tool. (→ B7)
8. **Metaphor cosplay risk.** Every "OS-like" idea must answer *which of T1–T5 does this advance?* No answer → decoration.
9. **Self-serving definition risk.** We defined "Agent OS" in a way we are positioned to win. T4 (truth) being the category's missing duty is our belief, not proven market need. Guard: external validation signals count more than our own conviction.
10. **Role proliferation risk (new, 2026-07-03).** Resident + Governor + Jester + Voice for one operator is a lot of moving judgment. Each new role must earn its keep by its own bet below; a role whose bet fails gets deleted, not defended.

## 2. The original falsifiable bets (2026-06-11)

| Bet | Claim | Metric | Kill criterion |
|---|---|---|---|
| **H1 — correlation is real** | Replies from humans auto-match to waiting work on messy channels | Auto-match rate; Resident-disambiguation rate | Auto-match **< 70%** sustained after tuning → `await world` downgraded from "primitive" to "assisted inbox" |
| **H2 — autonomy compounds** | Owner's *unplanned* interventions per completed task decline as evidence accumulates | Unplanned-rescue count / completed task, 8-week trend after #215+#216 | No downward trend over 8 weeks → self-improvement narrative dropped; Governor frozen at reporting |
| **H3 — the Governor is net-positive** | Structural fixes prevent recurrence without ossifying | (fixes with recurrence = 0) : (rolled-back fixes) ≥ **3 : 1**, and policy growth doesn't cut throughput | Ratio missed or throughput degrades → Governor demoted to weekly digest generator |

## 3. The philosophy-v2 bets (2026-07-03)

The new roles and framings from the v2 philosophy each carry their own kill switch.

| Bet | Claim | Metric | Kill criterion |
|---|---|---|---|
| **B4 — the challenge is real** | An evidence-citing Resident objection produces corrections the Owner actually adopts | Adopted corrections originating from Resident objections, first 8 weeks after the challenge machinery ships | **0 adopted corrections in 8 weeks** → the "cognitive layer" framing is demoted; the Resident is redefined as a router with taste |
| **B5 — the Jester earns its seat** | Cheap real-time doubt catches real inconsistencies | For mature adjudicated `jester.raised` challenges, Governor precision is exactly `adopted/(adopted+dismissed)`; a zero denominator is `insufficient_data`, while `answered_with_evidence` and `conceded` are reported separately | Once at least one mature challenge is adjudicated, precision below the tuned threshold, or Owner mute as an independent kill signal → demote or delete the role |
| **B6 — ingestion is earned per domain** | Always-on observation of a domain measurably improves judgment/challenge quality | Proactive interventions from that domain that get adopted, M weeks after promotion | **0 adopted** → domain demoted back to on-demand |
| **B7 — the existence bet** | The kernel pays off only when stakes are real | (a) evidence gate catches actual false/overstated completion claims; (b) high-stakes delegation (money / external humans / public output) actually occurs in regular use | Neither materializes in sustained regular use → Oni is "OpenClaw with extra steps"; adopt an off-the-shelf companion and retire the kernel ambition |
| **B8 — raw beats summary for the Governor** | Raw-trace diagnosis outperforms summary-fed diagnosis (the Meta-Harness ablation, reproduced on our incidents) | Root-cause hit rate: raw-access diagnosis vs summary-only, on the same incidents | Raw shows no advantage → drop the greppable-export kernel requirement and revisit storage costs |

Guards without full bets: **bypass erosion** (if direct-to-Worker sessions exceed a sustained share of interactions, the single-interface model is re-examined rather than enforced) and **Goodhart on adoption** (semantic evaluation must stay independent of the Owner-adoption signal; if evaluator scores start tracking adoption, recalibrate).

## 4. Checkpoint cadence

- **C1 — `C1-restart-refute-reconcile-replay` ([#494](https://github.com/INONONO66/oni/issues/494); checkpoint/order in [#459](https://github.com/INONONO66/oni/issues/459))**: Resident appends WorkItem W before delivery; attempt A receives a unique ID/sequence, sends an awaited granted message to existing agent E with no allocation delta, and appends W's durable `Wait`. After process exit, restart folds the Wait, correlates E's reply, and resumes without replacement allocation. A's known-bad evidence is `refuted` with the checked predicate and W remains incomplete. Retry B receives a distinct ID/sequence with `retryOf=A`; A and B may share content/environment equivalence keys and both persist. B appends a generic effect intent, performs one idempotent fake effect, crashes before confirmation, then restart reconciles that same intent and proves exactly one effect before accepted evidence permits completion. JSONL/sidecars export the full identity, Wait/reply, refutation, intent/reconciliation, and completion chain. Replay from the recorded key/manifest reproduces commands and the final fold, proves legacy upcast, fails loudly on reducer drift or missing input, and performs zero live LLM, network, or device calls.
- **C2 — #215 + #216 shipped**: preserve the pre-existing T1/T3 inspection boundary; H1 measurement begins.
- **C3 — 8 weeks of regular use after C2**: H2/H3 verdicts; B4–B6 verdicts if the roles shipped; Verdict section appended with the numbers.

## 5. Qualification status

[Implementation Status](implementation-status.md) alone records which mechanisms behind these bets are currently wired.
