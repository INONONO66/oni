# Architecture - Core Packages and One App

This document maps [Core Model](core-model.md) onto the post-#792 codebase. [Implementation Status](implementation-status.md) is authoritative for what is wired; [#930](https://github.com/INONONO66/oni/issues/930) owns kernel delivery ordering.

## Communication

External traffic and session tools enter the same `gateway.ingest(sender, envelope)` operation. Drivers supply raw facts; the gateway resolves perimeter identity, Wait correlation and surface routing. The injected L2 executor applies compiled message pre/post policy. Session delivery calls only the session entity's `deliver` RPC; actor delivery uses the retained channel send kernel.

`send_message` returns a handle without waiting for a child. New-session configuration is materialized idempotently before the first `deliver`; a retried send re-delivers under the same idempotency key. Resident and child sessions share the same session-owned runner; an OS process carries the session id and committed-delivery notifications, not a separate completion authority. Observations follow durable action commits and do not authorize delivery.

## Store

`packages/agent/src/core/store/` owns the durable facts: one catalog plus one SQLite file per session, behind typed store surfaces. It stores facts but does not decide product meaning. A session's catalog row, action tree, delivered inputs, revision, activation fence, and generation pointers are durable; its live runner is disposable `packages/agent` runtime state. Perimeter stores (`packages/channels/src/store/`) are consumed by the channels router, while the app composes messaging and session consumers. Cross-domain coupling happens through protocol IDs, not direct store reach-through.

`bus.publish` remains observation, not authorization or persistence. L0 action append commits before its injected observation sink is called. Record-before-act paths must commit through a durable store or append surface before the external action. The session entity's outside surface is exactly four RPCs, `deliver | resolve | alarm | read`; `read` serves the nine read models (`history | decisions | requests | alarms | generations | tree | metrics | control | outbound`) without waking a runner, and inputs are consumed at loop boundaries only.

The `alarm` journal kind has one core writer (`packages/agent/src/core/ports/alarm.ts`); the removable `plugins/alarm` capability owns the purpose registry, wake dispatch and the watch verbs. The app's `composition/watch-sources.ts` owns the native OS handles (PTY, fs watcher) and resends a native hit through the entity's `alarm` RPC; the app never commits an arm row itself. There is no second watch store or runner.

## Policy

The policy gate inside `packages/agent` (`src/core/gate/`) is the generic actor-agnostic engine, and the agent dispatches the loop points it consumes. `packages/channels` owns perimeter policy. `apps/oni` owns product composition and may select registrations without moving product semantics into the engine.

The old product-specific dispatch registrations and completion service were removed with their only implementation. Their protocol points remain contracts, not proof of a live consumer.

## Package Rings

```text
ring 0  @oni/protocol        schemas and pure folds
ring 1  @oni/agent           generic durable-session mechanics and the stateless
                                  LLM loop, with the durable stores (src/core/store/),
                                  the pure policy gate (src/core/gate/), and model
                                  access (src/model/) folded in (#1246, one core/ since
                                  #1276)

lateral driver/gateway band:
        @oni/machines        raw machine WHERE endpoints and the thin transport
                                  (src/ipc/)
        @oni/codemode        the code facade with its injected interpreter
                                  runner, over protocol and the machines port (#1272)
        @oni/channels        platform drivers, perimeter router, and the
                                  channel-facing stores (src/store/)

presentation:
        @oni/ui              data-blind design system

composition:
        apps/oni             the only product app and deployable host
        apps/desktop              desktop shell over protocol + ui
```

Each package depends only on the allowlist in `script/check-deps.ts`. The app composes the rings and bands; it is not another reusable ring.

## Execution Targets and Driver Band

A machine is WHERE execution happens, never WHO is delegated to. `packages/machines` owns host attachment, admission, capacity, raw fs/exec/runCode handles and IPC transport. `packages/codemode` owns machine object handles and cell routing over that host port. The Rust `mclient` is the only machine peer and owns confined drivers and the Python interpreter; the self machine boots as its own spawned client. Authorization occurs at kernel `tool.pre` and the effective enrollment/offer capability and export checks, not in an app VFS. `mclient run --config <settings.json>` attaches a remote machine.

Messages address WHO: an existing session, a new parent-linked child session, or a registered external actor. Native and process are session runner choices, not parallel message lifecycles. A send returns a handle; there is no synchronous child-join tool.

The removed local worker manager is not part of the final topology. Process session execution enters `apps/oni/src/process-entry.ts`. Native Resident and child-session execution is assembled once behind `@oni/agent` session handles; app adapters provide role-specific tools, system text, and runner configuration.

Band rules:

1. `machines` depends only on protocol and IPC; `codemode` depends on protocol and the machines port, never the reverse.
2. `channels` driver code depends only on protocol; its judgment sub-band may additionally consume policy and perimeter store surfaces.
3. Registration happens in `apps/oni`.
4. Drivers expose effects behind interfaces and never decide product admission.

## Perimeter Gateway

`packages/channels` owns:

- platform normalization and delivery;
- blacklist/channel/actor admission;
- Wait correlation and lifecycle;
- surface-to-session mapping;
- record-before-delivery route decisions;
- outbound grants and social-budget enforcement.

`apps/oni` owns:

- Resident and child-session configuration;
- message policy rows, authenticated session projections and runner selection;
- tool definitions and placement consumption;
- channel registration and injected gateway ports.

`packages/agent` owns generic session mechanics over its own store facts: `SessionHandleStore` coordination, the activation fence rotated per entity activation, loop-boundary input consumption, turn envelopes, generation pinning, and crash resume. Product-specific session identity, routing, role configuration, lifecycle policy, and ref-counted executable bindings remain in the app. The app never rebuilds persisted history at a delivery boundary.

The gateway never reads transcript content. The app does not re-derive platform identity or bypass perimeter decisions.

## Session and Completion Contracts

A child session created by `send_message` is a normal catalog row with its parent session in `parentId`; there is no separate ownership layer above sessions. A turn records its intent and pre-minted result ID before runner entry, then seals exactly one `result | interrupted | error` terminal under the current activation fence. A child settles toward its parent at most once, on a `result | error` seal, with one bounded `Gateway.DelegationResult` outbound row committed in the seal batch; the gateway admits it through the parent's `deliver` RPC as a `followUp` input.

## Historical Reconciliation

The repository previously split product behavior across a reusable-looking product kernel, a local worker coordinator, and a server host. The 2026-08-23 Owner ruling replaced that end state with one deployable app. PRs through #796 established the clean composition: channel drivers, durable boot, gateway conduct, compaction, machines, delegation transports, and memory. #792 therefore deletes rather than redistributes the old trees.

Historical design decisions still explain the surviving extractions:

- Policy evaluation was extracted, then folded into `packages/agent/src/core/gate/` (#1246); `@oni/agent` owns the single executor that applies pre/post verdicts.
- The bus became volatile observation in `packages/agent` (`src/core/observation/bus.ts`); reverse persistence was removed. L0 observation sink contracts live in protocol.
- IPC became a standalone transport, now `packages/machines/src/ipc/`.
- Channel drivers and perimeter judgment consolidated in `packages/channels`.
- Machine execution became the lateral `packages/machines` band.
- Product composition converged in `apps/oni`.

Projection/export #766, old dispatch/evidence/effect services, local worker supervision, connector host plumbing, and the old distribution CLI were not ported without a live consumer. They may be re-filed only when the final app earns that behavior.

## Code Conventions

- Shared contracts are Zod-first and live in protocol.
- Decisions are pure functions; effects are injected drivers.
- Durable writes fail closed and occur before external action.
- Package imports use public barrels, never source deep imports.
- Resident, child, Governor, Jester, and Voice are roles, not packages.
- New abstractions require a second consumer.
