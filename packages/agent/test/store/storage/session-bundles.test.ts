import { sessionTree } from "../helpers/session-tree";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runLedgerSync } from "../helpers/effect";
import { SessionGeneration } from "@oni/protocol";
import { useSqliteStores } from "../helpers/storage";
import { z } from "zod";

const stores = useSqliteStores("ledger-bundles");

test("new session creation persists canonical bundle selection across reopen", () => {
  const bundles = ["zeta", "audit-log"];
  runLedgerSync(
    stores.kernel.materialize({
      id: "selected",
      parentId: null,
      role: "resident",
      tools: [],
      bundles,
      system: { preset: "", blocks: [] },
      policyGeneration: 0,
      actionId: "selected:create",
      at: 1,
    }),
  );
  expect(stores.kernel.latestGenerationFor("selected").bundles).toEqual(["audit-log", "zeta"]);
  expect(bundles).toEqual(["zeta", "audit-log"]);
  const actions = sessionTree("selected", stores.session.actions);
  stores.reopen();
  expect(stores.kernel.latestGenerationFor("selected").bundles).toEqual(["audit-log", "zeta"]);
  expect(sessionTree("selected", stores.session.actions)).toEqual(actions);
});

test("historic configure bytes survive default empty bundle decoding and reopen", () => {
  const historic = {
    generation: 1,
    revertTo: 0,
    tools: [],
    toolsHash: "historic-tools",
    systemPreset: "",
    systemBlocks: [],
    systemValue: "",
    systemHash: "historic-system",
    policyGeneration: 0,
  };
  runLedgerSync(
    stores.session.sessions.materialize({
      row: {
        id: "historic",
        parentId: null,
        role: "resident",
        state: "idle",
        revision: 0,
        fenceOwner: null,
        fence: 0,
        toolsGeneration: 1,
        systemHash: historic.systemHash,
        policyGeneration: 0,
      },
      initialAction: {
        id: "historic:create",
        sessionId: "historic",
        parentId: null,
        kind: "session.configure",
        intent: { encodingVersion: 1, value: { operation: "create" } },
        effect: { encodingVersion: 1, value: { phase: "configured", snapshot: historic } },
        revert: { encodingVersion: 1, value: { generation: 0 } },
        ts: 1,
      },
    }),
  );
  const readStoredAction = () => {
    using raw = new Database(stores.sessionPath);
    return z
      .object({ effect: z.string() })
      .parse(raw.query("SELECT effect FROM action").get());
  };
  const before = readStoredAction();
  const actions = sessionTree("historic", stores.session.actions);
  expect(stores.kernel.latestGenerationFor("historic").bundles).toEqual([]);
  stores.reopen();
  expect(stores.kernel.latestGenerationFor("historic").bundles).toEqual([]);
  expect(readStoredAction()).toEqual(before);
  expect(sessionTree("historic", stores.session.actions)).toEqual(actions);
  expect(SessionGeneration.Snapshot.parse(historic).bundles).toEqual([]);
});
