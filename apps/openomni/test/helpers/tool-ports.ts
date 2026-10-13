import type { ToolPorts } from "../../src/bundles/tools/core/catalog";
import { testIds } from "./test-entropy";

/** Explicit absent-capability fixture; individual tests supply only the ports they exercise. */
export const testToolPorts: ToolPorts = {
  messages: undefined,
  machines: undefined,
  cells: undefined,
  llm: undefined,
  provisioning: undefined,
  clock: () => 0,
  id: testIds("tool"),
};
