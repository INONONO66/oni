import { expect, spyOn, test } from "bun:test";
import { Effect } from "effect";
import { isolated, isolatedLedger } from "../helpers/isolated";
import { seedPolicy } from "../helpers/seed-policy";
import { completingChatSession } from "../helpers/session-chat";
import { silentRuntime } from "../helpers/session-services";
import { sessionTree } from "../helpers/session-tree";

test("one model step commits no empty checkpoints and reads pending once", () =>
  isolated(Effect.gen(function* () {
    seedPolicy();
    const runtime = silentRuntime("pending-turn", "pending-turn");
    const handle = yield* completingChatSession("S", runtime);
    yield* handle.prompt("warm");
    const { kernel, session: store } = isolatedLedger();
    const before = kernel.row("S").revision;
    let fullReads = 0;
    let commits = 0;
    let turnFullReads = 0;
    let tailFolds = 0;
    const originalFull = store.actions.pendingMessages.bind(store.actions);
    const originalCommit = kernel.commit.bind(kernel);
    const originalSince = kernel.pendingMessagesSince.bind(kernel);
    const since = spyOn(kernel, "pendingMessagesSince").mockImplementation((id, snapshot) => {
      if (snapshot === undefined) turnFullReads += 1;
      else tailFolds += 1;
      return originalSince(id, snapshot);
    });
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
      since.mockRestore();
    }
    const rows = sessionTree(kernel, "S").filter((action) => action.ordinal > before);
    const checkpoints = rows.filter((action) =>
      action.kind === "turn" &&
      typeof action.intent.value === "object" && action.intent.value !== null &&
      !Array.isArray(action.intent.value) && action.intent.value.phase === "checkpoint");
    console.log(`one-step turn: full=${fullReads} turn=${turnFullReads} tail=${tailFolds} actions=${rows.length} commits=${commits} checkpoints=${checkpoints.length} (baseline full=8 actions=21 commits=20)`);
    // The turn reads the full pending set once at admission; its three boundaries fold the tail.
    expect(turnFullReads).toBe(1);
    expect(tailFolds).toBe(3);
    // The other four full reads are the testing controller's own idle/admission checks.
    expect(fullReads).toBe(5);
    // Folding the whole chain from genesis reproduces the full read exactly.
    expect(kernel.pendingMessagesSince("S", { rows: [], ordinal: 0 })).toEqual(kernel.pendingMessagesSince("S"));
    expect(checkpoints).toHaveLength(0);
    expect(rows).toHaveLength(18);
    expect(commits).toBe(17);
  })));
