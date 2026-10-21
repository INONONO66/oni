/**
 * #1307 review M1 — `off: ["compaction"]` through the REAL index.ts wiring:
 * the compaction verbs bind into the session runtime only while the composed
 * generation keeps the capability on. Off at boot, the seam is absent, so the
 * same overflow geometry that compacts in `compaction-wiring.test.ts` (the ON
 * mirror of this test) runs the documented skip path instead — no compaction
 * row, the model keeps seeing the full history, and the turn still lands a
 * clean result terminal. The boot-time typed disabled record `{ name:
 * "compaction", because: "compaction" }` is pinned over the same manifest in
 * manifest.test.ts. The direct seam-absent refusals (`compaction_seam_missing` on
 * restore, the typed defect on a compaction append) are pinned at the package
 * level in `packages/agent/test/compaction/capability.test.ts`; this test
 * proves the shipped product composes the seam-absent runtime that reaches
 * them.
 */
import { sessionTree } from "../../../packages/agent/test/store/helpers/session-tree";
import { Effect } from "effect";
import { expect, test } from "bun:test";
import { newTraceId } from "./helpers/bus";
import { assistantMessage } from "./helpers/assistant-message";
import { planeOf } from "./helpers/ledger";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { nextResidentTurn } from "./helpers/resident-turn";

const suite = residentSuite();
const TOKEN = "compaction-off-token";

test("compaction off at boot composes out through index.ts: the overflow turn skips compaction instead of running the off capability", async () => {
  const messageCounts: number[] = [];
  let constrained = false;
  let calls = 0;
  const app = await suite.boot({
    config: suite.config("compaction-off-app-", {
      wsToken: TOKEN,
      compactionSummarizer: false,
      off: ["compaction"],
    }),
    llm: {
      // The same tight context window that compacts in the ON mirror test.
      resolveModel: (model) =>
        fakeProviderModel(model).pipe(
          Effect.map((resolved) => ({
            ...resolved,
            limit: { context: constrained ? 700 : 100_000 },
          })),
        ),
      run: (input, sink) =>
        Effect.sync(() => {
          calls += 1;
          if (constrained) messageCounts.push(input.messages.length);
          sink.onMessage(
            assistantMessage(input, {
              call: calls,
              reason: "stop",
              text: `answer ${calls} ${"filler ".repeat(30)}`,
              tokens: constrained
                ? { input: 650, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }
                : undefined,
            }),
          );
          return { type: "stop" as const };
        }),
    },
  });
  const plane = await planeOf(app.runtime);
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", TOKEN]);

  // Six fat seed turns build an oversized hydrated history on one session.
  for (let index = 0; index < 6; index += 1) {
    const reply = nextResidentTurn(plane);
    ws.send(
      JSON.stringify({
        type: "message",
        eventId: newTraceId(),
        text: `seed ${index} ${"filler ".repeat(30)}`,
      }),
    );
    await reply;
  }

  // The overflow turn: the call reports 650/700 context tokens over the full
  // seeded history. Composed, that pressure compacts at the loop's boundary
  // (the ON mirror proves it: a second, smaller call); off, the loop must
  // skip — one call, the full history, and a clean result terminal.
  constrained = true;
  const reply = nextResidentTurn(plane);
  ws.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "overflow question" }));
  await reply;

  expect(messageCounts).toHaveLength(1);
  // The full seeded history (6 turns + the new prompt) reached the model
  // un-compacted.
  expect(messageCounts[0] ?? 0).toBeGreaterThanOrEqual(13);
  const sessionId = plane.listSessions().find((row) => row.id !== "gateway-ingress")?.id;
  if (sessionId === undefined) throw new Error("no resident session");
  const actions = sessionTree(sessionId, plane.sessionStore(sessionId).actions);
  // The skip path is the documented off behavior: zero compaction rows ever.
  // (The boot-time typed disabled record `{ name: "compaction", because:
  // "compaction" }` is pinned over the same manifest in manifest.test.ts;
  // off-at-boot sessions adopt the composed generation at create, so no
  // separate compose configure row is journaled — that row is the RECOMPOSE
  // adoption, covered by monitor-bundle.test.ts.)
  expect(actions.filter((action) => action.kind === "compaction")).toHaveLength(0);
  // The turn itself completed normally — skip, not a crash or a silent stall.
  expect(plane.openKernel(sessionId).getSnapshot(sessionId).turns.at(-1)?.terminal?.kind).toBe(
    "result",
  );
}, 60_000); // ~7 real turns through the production root, like the ON mirror
