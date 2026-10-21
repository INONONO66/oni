import { expect, test } from "bun:test";
import { Effect } from "effect";
import { L0Observation } from "@oni/protocol";
import { sessionTree } from "../../../packages/agent/test/store/helpers/session-tree";
import { foldAlarmChains, watchStateOf } from "../src/bundles/alarms/index";
import { assistantMessage, requestToolStep } from "./helpers/assistant-message";
import { Bus, newTraceId } from "./helpers/bus";
import { planeOf } from "./helpers/ledger";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";

const suite = residentSuite();

function send(ws: WebSocket, text: string) {
  ws.send(JSON.stringify({ type: "message", eventId: newTraceId(), text }));
}

test("a monitor-created watch stays cancelled without delivery after an app restart", async () => {
  const config = suite.config("monitor-retire-restart-", { wsToken: "monitor-retire-token" });
  let watchId = "";
  let calls = 0;
  const app = await suite.boot({
    config,
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        calls += 1;
        if (calls === 1) requestToolStep(input, sink, {
          id: "monitor-create", tool: "monitor",
          input: { operation: { op: "create", description: "held source", source: {
            kind: "command", command: "read value", filter: "^WAKE$", persistent: true,
          } } },
        });
        else if (calls === 2) requestToolStep(input, sink, {
          id: "monitor-cancel", tool: "monitor", input: { operation: { op: "cancel", id: watchId } },
        });
        else sink.onMessage(assistantMessage(input, { text: "retired" }));
        return { type: "stop" as const };
      }),
    },
  });
  const plane = await planeOf(app.runtime);
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "monitor-retire-token"]);
  const waiting = Promise.withResolvers<string>();
  const waitingGuard = AbortSignal.timeout(10_000);
  const waitingAbort = () => waiting.reject(new Error("monitor did not enter waiting"));
  waitingGuard.addEventListener("abort", waitingAbort, { once: true });
  const unsubscribeWaiting = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.kind !== "turn") return;
    if (plane.openKernel(event.sessionId).getSnapshot(event.sessionId).turns.at(-1)?.terminal?.kind === "waiting")
      waiting.resolve(event.sessionId);
  });
  suite.defer(() => { unsubscribeWaiting(); waitingGuard.removeEventListener("abort", waitingAbort); });
  send(ws, "create a monitor watch");
  const sessionId = await waiting.promise;
  const created = sessionTree(sessionId, plane.sessionStore(sessionId).actions)
    .find((action) => action.kind === "alarm" && action.id.includes(":arm:"));
  if (created === undefined) throw new Error("monitor created no alarm chain");
  watchId = created.id.split(":arm:")[0] ?? "";
  const armed = foldAlarmChains(plane.openKernel(sessionId), sessionId).get(watchId);
  if (armed === undefined) throw new Error("created watch chain missing");
  expect(watchStateOf(armed, sessionId)).toMatchObject({ status: "armed" });

  const result = Promise.withResolvers<void>();
  const resultGuard = AbortSignal.timeout(10_000);
  const resultAbort = () => result.reject(new Error("monitor cancel did not finish"));
  resultGuard.addEventListener("abort", resultAbort, { once: true });
  const unsubscribeResult = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.sessionId !== sessionId || event.kind !== "turn") return;
    if (plane.openKernel(sessionId).getSnapshot(sessionId).turns.at(-1)?.terminal?.kind === "result")
      result.resolve();
  });
  suite.defer(() => { unsubscribeResult(); resultGuard.removeEventListener("abort", resultAbort); });
  send(ws, "cancel the monitor watch");
  await result.promise;
  const retired = foldAlarmChains(plane.openKernel(sessionId), sessionId).get(watchId);
  if (retired === undefined) throw new Error("retired watch chain missing");
  expect(watchStateOf(retired, sessionId)).toMatchObject({ status: "cancelled", fireAt: null });
  const delivered = () => sessionTree(sessionId, plane.sessionStore(sessionId).actions)
    .filter((action) => action.kind === "alarm" && action.id.endsWith(":delivered")).length;
  expect(delivered()).toBe(0);

  await app.stop();
  const reopened = await suite.boot({
    config,
    llm: { resolveModel: fakeProviderModel, run: () => Effect.succeed({ type: "stop" as const }) },
  });
  const recovered = await planeOf(reopened.runtime);
  const kernel = recovered.openKernel(sessionId);
  const chain = foldAlarmChains(kernel, sessionId).get(watchId);
  if (chain === undefined) throw new Error("restarted watch chain missing");
  expect(watchStateOf(chain, sessionId)).toMatchObject({ status: "cancelled", fireAt: null });
  expect(kernel.armedCount()).toBe(0);
  expect(sessionTree(sessionId, recovered.sessionStore(sessionId).actions)
    .filter((action) => action.kind === "alarm" && action.id.endsWith(":delivered"))).toHaveLength(0);
}, 30_000);
