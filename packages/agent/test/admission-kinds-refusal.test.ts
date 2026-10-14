/**
 * A session admission snapshot that declares NO capability kinds is a
 * typed `missing_capability_kinds` refusal, never a silent built-in list. The
 * pure decision names the reason; through the real entity's `deliver` door the
 * refusal is the sealed typed rejection with ZERO new journal facts.
 */
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Effect } from "effect";
import { Delivery } from "@openomni/protocol";
import { kernelOwnedRow } from "./helpers/request-fixtures";
import { decideSessionAdmission } from "../src/core/session/admission";
import type { DeliverRefused } from "../src/core/journal/messages";
import { clusterTempDir, readChain, runCluster, sendDeliver, sessionFileFor } from "./helpers/cluster-runtime";

const { dir, sessionsDir, catalogFile } = clusterTempDir("w52-admission-kinds-");
const options = { sessionsDir, catalogFile, capabilityKinds: "undeclared" as const };

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const sessionRow = kernelOwnedRow("s1", "idle");

const pendingPrompt = Delivery.Row.parse({
  id: "in-1",
  sessionId: "s1",
  kind: "prompt",
  content: "payload",
  origin: { encodingVersion: 1, value: { channel: "test" } },
  status: "pending",
  consumedBy: null,
  consumedAt: null,
  createdAt: 10,
  ordinal: 1,
});

test("a snapshot without declared capability kinds refuses with missing_capability_kinds", () => {
  expect(decideSessionAdmission({ row: sessionRow, pending: [pendingPrompt] })).toEqual({
    kind: "refused",
    reason: "missing_capability_kinds",
  });
});

test("deliver into an entity with no declared kinds refuses typed with zero new facts", async () => {
  const sessionId = "admission-kinds-missing";
  const refusal = await runCluster(
    options,
    sendDeliver(sessionId, { kind: "prompt", idempotencyKey: "p1", content: "hi" }).pipe(Effect.flip),
  );
  expect((refusal as DeliverRefused).code).toBe("denied");
  const baseline = readChain(sessionFileFor(sessionsDir, sessionId), sessionId);
  expect(baseline.some((row) => row.id === "p1")).toBe(false);
  const second = await runCluster(
    options,
    sendDeliver(sessionId, { kind: "prompt", idempotencyKey: "p2", content: "again" }).pipe(Effect.flip),
  );
  expect((second as DeliverRefused).code).toBe("denied");
  expect(readChain(sessionFileFor(sessionsDir, sessionId), sessionId).length).toBe(baseline.length);
});
