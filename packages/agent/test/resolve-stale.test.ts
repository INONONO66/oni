/**
 * Stale `resolve`: a missing request is a typed `unknown_request`, a settled one a typed `already_resolved`;
 * both append zero journal facts, so the approval tray can simply re-read requests. A redelivered `inputId`
 * replays the recorded resolution through the pure request authority's dedup instead of refusing.
 */
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Effect } from "effect";
import {
  clusterTempDir,
  readChain,
  runCluster,
  sendResolve,
  sessionFileFor,
} from "./helpers/cluster-runtime";
import { seedSessionWithOpenRequest } from "./helpers/seed-request";
import type { ResolveRefused } from "../src/core/messages";

const { dir, sessionsDir, catalogFile } = clusterTempDir("w52-resolve-stale-");
const options = { sessionsDir, catalogFile };

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const principal = JSON.stringify({
  kind: "owner",
  principalId: "owner",
  evidenceId: "authenticated",
});

test("a missing requestId is unknown_request with zero new facts", async () => {
  const sessionId = "stale-unknown";
  await seedSessionWithOpenRequest({ sessionsDir, catalogFile, sessionId, requestId: "req-live" });
  const before = readChain(sessionFileFor(sessionsDir, sessionId), sessionId).length;
  // A refusal commits nothing, so the request doorbell stays silent.
  const rung: string[] = [];
  const refusal = await runCluster(
    { ...options, onRequestReady: (ringing) => rung.push(ringing) },
    sendResolve(sessionId, {
      requestId: "req-gone",
      outcome: "cancelled",
      payload: principal,
      inputId: "stale-1",
    }).pipe(Effect.flip),
  );
  expect((refusal as ResolveRefused).code).toBe("unknown_request");
  expect(rung).toEqual([]);
  expect(readChain(sessionFileFor(sessionsDir, sessionId), sessionId).length).toBe(before);
});

test("a settled request is already_resolved; a replayed inputId replays its resolution", async () => {
  const sessionId = "stale-settled";
  await seedSessionWithOpenRequest({
    sessionsDir,
    catalogFile,
    sessionId,
    requestId: "req-settle",
  });
  const { cancel, replayed, between, after } = await runCluster(
    options,
    Effect.gen(function* () {
      const cancel = yield* sendResolve(sessionId, {
        requestId: "req-settle",
        outcome: "cancelled",
        payload: principal,
        inputId: "cancel-1",
      });
      const between = readChain(sessionFileFor(sessionsDir, sessionId), sessionId).length;
      const replayed = yield* sendResolve(sessionId, {
        requestId: "req-settle",
        outcome: "cancelled",
        payload: principal,
        inputId: "cancel-1",
      });
      const after = readChain(sessionFileFor(sessionsDir, sessionId), sessionId).length;
      return { cancel, replayed, between, after };
    }),
  );
  expect(cancel.resolution).toBe("cancelled");
  expect(replayed.resolution).toBe("cancelled");
  expect(after).toBe(between);
  const late = await runCluster(
    options,
    sendResolve(sessionId, {
      requestId: "req-settle",
      outcome: "cancelled",
      payload: principal,
      inputId: "cancel-2",
    }).pipe(Effect.flip),
  );
  expect((late as ResolveRefused).code).toBe("already_resolved");
  expect(readChain(sessionFileFor(sessionsDir, sessionId), sessionId).length).toBe(after);
});
