# Compaction & Context Window Design

Last verified against `feat/compaction-hardening`: 2026-09-02 (P0 production summarizer and speculation wiring). Design target document; [`docs/implementation-status.md`](implementation-status.md) alone says what is wired. Supersedes the two open Phase 3 rows of the archived agent-core rewrite receipt ("cut planning, incremental summarization" and "speculative overlap (D8)"; git history, `docs/agent-core-rewrite.md`) — those rows resolve here.

## Session-loop contract (#937 continuation)

The session hydrates full assistant/tool snapshots from append-only `message` actions, preserving their original IDs. Compaction runs through the same executor under `turn.post/compaction`; its result contains the replacement projection, summary, unchanged first-kept entry, inclusive discarded range, canonical SHA-256 digest, and complete revert entries. The durable result precedes observations and projection replacement. Reopen applies recorded projections without deleting original actions. Prompts committed while the summarizer runs remain separate inbox rows and enter the next loop boundary in durable order.

`compact.ts` owns the observation bracket, `cut.ts` chooses the pair-safe cut, `summary.ts` produces anchors and verbatim-user carriage, `candidate.ts` validates speculative reuse, and `estimate.ts` owns local context estimates. Provider usage extraction retains D5 semantics; valid zero counts are not clamped. Overflow enters compaction rather than generic provider retry. Summary calls use the ambient session executor and its attempt journal, including speculative calls; failed/aborted summaries retain the existing deterministic fallback/cancellation behavior.

The historical design below describes additional target features; implementation status remains authoritative.

## Outcome

The context window stops being managed state and becomes an **issued view over the ledger**: compaction never destroys information (everything elided or cut remains addressable in the ledger), user messages survive every compression byte-identical, summarization maintains one persistent structured anchor instead of regenerating prose, and the expensive summary work runs speculatively in the background so the apply seam almost never waits on a model call. Resume becomes projection recomputation, dissolving the class of defects behind [#702](https://github.com/INONONO66/openomni/issues/702).

## Principles

1. **The ledger is the record; the window is a consumable projection.** Nothing is deleted by compaction — the window drops content only by replacing it with something addressable (a recall pointer, a compaction record, an anchor version). Every shipping-at-scale runtime surveyed (opencode, pi, Amp, Letta, Zep, Mem0) has converged on this split; none treats the context window as the system of record.
2. **Asymmetric lossiness: user tokens are lossless, model tokens are compressible.** Assistant narration and tool output are regenerable derivatives; user utterances are irreplaceable intent. Summarization measurably destroys them: constraint questions answer at 19.0% exact-match from summaries vs 93.0% from verbatim artifacts (arXiv:2601.00821 v1; the v4 revision generalizes — verbatim chunks beat lossy artifact extraction by 15.9–22.0pp under an identical pipeline). So user text never depends on the summary: when the summarizer input is bounded it contains no user messages, and when the unchanged leading prefix fits beside the output reserve the summarizer sees that prefix (users included) only so the request can reuse the provider prefix cache ([#1476](https://github.com/INONONO66/openomni/issues/1476) item 3), while preservation still comes from the ledger originals. User text survives compaction verbatim (recent, budgeted) or as verbatim quotation inside the anchor **render** — quotations are injected deterministically at render time from ledger originals, exactly like the L6 artifact table, never produced by the summarizer. A guard checks byte-identity after every apply, covering both window user messages and anchor quotations.
3. **Structure forces preservation.** Summarizer output volume is largely insensitive to prompt instructions and fluctuates run-to-run (arXiv:2605.23296), so what survives cannot be steered by asking. The anchor is a sectioned checklist the summarizer must populate or explicitly leave empty, and it is **updated by incremental merge, never regenerated** — regeneration is the recursive-summary drift that OpenAI measured degrading Codex accuracy and that Factory's evaluation (3.70 vs 3.44/3.35 vs Anthropic/OpenAI regenerating approaches) beat with exactly this anchored-merge shape.
4. **One deterministic apply seam** (D8, unchanged): background work only *computes*; history is rewritten only at `run.completion.pre` via `run.replace_messages`, recorded as an effect. The freshness guard (below) is what makes speculation safe under this rule.
5. **Deterministic facts are not the summarizer's job.** File/artifact state derives mechanically from the ledger (record-before-act already captures tool effects). The one published probe-based compaction evaluation (Factory's, 36k production messages) scores all three tested methods 2.19–2.45/5 on artifact tracking when it is delegated to summarization — Factory's own explicit file sections included; senpi routes around it the same way (deterministic `extractFileOpsFromMessage`, carried across compaction generations).

## Prior art adopted

| Source | What we take | Where it lands |
| --- | --- | --- |
| pss-runtime `speculative-compaction.ts` | Two-phase prepare/promote with **no model call at promote** when the candidate is fresh; fire-and-forget single-flight scheduling at turn settlement | L4 |
| pss-runtime `snapshot.ts` / `loop-overflow.ts` | Immutable history + overlay `ThreadCompactionRecord {startSeq, endSeqExclusive, summary}`; window as projection; provider context-overflow classification → blocking compact → one retry | L3, L5 |
| senpi `harness/compaction/compaction.ts` | Anchored iterative summarization: `UPDATE` prompt receives `<previous-summary>` and merges only the newly cut span (PRESERVE + ADD + move In-Progress→Done); sectioned template (Goal / Constraints & Preferences / Progress / Key Decisions / Next Steps / Critical Context); cut-point discipline (never split tool pairs; split-turn prefix summarized separately); summary calls cache-isolated (`cacheRetention: "none"`, fresh session) | L2 (template as openomni config) |
| senpi `CompactionDetails` | Deterministic file-ops extraction carried across compaction generations — but ours derives from the ledger, not from message scans | L6 |
| Codex CLI (production) | User messages preserved verbatim through compaction (budgeted, most recent first); stale summary messages excluded from verbatim user-message preservation | L2 |
| Factory.ai evaluation | Probe-based measurement (recall / artifact / continuation / decision probes, blind judge), **tokens-per-task** as the target metric rather than compression ratio | L7 |

Headline numbers from the research corpus (all citations inline and publicly verifiable): curated context 91.6% vs full-history 71.0% task completion at 37% of tokens (arXiv:2606.10209); mid-context task collapse up to 88pp with tail re-assertion restoring to ±4pp (arXiv:2605.23170); append-only ID-addressable logs 99.40% vs 88.12% best-performing baseline in that evaluation (arXiv:2607.25066).

## Data model

```
Ledger (durable, append-only — session store + bus records):
  messages[]              full history, user text byte-exact
  compactionRecords[]     { cut range boundaries (message ids), anchorVersion }
  anchor                  versioned structured summary document

Run memory (volatile):
  window[]                the projection the model sees
  candidate               { range, nextAnchor, prefixFingerprint } | none
```

## Lifecycle

**Turn settlement (`run.turn.post` timing, per-run policy-factory state):**
- The measured window is the turn's last `step-finish` input-token count. That count is the provider's own when the provider reports a usable one, and llm's local `ceil(chars / 4)` estimate when it does not (absent, wrong-typed, or numerically out of domain) — so a step the provider failed to account for reads as its real size instead of as a zero window that never trips a threshold (`packages/llm/src/token/index.ts`, kernel §5.3).
- One geometry resolver owns the base threshold (0.45/0.50/0.55/0.60/0.70/0.80 by window tier), previous-yield feedback (±0.05, clamped to 0.40–0.85), reserve, lead, prepare, and grace boundaries. At `threshold - lead`, `prepare()` starts in the background.
- `prepare()` input = the unchanged original leading cut span when its estimate plus the previous anchor plus the output reserve (`min(32768, window/2)`) fits the context window (#1476 item 3); otherwise the bounded input: the span **minus user messages minus prior summary renders**, completed tool outputs elided, oldest messages dropped to half the context window. The summarizer receives `{maxInputTokens, maxOutputTokens, contextWindowTokens}`. Output candidates pin the summarized prefix, first-kept anchor, and latest compaction anchor.

**Apply seam (`run.completion.pre`, adaptive threshold or window yield):**
1. Elision first (existing `reduce.ts`), markers now carrying recall pointers: `[output elided: N chars — recall: <callID>]`. Enough reclaim → done.
2. Promote: candidate present, summarized prefix unchanged, first-kept anchor still present, and no other compaction landed → adopt `nextAnchor` with **zero model calls**. Appends after the cut and output elision remain valid. While preparation is in flight, the grace band defers blocking merge until `min(threshold + lead, window - reserve)`.
3. Rebuild window = `[anchor render (anchor body + ledger-derived artifact table + current-goal recitation), recent user messages verbatim within budget, protected tail]`.
4. Record structural yield in `RunState`, the run-scoped owner read by both policy geometry and the loop's next yield arm. A cut saving fewer than 1024 estimated tokens or under 10% is `compaction_ineffective`, which raises the next threshold and disarms a repeated same-run window yield. Every summarizer call has a bounded deadline (60s by default): deadline failure warns with `compaction_summarizer_failed`, uses the no-summarizer snap-cut once, and disables all further synchronous and speculative summarizer calls for that run. The run's external abort is bound out-of-band in the policy factory and propagates as cancellation, never fallback.

**Provider overflow (new):** classify context-length errors (llm package) and **re-enter the existing seam**, exactly as #651's yield does — the overflow handler never rewrites history itself; it dispatches `run.completion.pre` blocking (promote if possible), then retries the call once. Overflow is a third trigger into the one apply seam, not a second apply moment; a second overflow ends the run honestly. (pss applies mid-loop here — we deliberately diverge to keep Principle 4 intact.)

**Resume:** load messages + compactionRecords + anchor from the ledger, recompute the projection with the same rebuild function. No window state is carried; #702's class disappears.

## Delta map

| Leaf | Scope | Packages | Depends on |
| --- | --- | --- | --- |
| L1 | Elision marker gains recall pointer (`reduce.ts`); the `recall.output` tool reads the original from the session store (scoped to fact-recorded turns — resident-direct and child streams persist no tool parts and refuse loudly) | agent, openomni | — |
| L2 | `onSummarize(cutSpan, previousAnchor, {maxInputTokens, maxOutputTokens, contextWindowTokens}, signal?)` contract; unchanged prefix when it fits, otherwise bounded input with prior-summary and user-message exclusion (#1476 item 3); `[anchor, verbatim users, tail]` rebuild | agent, openomni | — |
| L3 | Replacement records preserve ordered anchor content and enough metadata for deterministic hydration; persistence is record-before-act and failures are visible | agent, ledger, openomni | L2 (anchor) |
| L4 | `geometry.ts` owns adaptive threshold/reserve/lead/grace; `speculate.ts` prepares single-flight at threshold-minus-lead; warm-anchor validity tolerates post-cut appends and elision but rejects prefix changes or another landed compaction; promoted/discarded/deferred outcomes are reason-coded | agent | L2 |
| L5 | Context-overflow error classification + blocking compact + one retry | llm, agent | — |
| L6 | Anchor render: ledger-derived artifact table + goal recitation | openomni | L2 |
| L7 | Byte guard enforced at the wrapper — tag-qualified multiset byte-identity of user text against the SEAM'S INPUT (a core-pipeline integrity check: at most one well-shaped anchor earns exemption, injected texts must match injected inputs; anchor quotations stay verbatim BY CONSTRUCTION via L6's deterministic quoting, not re-checked here), violation refuses the effect visibly + deterministic seeded probe bench (byte-presence probes with a compaction floor; the uniform side is an illustrative hardcoded baseline, the anchored side runs the real seam; blind LLM judge stays pluggable/manual) | openomni (guard + bench) | L2–L6 |
| L8 | Time carriage (#737): every cut stamps each preserved user message with a policy-injected `[recorded YYYY-MM-DD]` marker regenerated from `info.time.created` (replaced, never stacked; markers never enter the record — the replacement record carries structured `time` per kept entry instead, and hydration threads it back into `info.time.created` so a resumed cut re-derives dates from the RECORD, not from hydration time); the summarizer input is date-headed per message and the template gains a date-anchored `Timeline & Facts` section (relative time must resolve to absolute dates); the L7 guard exempts only the closed marker grammar, at most one marker per user message (the core stamps exactly one) — extras and tags around free text stay plain injected speech and fail the byte check; markers render UTC calendar dates and the anchor render carries a one-line legend whenever markers were stamped (the model must be told what a marker means — a bench-only instruction would be a primed-reader artifact) | agent, openomni | L2, L3, L7 |

L2 replaces the optional freeform one-shot `onSummarize` contract before anchored summarization becomes a required strategy. [Implementation Status](implementation-status.md) alone records which compaction leaves are currently wired.

## Risks and their guards

- **Speculation waste**: a prepared candidate discarded by the freshness guard is a paid model call. Bounded by: anchor-merge inputs are small (only the new span), cache-isolated calls, and a recorded discard rate — if live data shows waste dominating, the prepare ratio is config.
- **Anchor poisoning**: a bad merge persists across generations. Countered by the structural template (sections can be wrong but not silently absent), the byte-guarded user quotes, and L7 probes run at merge points in the bench (Slipstream-style validation is a candidate follow-up, not in scope).
- **Background work in the core loop** (first async side-work in `turn.ts`): pss's shape is the defense — the runtime owns state and commits, the policy/candidate only returns data, application stays at the one seam, and the AbortSignal linkage is run-scoped per the #692 lesson.
- **Cache economics**: append-only within a phase; history rewrites happen only at the seam (already true) and the anchor render is a stable prefix block. Summary calls never write cache (senpi rule).
