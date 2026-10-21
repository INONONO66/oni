/**
 * #1305 through the real composition: a configured tool output budget is
 * written into every new session's genesis
 * `session.configure{settings.toolOutputBudgetBytes}`, where the execution
 * ledger folds it per call; an unconfigured boot writes no budget setting and
 * the core default (32768) applies.
 */
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { z } from "zod";
import { Bus, newTraceId } from "./helpers/bus";
import { L0Observation } from "@oni/protocol";
import { planeOf } from "./helpers/ledger";
import { bounded } from "./helpers/protected-dispatch";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { nextResidentTurn } from "./helpers/resident-turn";
import { assistantMessage } from "./helpers/assistant-message";
import { sessionOutputsSource } from "../src/composition/codemode";

const suite = residentSuite();

const ConfigureSettings = z.object({ settings: z.object({ toolOutputBudgetBytes: z.number() }).loose() }).loose();

async function bootAndCommitOneTurn(prefix: string, config: { toolOutputBudgetBytes?: number }) {
  const committed = Promise.withResolvers<string>();
  const app = await suite.boot({
    config: suite.config(prefix, { wsToken: "budget-token", ...config }),
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) =>
        Effect.sync(() => {
          sink.onMessage(assistantMessage(input, { text: "done" }));
          return { type: "stop" as const };
        }),
    },
  });
  const plane = await planeOf(app.runtime);
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.kind === "turn") committed.resolve(event.sessionId);
  });
  suite.defer(unsubscribe);
  const socket = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "budget-token"]);
  const terminal = nextResidentTurn(plane);
  socket.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "hello" }));
  const sessionId = await bounded(committed.promise);
  await terminal;
  socket.close();
  return { plane, sessionId };
}

/** Every configured budget on the session's configure rows, in commit order. */
function configuredBudgets(plane: Awaited<ReturnType<typeof planeOf>>, sessionId: string): number[] {
  const kernel = plane.openKernel(sessionId);
  const actions = kernel.historyPage(sessionId, { afterRevision: 0, limit: 256 }).actions;
  const budgets: number[] = [];
  for (const action of actions) {
    if (action.kind !== "session.configure") continue;
    // #1253 fold contract: settings ride the configure row's INTENT value.
    const parsed = ConfigureSettings.safeParse(action.intent.value);
    if (parsed.success) budgets.push(parsed.data.settings.toolOutputBudgetBytes);
  }
  return budgets;
}

test("a configured budget reaches the session's genesis settings through the shipped composition", async () => {
  const { plane, sessionId } = await bootAndCommitOneTurn("tool-output-budget-", {
    toolOutputBudgetBytes: 200,
  });
  expect(configuredBudgets(plane, sessionId)).toEqual([200]);
});

test("an unconfigured boot writes no budget setting; the core default governs", async () => {
  const { plane, sessionId } = await bootAndCommitOneTurn("tool-output-default-", {});
  expect(configuredBudgets(plane, sessionId)).toEqual([]);

  // #1305: the composed `tool_output` source reads the session's own stored
  // bytes back whole and answers undefined for an unknown identifier.
  const kernel = plane.openKernel(sessionId);
  const outputId = `sha256:${"ab".repeat(32)}`;
  kernel.putToolOutput({ outputId, bytes: new TextEncoder().encode("stored text"), mediaType: "text/plain" });
  const outputs = sessionOutputsSource(plane.openKernel);
  expect(outputs(sessionId, outputId)).toEqual({ text: "stored text", bytes: 11, mediaType: "text/plain" });
  expect(outputs(sessionId, `sha256:${"00".repeat(32)}`)).toBeUndefined();
});
