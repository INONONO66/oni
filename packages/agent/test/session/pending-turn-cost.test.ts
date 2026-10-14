import { expect, spyOn, test } from "bun:test";
import { Effect } from "effect";
import { createSessionChatRunner } from "../../src/core/session/run";
import { session } from "../../src/testing/registry";
import { fixtureConfigHead, fixtureTraceContext, prepareChatFixture } from "../helpers/chat-services";
import { isolated, isolatedLedger } from "../helpers/isolated";
import { completeModel, mockLlm } from "../helpers/mock-llm";
import { seedPolicy } from "../helpers/seed-policy";
import { testTurnDispatcher } from "../helpers/service-layers";
import { silentRuntime, withSessionServices } from "../helpers/session-services";
import { sessionTree } from "../helpers/session-tree";

test("one model step commits no empty checkpoints", () =>
  isolated(Effect.gen(function* () {
    seedPolicy();
    const runtime = silentRuntime("pending-turn", "pending-turn");
    const runner = createSessionChatRunner({
      prepare: (input) => Effect.gen(function* () {
        const dispatcher = yield* testTurnDispatcher(input, runtime);
        return prepareChatFixture({
          traceContext: fixtureTraceContext(input),
          config: { ...fixtureConfigHead(dispatcher.executor), llm: mockLlm(completeModel) },
        });
      }),
    });
    const handle = yield* withSessionServices(
      session({ id: "S", role: "resident", runner }, runtime),
      runtime,
    );
    yield* handle.prompt("warm");
    const { kernel, session: store } = isolatedLedger();
    const before = kernel.row("S").revision;
    let fullReads = 0;
    let commits = 0;
    const originalFull = store.actions.pendingMessages.bind(store.actions);
    const originalCommit = kernel.commit.bind(kernel);
    const full = spyOn(store.actions, "pendingMessages").mockImplementation((id) => {
      fullReads += 1;
      return originalFull(id);
    });
    const commit = spyOn(kernel, "commit").mockImplementation((input) => {
      commits += 1;
      return originalCommit(input);
    });
    try {
      yield* handle.prompt("measured");
    } finally {
      full.mockRestore();
      commit.mockRestore();
    }
    const rows = sessionTree(kernel, "S").filter((action) => action.ordinal > before);
    const checkpoints = rows.filter((action) =>
      action.kind === "turn" &&
      typeof action.intent.value === "object" && action.intent.value !== null &&
      !Array.isArray(action.intent.value) && action.intent.value.phase === "checkpoint");
    console.log(`one-step turn: full=${fullReads} actions=${rows.length} commits=${commits} checkpoints=${checkpoints.length} (baseline full=8 actions=21 commits=20)`);
    expect(checkpoints).toHaveLength(0);
    expect(rows).toHaveLength(18);
    expect(commits).toBe(17);
  })));
