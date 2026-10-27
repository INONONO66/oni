# packages/codemode

Created 2026-10-03 (#1272, branch `machines/1272-codemode-package`).

Code-mode package (`@oni/codemode`): the code facade (`createCodemode`), machine object handles (`read/write/ls/bash/eval`), cell registry and `cell.run/peek/stop` lifecycle routing, codemode errors, and host tool-call routing. Cells execute on attached machines; the machine client owns the Python interpreter and prelude. Extracted from `packages/machines/src/codemode/` (#1246 fold reversed by #1272). It must NOT own kernel policy, ledger state, or model-facing rendering — those stay in `packages/agent` and `apps/oni`.

## STRUCTURE

```
src/
├── index.ts    # createCodemode — facade, machine handles, cell lifecycle routing
├── errors.ts   # CodemodeError (typed refusals), CodeError union
└── failure.ts  # decodeCodeFailure — MachinesFailure fallback for untyped causes
```

## DEPENDENCIES

`@oni/protocol` and `@oni/machines` (the structural host contracts: `MachineHost`, `MachineHandle`, `MachineInfo`, `MachinesFailure`), plus `effect@4.0.0-rc.118` (exact pin) and `zod` — enforced by `script/check-deps.ts`. Consumers: `apps/oni` only.

## KEY PATTERNS

- `createCodemode` consumes only the structural machines port (`Pick<MachineHost, "list" | "get" | "place">`) and protocol; it owns machine object handles and routes cells to the attached client's code endpoints.
- Tag selection calls `host.place` with `exec` credit and retains its token for the Python handle. Renewal supplies the actual `exec`/`eval` class; PTY operations supply their name and open/use transition to `renewPtyWhile`. Detached cells use exact-member `job` placement for their full execution. Host invalidation prunes both lease references and cached handles; closing releases remaining handles. Codemode owns no capacity counts, placement fold, scheduler or idle timer; host saturation/expiry become `CodemodeError` with the host's credit.
- Typed refusals are `CodemodeError` (`closed`, `machines_not_bound`, `machine_not_found`, `all_stale`, `machine_saturated`, `lease_expired`, `unknown_cell_id`); everything untyped decodes to `MachinesFailure` via `decodeCodeFailure`.
- Injected entropy (#1245): cell ids come from the injected `id` source; no ambient crypto fallback.
- The attached client's prelude calls host tools through `machine.call_tool`; terminal jobs charge the host's `job` class and their claims last until close or detach.

## TESTS

`test/codemode/` tests facade routing against the attached machine client. The promise-flavored host harness and Effect runners are shared from `packages/machines/test/` by relative import; this package adds no `Effect.run*` sites of its own. Interpreter and prelude tests live with `clients/machine-client`.

## ANTI-PATTERNS

- Do NOT add kernel/ledger/policy, model rendering, or product-app imports — the dependency band is `@oni/protocol` + `@oni/machines` only.
- Do NOT put message schemas here; they belong in `packages/protocol`.
- Do NOT deep-import `@oni/machines/src/*`; use the package barrel.
- Do NOT add per-domain untyped-fallback error classes; `MachinesFailure` stays the single fallback (`src/failure.ts`).
- Do NOT call `Effect.run*` in package tests outside the machines runner-owner helpers, and never in `src/` — the boundary checker owns both rules.
