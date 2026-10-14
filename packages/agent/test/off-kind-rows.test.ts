import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Context, Effect } from "effect";
import { z } from "zod";
import { Delivery, Journal, type PlainValue } from "@openomni/protocol";
import { kernelOwnedRow } from "./helpers/request-fixtures";
import { Capability, Manifest, type PortTag } from "../src/core/ports/capability";
import { runTestPromise } from "./helpers/isolated";
import { compose } from "../src/core/composition/compose";
import { decideSessionAdmission } from "../src/core/session/admission";
import type { DeliverRefused } from "../src/core/journal/messages";
import {
  clusterTempDir,
  readChain,
  runCluster,
  sendDeliver,
  sessionFileFor,
  verifyChain,
} from "./helpers/cluster-runtime";

/**
 * Off-kind rows: rows already written by a now-off capability stay in
 * the journal byte-for-byte with their hashes intact, the fold treats them as
 * opaque (the off generation registers no reducer for the kind), and `deliver`
 * rejects that kind as input with the existing `unknown_kind` refusal.
 */

class ActionPort extends Context.Service<ActionPort, object>()("@openomni/agent/test/off-rows/action") {}

const actionCapability = Capability.define({
  name: "action",
  requires: [],
  kinds: {
    action: {
      schema: z.object({}),
      version: 1,
      reduce: (state: PlainValue) => state,
    },
  },
  inputs: ["action"],
  verbs: {},
  port: ActionPort as PortTag,
});

const onManifest = Manifest.define({ capabilities: [actionCapability], bundles: [], off: [] });
const offManifest = Manifest.define({ capabilities: [actionCapability], bundles: [], off: ["action"] });

const { dir, sessionsDir, catalogFile } = clusterTempDir("off-kind-rows-");
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("off-capability rows stay opaque with hashes intact and deliver refuses the kind as unknown_kind", async () => {
  const generationOn = await runTestPromise(compose(onManifest));
  const generationOff = await runTestPromise(compose(offManifest));
  // The composed tables drive both doors: deliver registrations and admission kinds.
  expect(generationOn.inputs).toEqual(["action"]);
  expect(Object.keys(generationOn.kinds)).toEqual(["action"]);
  expect(generationOff.inputs).toEqual([]);
  expect(Object.keys(generationOff.kinds)).toEqual([]);
  expect(generationOff.disabled).toEqual([{ name: "action", because: "action" }]);

  const sessionId = "off-rows";
  const onOptions = {
    sessionsDir,
    catalogFile,
    inputRegistrations: ["prompt", "signal", ...generationOn.inputs],
    capabilityKinds: Object.keys(generationOn.kinds),
  };
  // Phase 1 — capability ON: the action input is registered, delivered and journaled.
  await runCluster(
    onOptions,
    Effect.gen(function* () {
      yield* sendDeliver(sessionId, { kind: "prompt", idempotencyKey: "seed", content: "seed" });
      const receipt = yield* sendDeliver(sessionId, { kind: "action", idempotencyKey: "a1", content: "{}" });
      expect(receipt.existed).toBe(false);
    }),
  );
  const file = sessionFileFor(sessionsDir, sessionId);
  const onChain = readChain(file, sessionId);
  const actionRow = onChain.find((row) => row.id === "a1");
  if (actionRow === undefined) throw new Error("missing journaled action row");
  expect(actionRow.kind).toBe("action");
  const lengthBefore = onChain.length;

  // Phase 2 — capability OFF: the same journal, recomposed registrations.
  const offOptions = {
    sessionsDir,
    catalogFile,
    inputRegistrations: ["prompt", "signal", ...generationOff.inputs],
    capabilityKinds: Object.keys(generationOff.kinds),
  };
  const refusal = await runCluster(
    offOptions,
    sendDeliver(sessionId, { kind: "action", idempotencyKey: "a2", content: "{}" }).pipe(Effect.flip),
  );
  expect((refusal as DeliverRefused).code).toBe("unknown_kind");

  // The rows of the off capability stay byte-for-byte: no new facts, every
  // action_hash/prev_hash link recomputes from the stored bytes.
  const offChain = readChain(file, sessionId);
  expect(offChain.length).toBe(lengthBefore);
  expect(offChain.find((row) => row.id === "a1")).toEqual(actionRow);
  expect(verifyChain(file, sessionId)).toBe(lengthBefore);

  // Opaque in the fold: the off generation registers no reducer for the kind,
  // and input admission over the composed kinds refuses a pending action row.
  expect(Journal.admitInputKind(Object.keys(generationOff.kinds), "action")).toBe("unknown_kind");
  expect(Journal.admitInputKind(Object.keys(generationOn.kinds), "action")).toBe("ok");
  const sessionRow = kernelOwnedRow(sessionId, "idle");
  const pendingAction = Delivery.Row.parse({
    id: "in-action",
    sessionId,
    kind: "action",
    content: "{}",
    origin: { encodingVersion: 1, value: { channel: "test" } },
    status: "pending",
    consumedBy: null,
    consumedAt: null,
    createdAt: 10,
    ordinal: 1,
  });
  expect(
    decideSessionAdmission({ row: sessionRow, pending: [pendingAction], capabilityKinds: Object.keys(generationOff.kinds) }),
  ).toEqual({ kind: "refused", reason: "unknown_kind" });
  expect(
    decideSessionAdmission({ row: sessionRow, pending: [pendingAction], capabilityKinds: Object.keys(generationOn.kinds) }).kind,
  ).not.toBe("refused");
});
