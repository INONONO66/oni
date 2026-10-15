# packages/codemode

Created 2026-10-03 (#1272, branch `machines/1272-codemode-package`).

Code-mode package (`@openomni/codemode`): the reusable Python-backed cell runtime shared by the application host and the machine daemon. Owns the code facade (`createCodemode`), machine object handles (`read/write/ls/bash/eval`), one lazy `PythonKernel` per tenant, the cell registry and `cell.run/peek/stop` lifecycle, the Python prelude (machine handles, `parallel`, `completion`, `tool.<name>()` proxies, `browser()`/`BrowserClient` Chromium-over-CDP automation in a `pty.session`, #1275), `listMachines`/`machine`, codemode errors, callback routing, cancellation, and interpreter cleanup. Extracted from `packages/machines/src/codemode/` (#1246 fold reversed by #1272). It must NOT own kernel policy, ledger state, or model-facing rendering — those stay in `packages/agent` and `apps/openomni`.

## STRUCTURE

```
src/
├── index.ts    # createCodemode — facade, machine handles, per-tenant cell registry, runner
├── kernel.ts   # PythonKernel — serial per-tenant interpreter + embedded Python prelude
├── errors.ts   # CodemodeError (typed refusals), DriverFailure, CodeError union
└── failure.ts  # decodeCodeFailure — MachinesFailure fallback for untyped causes
```

## DEPENDENCIES

`@openomni/protocol` and `@openomni/machines` (the structural host/daemon contracts: `CodeRunner`, `MachineHost`, `MachineHandle`, `MachineInfo`, `MachinesFailure`, `onAbort`), plus `effect@4.0.0-rc.118` (exact pin) and `zod` — enforced by `script/check-deps.ts`. Consumers: `apps/openomni` only.

## KEY PATTERNS

- `createCodemode` consumes only the structural machines port (`Pick<MachineHost, "list" | "get">`) and protocol; it owns machine object handles and per-tenant interpreters. The composition root injects the returned runner into a machine daemon; the facade never spawns Python outside `src/kernel.ts`.
- Typed refusals are `CodemodeError` (`closed`, `machines_not_bound`, `machine_not_found`, `all_stale`, `machine_saturated`, `unknown_cell_id`); driver boundary faults are `DriverFailure`; everything untyped decodes to `MachinesFailure` via `decodeCodeFailure`.
- Injected entropy (#1245): cell ids come from the injected `id` source; no ambient crypto fallback.
- Prelude `m.job(command, cwd)` starts a named terminal job derived from its generated cell id; `m.job_wait(name, timeout)` long-polls the terminal cursor with a bounded sentinel tail (timeout in seconds, no accumulated output), and `m.job_read(name)` replays retained terminal bytes by name. Gone sessions return `status: lost`.

## TESTS

`test/codemode/` (consumer, kernel, bridge; `bun test packages/codemode/test/codemode/kernel.test.ts` pins per-tenant Python state, prelude helpers, callback routing, cancellation, cleanup). The promise-flavored harness (`createMachineHost`/`attachMachineDaemon` wrappers and Effect runners) is shared from `packages/machines/test/` by relative import; this package adds no `Effect.run*` sites of its own.

## ANTI-PATTERNS

- Do NOT add kernel/ledger/policy, model rendering, or product-app imports — the dependency band is `@openomni/protocol` + `@openomni/machines` only.
- Do NOT put message schemas here; they belong in `packages/protocol`.
- Do NOT deep-import `@openomni/machines/src/*`; use the package barrel.
- Do NOT add per-domain untyped-fallback error classes; `MachinesFailure` stays the single fallback (`src/failure.ts`).
- Do NOT call `Effect.run*` in package tests outside the machines runner-owner helpers, and never in `src/` — the boundary checker owns both rules.
