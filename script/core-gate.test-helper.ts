/** Minimal valid structural tree shared by dependency CLI fixtures. */
export const coreGateFiles: Readonly<Record<string, string>> = {
  "packages/agent/src/index.ts": 'export * as Core from "./core"; export * as Bundle from "./bundle"; export * as Inspect from "./inspect"; export * as Testing from "./testing";',
  "packages/agent/src/core/api.ts": "export {};",
  "packages/agent/src/core/index.ts": "export {};",
  "packages/agent/src/core/ports/types.ts": "export {};",
  "packages/agent/src/core/loop/turn.ts": "export {};",
  "packages/agent/src/core/composition/compose.ts": "export {};",
  "packages/agent/src/core/observation/bus.ts": "export {};",
  "packages/agent/src/core/read-model/session.ts": "export {};",
  "packages/agent/src/core/gate/compile.ts": "export {};",
  "packages/agent/src/core/store/catalog.ts": 'const schema = "CREATE TABLE catalog (id TEXT)";',
  "packages/agent/src/core/store/session-file/index.ts": 'const schema = "CREATE TABLE session (id TEXT)";',
  "packages/agent/src/core/journal/compaction.ts": 'import { history } from "../../inspect/history";',
  "packages/agent/src/core/session/recovery.ts": 'import { history } from "../../inspect/history";',
  "packages/agent/src/core/session/run.ts": 'import { history } from "../../inspect/history";',
  "packages/agent/src/core/session/runtime.ts": 'import type { InspectionPage } from "../../inspect";',
};
