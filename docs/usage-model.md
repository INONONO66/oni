# Usage Model — Operating Oni as the Owner

Every other document describes the system from the inside. This one describes the target experience from your seat. Architecture behind these behaviors: [Core Model](core-model.md). [Implementation Status](implementation-status.md) alone records what is currently wired.

## The mental model — four things to remember

1. **You talk to one entity by default.** The Resident, on any channel. Worker management, retries, and failure handling are not your job. You *may* attach to any Worker directly (a long coding session, a peek at a transcript) — that is your root authority, and it stays on the ledger like everything else.
2. **A request doesn't end when you send it — it ends when the system finishes it.** Work survives your forgetting it, survives restarts, and wakes when the world answers.
3. **The system may push back — once.** If your instruction contradicts a recorded decision, fact, or goal, the Resident objects *with the citation*. Override it and it executes immediately, recording a receipt (the objection, the evidence you saw, your call). No repeated nagging; the receipt is later scored — when you overrode, who turned out right? — which is how its intervention threshold calibrates itself.
4. **Your interventions come in two kinds.** Planned approvals (normal, designed) and unplanned rescues (a defect, recorded as such, expected to decrease).
### Allocation, coordination, and waiting

Only the Resident allocates a new Worker assignment. A Worker may use a bounded same-domain subagent, ask the Resident, or—when granted—message an already-existing agent; none of those existing-agent messages creates a WorkItem, Worker, executor, or budget. Fire-and-forget records delivery and returns. An awaited message creates one durable `Wait`; the waiting process releases compute, and restart, reply correlation, timeout, cancellation, late or ambiguous replies, and partial/N-of-M completion are resolved from that record.

## What happens when you say something

You never classify your own request — the Resident picks the lane:

| You say | Lane | What happens |
| --- | --- | --- |
| "What was that error about?" | Direct answer | Context + memory + session search. Seconds. |
| "Turn off the lights." / "Reply to B with this." | Action | No worker — the kernel executes, audits, done. Sensitive actions (first contact, spending) come back as a one-tap approval. |
| "Research competitor pricing." / "Refactor this repo." | Delegated task | A work item is created (title, acceptance criteria, executor). What returns is a **distilled report that passed the evidence gate** — never a process log. |
| "Ask these 3 sellers for price and condition." | Waiting on the world | Messages go out in the right register; the durable `Wait` releases compute; replies — even days later — wake exactly the right task. |
| "Brief me on trends every morning at 9." | Scheduled task | The same machinery on a timer. |
| "Give this one to Claude Code." / "Worker A, change approach." | Direct targeting | Your authority, not a general one. Lineage keeps the Resident aware. |
| "I'll go check the chair myself on Saturday." | You as the executor | A work item whose executor is *you*. Your one-line report afterward ("frame's scratched, talked them down 20k") is the result — verification waived, recording not. The reality evidence chain must not break at your segment. |

## A second voice in the room

Occasionally the Jester evaluates whether a short frame-breaking question belongs next to the Resident's message — for example, *"didn't you freeze releases last week?"* It has exactly seven lenses and returns either silence or one semantic question. It has no dispatch authority: the kernel host separately records the evaluation and decides whether authorized delivery may proceed. If raised, the Resident answers with evidence or concedes; the later adopted/dismissed outcome lets the Governor score whether the role earns its seat.

## When other people message you

The assistant is openly known — people know that reaching your account or your bot reaches your assistant. What they get:

- **Pure logistics** ("what time Saturday?") — answered directly, in the register you use with that person, logged where you can always review it.
- **Money, commitments, feelings, anything novel** — escalated to you; the contact is told it will be passed along.
- Per-surface routing is configurable (which accounts auto-answer, and how far).
- Asked point-blank "are you human?" — it does not lie.

## When the system talks to you

A noisy inbox is a design failure. Only five kinds of messages reach you:

1. **Results** — deliverable + evidence-checked report
2. **Approvals** — one tap: outbound first contacts, spending, loosening permissions
3. **Objections** — one round, evidence attached, your call is final
4. **Escalations** — "tried 3 times, still failing — change approach?" / questions only you can answer
5. **Weekly digest** — what ran, what failed, what the Governor proposes (approve/reject in one place)

## Checking on things

> "What's running?" / "Show open tasks."

```
wi_3f8a  Marketplace price inquiry   ⏸ waiting on replies (2/3)   day 2
wi_9c21  Repo refactor               ▶ running (claude-code)      attempt 2
wi_b771  Weekly trends               ⏰ scheduled Sunday 09:00
```

Who asked, who's doing it, what it's blocked on. "Show me Worker A" tails that worker's log on demand. Everything is retrievable — distilled by default, raw always one link away.

## When a result isn't right

React naturally — every reaction is harvested:

- **"Redo this, X is wrong"** → re-dispatched with the issue attached
- **You silently fix it yourself** → recorded as `corrected`
- **You use it as-is** → recorded as `adopted`

A taste-shaped correction becomes memory. A defect-shaped one triggers root-cause analysis over the raw records and a structural fix — usually a new policy on a hook point — so the same mistake cannot recur. Never an apology instead of a fix.

## How your role changes over time

```
Month 1   Many approvals, many corrections. You are a supervisor.
Month 3   Proven task types lose their approval gates — earned, not configured.
          Good workers get promoted; bad patterns get structurally blocked.
Month 6   You set direction. Interventions are reserved for real judgment calls.
```

Autonomy is never granted by a settings toggle; it is earned through ledger evidence and revoked by the same evidence.

## Operating tips

1. **Add one line of "done means…" to delegations.** It becomes the acceptance criteria the work is checked against. Skip it and the Resident defines done for you.
2. **Judge results, not process.** Diving into process is logged as an unplanned rescue — a defect signal the system must fix.
3. **Don't ration corrections.** Each one compounds.
4. **Report back when you're the executor.** One chat line closes the loop; the Resident does the bookkeeping.
5. **New channel, device, or CLI app = one adapter.** The core never changes for integrations.

## The two promises

Everything else — the kernel, the ledger, the durable Wait, the Governor, the Jester — exists to keep exactly two promises:

> **"What you hand over gets finished."**
> **"The same mistake doesn't happen twice."**
