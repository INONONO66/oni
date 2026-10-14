import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Effect } from "effect";
import { PlainValueSchema } from "@openomni/protocol";
import { clusterTempDir, runCluster, sendRead } from "./helpers/cluster-runtime";
import { runAgent } from "./helpers/executor";
import { fencedSession } from "./helpers/seeded-session";

const { dir, sessionsDir, catalogFile } = clusterTempDir("metrics-page-");
const options = { sessionsDir, catalogFile };
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a metrics page attributes a result whose attempt intent precedes its cursor", async () => {
  const sessionId = "metrics-page";
  const cursor = await runAgent(Effect.scoped(Effect.gen(function* () {
    const session = yield* fencedSession(options, sessionId);
    yield* session.commit([{
      id: "attempt", sessionId, parentId: null, kind: "llm", ts: 2, irreversible: true,
      intent: { encodingVersion: 1, value: { phase: "intent", attempt: 1, value: { purpose: "compaction" } } },
      effect: { encodingVersion: 1, value: { phase: "pending" } },
    }, {
      id: "attempt-result", sessionId, parentId: "attempt", kind: "llm", ts: 2, irreversible: true,
      intent: { encodingVersion: 1, value: { phase: "result" } },
      effect: { encodingVersion: 1, value: {
        phase: "result", terminal: "executed", usageProvenance: "reported",
        evidence: { usage: { inputTokens: 7, outputTokens: 3 } },
      } },
    }], 2);
    const intent = session.kernel.actionById("attempt");
    if (intent === undefined) throw new TypeError("missing committed attempt");
    return intent.ordinal;
  })));
  const page = await runCluster(options, sendRead(sessionId, { model: "metrics", cursor }));
  const usage = [{ attemptId: "attempt", purpose: "compaction", provenance: "reported", inputTokens: 7, outputTokens: 3 }];
  expect(PlainValueSchema.parse(JSON.parse(page.body))).toEqual({
    usage, usageByPurpose: [{ purpose: "compaction", usage }], turns: [],
  });
  expect(page.nextCursor).toBeNull();
});
