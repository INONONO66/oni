# hook plugin

The removable hook capability (#1256): `hookCapability()` in `index.ts` is a
`Capability.define` declaration (`name: "hook"`, `requires: ["action"]`, port
`@oni/hook/Hook`) whose single handler `hook/process` is the one external
hook surface. `process.ts` owns it: `acquireHookProcess` spawns one JSON-lines
child process per acquisition Scope (one PID per distinct command per
generation — the Scope
finalizer drains in-flight calls, stops the reader, then kills the PID),
multiplexes concurrent calls by request id, bounds every call with
`Effect.timeoutOption` on the injected Clock, and returns the closed
`HookOutcome` union — `gate{verdict} | rewrite{args} | observe |
failure{code: "hook_timeout", cause: timeout | framing | exit}`. A malformed
stdout line is a framing failure that poisons the PROCESS fail-closed: every
in-flight call fails, the PID is marked dead and killed, and later calls refuse
— garbage cannot be attributed to one request or trusted afterwards. Spawn refusal is the typed
`HookSpawnError`.

This plugin imports only `core/api.ts` (`script/check-deps.ts` enforces), and
`Bun.spawn` stays at zero under `src/core/` — process execution lives here, in
the removable band. The product compiles hook rows over this handler in
`apps/oni/src/bundles/hooks-json`.
