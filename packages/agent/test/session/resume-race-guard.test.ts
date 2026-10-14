// The resume admission race guard (W5.2): a decision layer picked "resume"
// against an interrupted terminal, but by execution time another writer has
// settled the turn. resumeInterrupted must consume the resume item as a no-op
// delivery instead of reopening a settled turn.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { createRawSlots } from "../../src/core/loop/executor";
import { internalOrigin, receivedMessageAction } from "../../src/core/journal/delivery";
import { turnTerminalAction } from "../../src/core/journal/turn-rows";
import { createSessionAdmission } from "../../src/core/session/admission";
import { createSessionRecovery } from "../../src/core/session/recovery";
import type { ResolvedSessionRuntime, SessionControllerState } from "../../src/core/session/run";
import { openCrashStores } from "../helpers/crash-stores";
import { runAgent } from "../helpers/isolated";
import { fencedTurnFixture } from "../helpers/fenced-writer";

const dir = mkdtempSync(join(tmpdir(), "resume-race-guard-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a resume admitted against a settled turn is consumed as a no-op delivery", async () => {
  const stores = openCrashStores(join(dir, "session.db"));
  try {
    const kernel = stores.kernel;
    let now = 0;
    const clock = () => {
      now += 1;
      return now;
    };
    let ids = 0;
    const entropy = () => {
      ids += 1;
      return `race:id-${ids}`;
    };
    await runAgent(
      Effect.gen(function* () {
        const fixture = yield* fencedTurnFixture(kernel, { id: "race", clock });
        // The foreign writer settled the open turn with a RESULT terminal and
        // left a pending resume item behind it.
        yield* kernel.commit({
          sessionId: "race",
          owner: fixture.owner,
          fence: fixture.fence,
          now: clock(),
          expectedRevision: kernel.row("race").revision,
          state: "idle",
          actions: [
            turnTerminalAction({
              id: "race:terminal",
              parentId: fixture.turnId,
              sessionId: "race",
              turnId: fixture.turnId,
              result: { kind: "result", text: "settled elsewhere" },
              resumeCount: 0,
              boundaryActionId: null,
              at: clock(),
            }),
            receivedMessageAction({
              id: "race:resume-item",
              sessionId: "race",
              kind: "resume",
              content: "resume after settle",
              origin: internalOrigin("race"),
              parentActionId: "race:terminal",
              at: clock(),
            }),
          ],
        });
        const item = kernel.pendingMessages("race")[0];
        if (item === undefined) throw new Error("resume item fixture");
        expect(item.kind).toBe("resume");
        const state: SessionControllerState = {
          active: undefined,
          controller: undefined,
          fence: fixture.fence,
          closed: false,
          terminalFrozen: false,
          released: false,
          successor: undefined,
          retainedRunner: undefined,
          rawSlots: createRawSlots(),
          activeApprovals: undefined,
        };
        // The guard path never reaches the runtime, runTurn or seal: a mock
        // that dies keeps that claim honest.
        const runtime = {} as ResolvedSessionRuntime;
        const admission = createSessionAdmission(kernel, "race", runtime, state, fixture.owner, clock, entropy, {
          awaitRetainedRunner: () => Effect.void,
          runTurn: () => Effect.die(new Error("resume guard must not reopen a settled turn")),
          seal: () => Effect.die(new Error("resume guard must not seal")),
        });
        const recovery = createSessionRecovery(kernel, "race", runtime, clock, entropy, {
          awaitRetainedRunner: () => Effect.void,
          runTurn: () => Effect.die(new Error("resume guard must not reopen a settled turn")),
          seal: () => Effect.die(new Error("resume guard must not seal")),
          commitSession: admission.commitSession,
          createExecutionLedger: admission.createExecutionLedger,
          consumeNoopDeliveries: admission.consumeNoopDeliveries,
        });
        const result = yield* recovery.resumeInterrupted(item);
        expect(result).toBeUndefined();
      }),
    );
    // The item was consumed by a delivery no-op, not left pending.
    expect(kernel.pendingMessages("race")).toHaveLength(0);
    expect(kernel.row("race").state).toBe("idle");
  } finally {
    stores.close();
  }
});
