# packages/machines

Refreshed 2026-10-03 (#1273, branch `machines/1273-pty-session`; previously #1270 lanes A+B, #1274, #1272).

Machine execution package (`@oni/machines`): a machine is WHERE execution happens, never WHO is delegated to. Owns the machine host/daemon lifecycle, confined fs/exec drivers, and the NDJSON IPC transport over Unix sockets and pin-trusted mutual-TLS TCP (`src/ipc/`; the TCP listener and pinned client landed with #1270; the standalone ipc package was absorbed here in #1246; code mode was extracted to `packages/codemode` in #1272 — machines keeps only the structural contracts it consumes: `CodeRunner`, `MachineHost`/`MachineHandle`/`MachineInfo`, `onAbort`). The public surface is Effect-typed on Effect `4.0.0-rc.118`. Serializable message schemas stay in `@oni/protocol` (`Ipc` and `Machine` namespaces); this package never validates run semantics or evaluates policy.

## STRUCTURE

```
src/
├── index.ts             # Barrel: host/daemon, typedCall, ipc transport, errors, structural codemode contracts
├── host.ts              # createMachineHost — machine.attach server side; listener SET (unix + optional pinned-TLS tcp) into one registry
├── daemon.ts            # attachMachineDaemon — daemon client side, serves fs/exec/run_code/screen_read/input_write/pty_*; unix or tcp+pinned-host-key connection
├── generation-store.ts  # AttachGenerationStore port + memory/file (recoverable owner-pid lock dir, tmp+rename, 0600) stores for the host-minted attach generation (#1624)
├── reconnect.ts         # Full-jitter backoff reconnector (injected scheduler/random; base 250ms, cap 30s)
├── exec.ts / fs.ts      # Confined exec and filesystem drivers
├── commands.ts          # CommandRunner port + systemCommandRunner (argv spawn, no shell, 256KiB cap) (#1274)
├── computer-use.ts      # macOS screen.read/input.write adapter: probes, bounds cache, capture registry (#1274)
├── pty.ts               # tmux session adapter: pty.session offer probe, open/write/read/resize/close/list (#1273)
├── pty-control.ts       # one tmux -C control client per daemon: command FIFO, %output routing, server-exit fanout
├── pty-decode.ts        # control-mode line decoder: %begin/%end blocks, octal-escaped %output, malformed records
├── pty-registry.ts      # per-session replay+live streams, opaque p1:<generation>:<offset> cursors, retention bound
├── pty-host.ts          # host-side pty handle: schemas/codecs/timeouts over one routed wire-call seam
├── errors.ts            # MachinesFailure (single untyped-Cause fallback) + machine error classes
├── failure.ts           # decodeMachineFailure / decodeIpcFailure + machinesFallback — one MachinesFailure fallback
├── typed-call.ts        # Schema-derived typedCall facade for known Ipc.Methods (machine wire vocabulary lives here, beside its callers)
├── interrupt-on.ts      # onAbort
└── ipc/                 # Generic transport: framing, frame-schema, client, server, peer-request-table, callbacks, errors
```

## DEPENDENCIES

`@oni/protocol` (workspace, the only `@oni` import — enforced by `script/check-deps.ts`), plus `effect@4.0.0-rc.118` (exact pin) and `zod`. Consumers: `@oni/codemode` and `apps/oni`.

## KEY PATTERNS (ipc transport)

- Bidirectional: both ends send requests, responses, and notifications over one socket. `classifyIpcMessage` in `ipc/peer-request-table.ts` is the only place the three wire schemas are tried; both client and server share `PeerRequestTable` for pending-call correlation, per-connection failure, and code-1000 answers when no request handler exists.
- Wire method names are frozen. `typedCall(caller, method, params, timeout?)` derives known method parameter/result types from protocol's `Ipc.Methods` without changing runtime validation; generic string `call()` remains for unknown peers. `typed-call.ts` lives outside `src/ipc/` so the generic transport carries no machine vocabulary.
- Error classes are the contract: `IpcTimeoutError`, `IpcConnectionError`, `IpcRemoteError` (wire code 1000 — a healthy connection whose far side refused), `IpcProtocolError` (wire codes 4000 schema-invalid / 4001 non-JSON), and `MachinesFailure` for non-IpcError thrown values (`decodeIpcFailure`; the former `IpcFailure`/`CodemodeFailure` duplicates were folded into `MachinesFailure` in #1246). Transport warnings and handler defects are Effect log events (`Effect.logWarning`/`Effect.logError`), never `console` calls.
- Handler failures never escape the socket listener; callback Effects are queued into the acquiring app scope by `makeDispatcher` (`ipc/callbacks.ts`) — socket event handlers never call an Effect runner.
- Failure classification is per connection: a dying connection rejects its in-flight calls as `IpcConnectionError` immediately; response ids are honored only on the connection their request was written to. A malformed line costs only itself (server answers 4001 and stays up; client drains valid frames then tears down); an oversize frame (>16 MiB) desyncs the decode buffer, so the server closes that connection after answering.
- Server writes are backpressure-safe through a per-connection queue flushed on `drain`. `createIpcServer` probes an existing socket file and only unlinks it when provably dead; `notify()` yields `false` when no client is connected; `onDisconnect(connectionId)` fires exactly once per torn-down connection after its in-flight requests were failed.

## KEY PATTERNS (host/daemon network, #1270 lane B)

- The host's `listen: {unix?, tcp?}` listeners feed ONE registry/dispatcher; `tcp` requires the host `tls` identity (typed startup failure otherwise), and a failed bind releases whichever listener already bound. `endpoints` reports the bound addresses (port 0 resolves).
- Admission pins keys: on TCP the offered machineId's `Enrollment.publicKey` must equal the presented peer key fingerprint or the attach refuses `peer_key_mismatch` (a mismatched intruder never displaces a valid attachment). Unix connections carry no peer key and skip the pin.
- Admission order and generation (#1624): `attach` runs under a `Semaphore(1)`; `negotiate` answers `machine_not_enrolled`, `peer_key_mismatch`, `unsupported_contract` (`offer.peer.contractVersion` not in `Machine.supportedContractVersions`), then `machine_mismatch`; a generation-less offer for a live `neverSupersede` id refuses `already_attached` even on the same connection, before the store is touched. `generationOf` requires a reconnect to present exactly `generations.current(id)` (else `stale_generation`) and mints `current + 1` for a fresh offer through `compareAndSet` with one re-read. A disconnected, revoked, or closing admission cannot publish an attachment. An accepted offer detaches the incumbent (and any prior attachment on the same connection) with `superseded`, disconnects the displaced connection, and `capacity.detach(id, "stale_generation")` fences even running leases so `renewWhile` fails `MachineRefusalError { status: "refused", reason: "stale_generation" }`; every other detach (transport loss, host closure, enrollment removal or replacement) fences with `disconnected`; `lease_expired` comes only from the lease's own idle expiry or release. The daemon composes `peer: { kind: "daemon", contractVersion }` itself (`MachineDaemonOptions.offer` is `Omit<Offer, "peer" | "generation">`), resends the accepted generation on reattach, and fails `MachinesFailure { operation: "daemon.attach", cause: "stale_generation" | "unsupported_contract" }` (startup error on first attach, `closed` on reattach).
- Disconnection is typed: a known machine's dropped in-flight and reconnect-window calls fail ONCE as `MachineRefusalError` `disconnected` (never replayed); never-attached stays `machine_not_attached`.
- Filesystem handles keep `machine.fs_op` for bodies at most 256 KiB and default reads. An explicit larger read is capped at 8 MiB per call; larger writes use `machine.fs_stream` in 256 KiB chunks into a confined sibling temp file, published only after digest verification. The daemon retains at most 32 transfers, repeats the latest chunk acknowledgement idempotently, and clears transfers on detach; the host does not retry lost replies and reports attachment loss as `disconnected`.
- Host terminal reads publish `machine.pty_output` with machine id, session name, decoded byte count, and cursor only; terminal bytes stay in the daemon's cursor stream.
- `MachineHost.unenroll(id, reason?)` removes the attachment and its report with `enrollment_removed` by default or `enrollment_replaced` for a changed active grant, then disconnects only that peer through the generic IPC `disconnect(id)` API. Persistence and `machine.enrolled` / `machine.unenrolled` publication remain app-owned; `MachineInfo` is protocol's shared `Machine.Info` gateway projection with `generation` and `peer` required (#1624).
- Daemon `reconnect` is opt-in: absent keeps close-on-disconnect; present keeps drivers alive and redials via `createReconnector` (injected `scheduler`/`random` — tests drive time explicitly, production passes setTimeout/Math.random from the CLI). Successful reattach resets the backoff; a REFUSED reattach closes the daemon terminally.
- Daemon `report` is opt-in the same way (#1555): present, the daemon probes `cpus`/`memoryBytes` into the offer's `resources` when the configured offer leaves it absent, then beats `machine.report` once right after `attached` and again every `intervalMs` (default 5000, floor 1000) through the injected `scheduler`/`now`; the next beat is scheduled only after the host accepted the previous one; a refusal is recorded on `attachment` (`disconnected` | `machine_mismatch`) and closes the daemon like a refused reattach, a failed call keeps the cadence on the same connection. The host keeps the latest report per attachment (cleared on detach), accepts only the attaching connection's own machineId, publishes the ephemeral `machine.reported` (host-receipt `time`, daemon `reportedAt`), and `list()` projects `resources?` and `live? { reportedAt, load, stale }` with `stale` judged on the host clock against `staleAfterMs` (default 15 000). Absent `report`, no probe and no beats.


## CAPACITY AND LEASES (#1557)

- `createMachineHost({ capacity?, scheduler?, idleTtlMs?, now, ... })` validates `Machine.CapacityRows` before binding. Tag rows apply in array order; exact machine rows override their fields. Duplicate selectors fail boot; selectors for future enrollments are allowed.
- `host.capacity()` resolves each attached member to `{ machineId, slots, memReserveBytes, classCosts }`. Defaults are offered CPUs, zero reserve, and unit costs. `slots: null` means unknown capacity.
- `host.place(request, workClass?)` reuses the protocol fold and atomically reserves credit; an exact `{ machineId }` request uses the same fold over that member. `workClass` defaults to `exec`; `exec/eval/pty` cost one, while `job` uses its row cost. Exclusive placement reserves the whole member once, including unknown-slot members, and its holder may run overlapping calls without a second charge.
- A placed outcome carries `{ machineId, lease }`; saturation includes decision credit and publishes `machine.lease_refused`. The lease exposes `id`, `machineId`, invalidation `signal`, `renewWhile(effect, workClass?)`, `renewPtyWhile(effect, { name, op, workClass? })`, and `release()`. Terminal work defaults to `pty`; named jobs use `job`. Atomic acquire/use/release brackets charge the operation class and clean up even if acquisition is interrupted.
- Successful PTY opens retain a named claim after the call settles. Calls on that terminal reuse its claim; a decoded close (including already-absent) or detach drops it. Releasing the handle invalidates new calls but cannot free a live terminal's credit.
- The host's injected `now` owns report age and lease expiry; placement requires its injected scheduler. Idle timers (default 10 seconds) re-arm the remaining duration if fired early. The invalidation signal lets consumers prune references immediately. Stale reports supply no memory evidence and rank as unknown resources. Wire limits and dispatcher bounds remain separate constants.
- `src/capacity.ts` owns policy resolution and lease accounting; codemode stores host-issued tokens only.

## TESTS

`test/` (host/daemon/fs/exec lifecycle, `reattach.test.ts` fake-scheduler reconnect proofs, `host-listen.test.ts` listener-set/pinning, `host-admission.test.ts` / `daemon-admission.test.ts` / `generation-store.test.ts` for the #1624 admission order, generation CAS and fencing; `pty.test.ts` runs real tmux on a private `-L` socket plus a scripted control client for malformed-record faults), `test/ipc/` (framing split-multibyte and oversized frames, frame-schema, failure classes, backpressure, resilience, bidirectional, peer-request-table, callbacks, client/server edges, disconnect, socket-path, native client, typed facade + `typed-facade-fixtures/compile-red.ts`). `packages/codemode/test/` shares this harness (`test/helpers/native.ts`, `test/ipc/helpers/effects.ts`) by relative import. Effect execution goes only through the package runner owners (`test/helpers/effect.ts`, `test/ipc/helpers/effects.ts` — `script/check-effect-boundaries.ts` `RUNNER_OWNERS`).

## ANTI-PATTERNS

- Do NOT add kernel/ledger/policy or product-app imports — the dependency ratchet fails; `@oni/protocol` stays the only workspace import.
- Do NOT put message schemas here; they belong in `packages/protocol`.
- Do NOT deep-import from `@oni/machines/src/*`; use the package barrel.
- Do NOT reintroduce machine vocabulary (protocol `Machine.*`, `Ipc.Methods`) inside `src/ipc/` — the transport stays generic; `typed-call.ts` and its callers own the wire-method table.
- Do NOT add per-domain untyped-fallback error classes; `MachinesFailure` is the single fallback (`src/failure.ts`).
- Do NOT call `Effect.run*` in package tests outside the runner-owner helpers, and never in `src/` — the boundary checker owns both rules.
