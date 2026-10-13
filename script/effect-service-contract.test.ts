import { expect, test } from "bun:test";
import type { CommitReceipt } from "../packages/agent/src/core/store/services";
import type { SessionWriteAdapter } from "../packages/agent/src/core/store/services";
import type { IpcServer } from "../packages/machines/src/ipc/index";
import { checkEffectBoundaryFindings, effectServiceInventory, type BoundaryFinding, type ServiceUsage } from "./check-effect-boundaries";

/**
 * Runtime surfaces whose only Effect shape was a declared-unused Tag
 * (machines ipc/codemode, channels, the agent store plane) export plain
 * functions/handles instead — the boundary law (R9) refuses tags nothing reads.
 */
test("store write receipts are the ok arms of the protocol results", () => {
  // Type-level contract: the commit receipt is the `ok: true` arm and the
  // session adapter keeps the fenced chain-write surface (W5.2: the lease and
  // alarm/inbox planes are deleted; the session port is the write authority).
  // A drift fails to compile.
  const okArm: CommitReceipt["ok"] = true;
  const sessionKeys: ReadonlyArray<keyof SessionWriteAdapter> = ["materialize", "commit"];
  const serverKeys: ReadonlyArray<keyof IpcServer> = ["socketPath", "call", "notify", "useConnection", "close"];
  void okArm;
  void sessionKeys;
  void serverKeys;
});

// Two full-program analyses (inventory + findings): ~18s on the ubuntu runner
// after W5.2, ~36s in the coverage lane once #1272 adds the sixth workspace;
// the ceiling is a crash guard, not a timing assertion.
test("every production Tag is consumed or has an exact existing-debt receipt", () => {
  const inventory = effectServiceInventory();
  expect(inventory.map((service: ServiceUsage) => service.key)).toEqual(expect.arrayContaining([
    "@openomni/agent/Entropy", "@openomni/agent/ObservationSink",
    "@openomni/agent/SessionLayer", "@openomni/agent/ToolCatalog",
    "@openomni/agent/Llm",
  ]));
  expect(inventory.map((service: ServiceUsage) => service.key)).not.toEqual(expect.arrayContaining([
    "@openomni/machines/Ipc", "@openomni/machines/Machines", "@openomni/machines/Codemode", "@openomni/channels/WebSocketFrames",
    "@openomni/agent/LedgerWrites",
  ]));
  const debt = checkEffectBoundaryFindings().filter((entry: BoundaryFinding) => entry.code === "R9_UNUSED_TAG");
  expect(debt.filter((entry: BoundaryFinding) => entry.failing)).toEqual([]);
  for (const service of inventory) {
    if (service.reads > 0) continue;
    expect(debt).toContainEqual(expect.objectContaining({ file: service.file, line: service.line, failing: false }));
  }
}, 60000);
