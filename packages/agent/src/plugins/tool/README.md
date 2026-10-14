# tool plugin

The dispatcher implementation for the `tool` capability (#1316). `dispatch.ts`
owns dispatcher construction (`createDispatcher`, the dispatch/wave/recover
paths and result finishing) and the per-turn executor+dispatcher composition
(`createTurnDispatcher`), moved from `core/loop/tool.ts`. The core keeps the
`Dispatcher` contract, tool definition (`defineTool`), body execution
(`executeToolBody`) and the three tool projections; this plugin imports the
core only through `core/api.ts` (enforced by `script/check-deps.ts`) and is
surfaced to the product through the `Bundle` namespace barrel.
