# What Is an Agent OS — Definition and Qualification Tests

Oni's root claim is "a single-Owner Agent OS" ([Design Philosophy](design-philosophy.md)). This document defines the term functionally — metaphor stripped — so the claim is checkable rather than rhetorical. Current wiring is tracked only in [Implementation Status](implementation-status.md); live delivery tracking is [GitHub #459](https://github.com/INONONO66/oni/issues/459).

## 1. What an OS functionally is

What makes an OS an OS is five duties:

1. **Multiplexing** — scarce resources (CPU, memory) shared by many programs.
2. **Protection** — programs cannot corrupt each other or the kernel, **by mechanism, not convention**.
3. **Abstraction (ABI)** — stable interfaces (syscalls, files, processes) so programs are portable across hardware.
4. **Lifecycle** — creation, scheduling, termination, recovery.
5. **Running programs it did not write.** Third-party code is the defining customer. A system that only runs its own program is firmware.

## 2. Translating the resources

The classical OS protected memory and CPU. The agent world's scarce resources are different:

| Classical OS | Agent OS |
|---|---|
| CPU cycles | **Money / tokens** (inference cost) |
| RAM | **Context window + memory** |
| Device access | **The principal's authority** — accounts, funds, channels, relationships, reputation |
| Process time | **Real-world time** (human replies take days) |
| — (not needed) | **Accountability for claims** — see below |

The last row is the category's genuinely new duty. **A classical OS could generally trust a CPU's exit status; an agent's "done" can be false.** An Agent OS therefore needs accountability: preserve what happened, require evidence, and deterministically check the specific predicates it knows how to check. It cannot mechanically turn an arbitrary claim into truth; unsupported claims remain assertions.

Oni sharpens that duty by treating each unit of work as a WorkItem contract. Progress completion, one execution's exit status, one criterion's result, and terminal contract completion are different facts. The target contract permits closure only through a durable admission bound to the current contract revision and evidence basis.

## 3. Definition

> **An Agent OS is the privileged layer that lets agents it did not write share one principal's authority, money, channels, and memory — meterable and revocable (multiplexing); that bounds a malicious agent's blast radius by mechanism (protection); that exposes a stable command interface (ABI); that keeps commitments alive on real-world timescales (lifecycle); and that records claimed effects and deterministically checks supported predicates (accountability).**

Compressed:

> **The classical OS protected programs from each other. The Agent OS protects the principal from their own agents.** The protected resource moved from memory to authority; the new duty is accountable, predicate-scoped verification rather than a promise of truth.

## 4. The five litmus tests

A system qualifies only by passing all five. This turns "is it an Agent OS?" from a vocabulary debate into an inspection.

| # | Test | Question |
|---|---|---|
| **T1** | Third-party | Can I *install* an agent I did not write and have it run under enforced limits? |
| **T2** | Hostile program | If that agent is malicious, is the damage bounded by mechanism — not by prompt? |
| **T3** | Power loss | Do commitments (schedules, pending replies, in-flight work) survive a reboot? |
| **T4** | Liar | Are completion claims separated from observations and scoped criterion results, and can the current WorkItem contract close only through one durable admission without treating unchecked claims as true? |
| **T5** | Multiplexing | Do multiple agents share budgets, authority, and channels without trampling each other? |

## 5. The landscape, scored

| System | What it actually is | Passes |
|---|---|---|
| LangGraph / AutoGen | **Framework** (library) — your process, your agents, no protection boundary | — |
| Temporal / Restate | **Durable scheduler** — T3 at full marks; trusts its activities; no authority model, claim-accountability layer, or agent abstraction | T3 |
| Claude Code | **Single-program runtime** (shell + one process) — permissions and sandbox exist, but one agent, one session | partial T2 |
| OpenClaw | **Gateway + companion** — session-centric; ClawHub gives real one-click installs, but skills land in a full-trust context (install without enforced limits); main session = full host access | partial T1 |
| Hermes-Agent | **Self-improving companion** — agent-curated memory; the agent grades and improves itself (self-report as the learning input) | — |
| AIOS-style papers | **Inference scheduler** — kernel for LLM calls; no authority or claim-accountability layer | partial T5 |
| Karpathy "LLM OS" | A different layer entirely (model-as-CPU metaphor) | n/a |

**No existing system passes all five.** The term "Agent OS" is today mostly marketing — and simultaneously a real, unoccupied category. The unoccupied duties are specifically **T4 (accountability for agent claims)** and the authority form of **T1/T5** (multiplexing a principal's life, not a machine's).

A note on trust direction, since it is the deepest split in the landscape: companion systems (OpenClaw, Hermes) are built on *trusting* the agent — its reports, its self-curated memory, its self-improved skills. Oni is built on *not trusting* it: execution, judgment, and improvement are separated, and completion claims must survive an evidence gate. This is an axiom difference, not a feature difference, which is why it is expensive to retrofit in either direction.

## 6. Oni qualification

[Implementation Status](implementation-status.md) alone records which qualification mechanisms are currently wired. The bets this depends on — and the criteria under which we abandon the claim — live in [Bets and Kill Criteria](bets-and-kill-criteria.md).
