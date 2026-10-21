# Oni

**Target product model: an agent operating system built around a single permanent Resident, where failures make the system structurally stronger.**

The product and role model below describe Oni's target architecture, not a claim that the single-Resident, Jester, or Governor model is fully shipped. See [Current Status](#current-status) for what is wired today.

In that target model, Oni is a personal AI workforce built around one Resident. The Resident is the sole allocator of new Worker assignments: it understands the user's intent and context, handles what it can directly, and delegates execution when needed. Workers can be internal agents, external AI services, or people. From the system's perspective, they're all the same thing.

What makes this target architecture different from a typical agent framework is where the improvement logic lives. The Resident doesn't reflect on itself or rewrite its own behavior. Instead, a separate System Governor analyzes execution patterns and proposes tightly controlled Policy and Skill changes that prevent recurring failures. The Resident stays focused on the user. The system gets better underneath it.

This separation isn't just an architectural preference. It's the only way to build something you can trust over time.

## What is Oni?

Oni is a system for building an AI workforce one person can rely on for the long term.

Most agent projects focus on making a single agent more capable. Oni focuses on something different: creating the conditions where one Resident can work stably and reliably over months and years. The user has one relationship, with one Resident. That Resident decides what to handle directly and what to hand off. Workers — whether internal tools, other AI agents, or humans — are all treated the same way. They receive work, return results, and don't create new top-level work on their own.

The goal isn't a smarter agent. It's a trustworthy one.

## The Core Model

### The Single Resident (Target Architecture)

In the target architecture, the Resident is the single default relationship and interface. It understands accumulated context and is responsible for every response presented through that default shell, while the Owner remains root and may attach directly to an already-existing actor or process when useful. That attachment does not grant Worker-allocation authority: only the Resident originates new Worker assignments. Workers, failures, retries, and intermediate reasoning stay out of the default user-facing session.

### Workers as Applications

Execution is performed by Workers. Internal agents, external AI APIs, and human collaborators share that abstraction: they receive scoped work, execute it in isolation, and return a result. They cannot allocate another Worker. A Worker may use a same-domain, context-sharing subagent, message an already-existing agent when granted, or ask the Resident to allocate independent work; the Resident itself has no subagent lane. See the canonical role contract in [Core Model](docs/core-model.md).

### The Jester and System Governor (Target Architecture)

In the target architecture, the Jester is a silence-first, seven-lens cross-check whose semantic output excludes dispatch and decision authority and contains at most one challenge. The kernel host decides whether any challenge may leave the system. Separately, the System Governor is read-omniscient and write-minimal: scheduled analysis may selectively inspect raw transcripts and complete ledger records without per-query Owner approval, while the target access contract requires analysis-scoped audit and keeps raw payload outside user-facing sessions. See [Core Model](docs/core-model.md) for role behavior and [Kernel Contract](docs/kernel-contract.md) for authority and audit boundaries.

## How Improvement Happens

Recurring mistakes are encoded as Policy constraints so code-enforced cases are blocked and the rest become observable, reviewable violations. Frequently repeated tasks get distilled into Skills or workflows so the Resident doesn't have to rediscover the same approach each time. Dangerous patterns get flagged before they cause damage and are blocked where an enforcement point exists.

The key is that none of this requires the Resident to evaluate itself. Execution and judgment are separate. The entity that did the work doesn't grade it.

## How Work Flows

All work enters the system through a single ingress point. There's no side channel, no direct worker invocation from outside. This keeps authority boundaries clean.

When a request arrives, the Resident decides how to handle it. Simple requests get answered directly in the user session. More complex work gets delegated to a Worker, which runs in an isolated session with a scoped context. The Worker completes its task and returns a result. The Resident integrates that result, decides what the user needs to see, and responds. The user never sees the Worker's internal process — only the distilled outcome.

Only the Resident can allocate a new Worker. Workers can decompose same-domain work through context-sharing subagents, coordinate with an already-existing agent when granted, or ask the Resident for independent or cross-domain allocation. None of those Worker lanes transfers allocation authority.

## Design Philosophy

Agent capability is no longer the bottleneck — reliability is. Oni reduces to three kernel primitives (every subject is an **actor**, every boundary-crossing action passes one **gate**, everything lands in one **ledger**), two laws (a claim without evidence did not happen; no one judges their own work), and one dial (the harder an action touches reality, the more the human is involved). Four roles run on top: Workers do, the Resident decides, the Jester doubts, the Governor fixes — and root is the Owner.

→ [Design Philosophy](docs/design-philosophy.md)

## Current Status

The clean-room app is the sole deployable: a single Resident chat loop behind the channel gateway (WebSocket, plus env-gated Discord/Telegram/GitHub), a role-gated tool catalog with code mode and machine attach, the async delegation kernel (notify/ask/assign over inline, process, and channel transports with durable handles and boot recovery), curated built-in memory, and the npm-installable CLI with launchd/systemd daemon management. WorkItem completion authority, Stakes, the verifier registry, and the System Governor remain design-doc contracts without a wired implementation.

Component-level truth lives in [Implementation Status](docs/implementation-status.md) — design docs describe targets; that file says what actually runs.

## Install & Run 24/7

Oni ships as an npm package running on [Bun](https://bun.sh) >=1.4.0
for built-in PTY alarm monitoring (development and CI pin 1.4.1):

```bash
npm install -g oni     # or: bun add -g oni
oni onboard            # interactive setup -> ~/.oni/env
oni daemon install     # launchd / systemd --user service, survives reboot
oni doctor             # read-only diagnostics
```

The publishable artifact is staged with `bun run --cwd apps/oni build:npm` and published from `apps/oni/dist-npm`.

## Development

```bash
bun install
bun run build
bun test
bun run check-types
bun run format
```

## Further Reading

- [Design Philosophy](docs/design-philosophy.md) — the one-pager: primitives, laws, roles
- [Core Model](docs/core-model.md) — the OS specification: actors, gate, ledger, roles, policy hook layer, vocabulary
- [Architecture](docs/architecture.md) — the kernel in code: three verbs, package rings, migration phases
- [Usage Model](docs/usage-model.md) — what operating the system looks like from the Owner's seat
- [Agent OS Definition](docs/agent-os-definition.md) — the five duties and five litmus tests behind the "Agent OS" claim, landscape scored
- [Bets and Kill Criteria](docs/bets-and-kill-criteria.md) — standing criticisms, falsifiable hypotheses, and the conditions under which claims get downgraded
- [Kernel Contract](docs/kernel-contract.md) — normative contract detail: guarantees, authority evaluation, evidence gate, Governor rules, memory port
- [Implementation Status](docs/implementation-status.md) — what actually runs today

## Acknowledgements

Oni's default `web_search` and `web_fetch` tools are powered by [minpeter/opensearch](https://github.com/minpeter/opensearch) through its AI SDK tool package.

## License

MIT
