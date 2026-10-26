# packages/machines

`@oni/machines` owns the host side of attachment and admission, generation CAS,
capacity leases, host-side fs/exec/code/PTY/computer handles, and bidirectional
NDJSON IPC over Unix sockets or pinned mutual-TLS TCP. A machine is WHERE
execution happens, never WHO is delegated to. The Rust `mclient` in
`clients/machine-client` is the only machine peer; it owns attach, reconnect,
filesystem, exec, PTY, screen/input, and the Python code runner. Serializable
message schemas belong to `@oni/protocol`. This package does not evaluate
product policy or run a local interpreter.

## STRUCTURE

```
src/
├── index.ts             # Host, transport, errors and handle exports
├── host.ts              # Listener set, admission, machine handles and reports
├── capacity.ts          # Placement and lease accounting
├── generation-store.ts  # Memory/file generation CAS stores
├── contained.ts         # Shared export-root normalization
├── pty-host.ts          # Host-side PTY wire codecs and deadlines
├── stream-write.ts      # Host-side bounded filesystem stream writer
├── typed-call.ts        # Protocol-derived machine wire call types
├── errors.ts / failure.ts / interrupt-on.ts
└── ipc/                 # Generic framing, client/server, callbacks and dispatch
```

## BOUNDARIES

- `@oni/protocol` is the only workspace import. `@oni/codemode` consumes
  `MachineHost` and `MachineHandle`; product configuration and enrollment
  persistence stay in `apps/oni`.
- The host negotiates enrollment, contract version and attached generation
  before exposing a handle. TCP admission pins the enrolled peer key; Unix
  connections have no peer key. `stale_generation` fences an old attachment.
- The host routes calls through the live peer and its effective capability and
  export intersection. The client's settings carry no second capability filter:
  the host enrollment row bounds what that machine can serve.
- `src/ipc/` is generic transport, not a home for machine wire vocabulary.
  Callback Effects use its scoped dispatcher rather than a runner in a socket
  callback. `MachinesFailure` is the fallback for untyped causes.
- Host stream writes send bounded chunks and require verified publication.
  Attachment loss fails in-flight calls as `disconnected`, without replay.

## TESTS

`test/` attaches a real Rust `mclient` through `test/helpers/mclient.ts` for
host, filesystem, exec, PTY, computer and lifecycle behavior. Prepare the
binary with `beforeAll(mclientBinary, 300_000)` and supply
`eventCollector().sink` to the host. The client settings may set `tmuxSocket`
to isolate terminal tests on a private tmux server. Malformed-peer tests may
use `src/ipc/client.ts`; `test/ipc/` covers generic transport. Client driver
tests live in `clients/machine-client/tests/`.

Do not put product policy, schema ownership, or interpreter execution here.
Do not deep-import machine implementation from other workspace packages.
