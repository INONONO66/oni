import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Clock, Effect } from "effect";
import { L0Observation } from "@oni/protocol";
import { foldAlarmChains } from "../src/bundles/alarms/index";
import { assistantMessage, requestToolStep } from "./helpers/assistant-message";
import { Bus, newTraceId } from "./helpers/bus";
import { testClockRuntime } from "./helpers/effect";
import { eventSignal } from "./helpers/event-signal";
import { planeOf } from "./helpers/ledger";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { nextResidentTurn } from "./helpers/resident-turn";

const suite = residentSuite();

test("the app reconciles a lost create on TestClock cadence and retires it on monitor cancel", async () => {
  const clock = testClockRuntime();
  const effectClock = await clock.run(Clock.Clock);
  const path = join(suite.tempDir("app-watch-cadence-"), "target");
  let native: ((event: string, name: string | null) => void) | undefined;
  let closed = 0;
  let watchId: string | undefined;
  let cancel = false;
  let calls = 0;
  try {
    const app = await suite.boot({
      config: suite.config("app-watch-cadence-db-", { wsToken: "cadence-token" }),
      effectClock,
      clusterClock: "injected",
      sessionRuntime: { clock: () => effectClock.currentTimeMillisUnsafe() },
      pathWatch: (_directory, listener) => {
        native = listener;
        return { on: () => undefined, close: () => { closed += 1; } };
      },
      llm: {
        resolveModel: fakeProviderModel,
        run: (input, sink) => Effect.sync(() => {
          calls += 1;
          if (calls === 1) {
            requestToolStep(input, sink, {
              id: "create-path",
              tool: "monitor",
              input: { operation: {
                op: "create", description: "lost create",
                source: { kind: "path", path, event: "create", persistent: true },
              } },
            });
            return { type: "stop" as const };
          }
          if (cancel && watchId !== undefined) {
            const result = requestToolStep(input, sink, {
              id: "cancel-path",
              tool: "monitor",
              input: { operation: { op: "cancel", id: watchId } },
            });
            if (result === undefined) return { type: "stop" as const };
            if (result.isError) throw new Error(result.content);
          }
          sink.onMessage(assistantMessage(input, { text: "done" }));
          return { type: "stop" as const };
        }),
      },
    });
    const plane = await planeOf(app.runtime);
    const socket = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "cadence-token"]);
    const installed = nextResidentTurn(plane);
    socket.send(JSON.stringify({ eventId: newTraceId(), text: "watch the path" }));
    expect((await installed).kind).toBe("waiting");
    const sessionId = plane.listSessions().find((row) => row.id !== "gateway-ingress")?.id;
    if (sessionId === undefined) throw new Error("missing watch session");
    const kernel = plane.openKernel(sessionId);
    watchId = kernel.armedAlarms().find((row) => row.purpose === "monitor.hit")?.alarmId;
    if (watchId === undefined) throw new Error("missing monitor watch");
    const cadence = () => kernel.armedAlarms().filter((row) => row.alarmId === `${watchId}:watch`);
    expect(cadence()).toHaveLength(1);
    expect(kernel.armedCount()).toBe(2);
    expect(cadence()[0]?.fireAt).toBe(1_000);

    const committed = (id: string) => {
      const signal = eventSignal<void>(id, 10_000);
      const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
        if (event.sessionId === sessionId && event.id === id) signal.resolve();
      });
      suite.defer(unsubscribe);
      return signal.promise.finally(unsubscribe);
    };
    const empty = cadence()[0];
    if (empty === undefined) throw new Error("missing cadence");
    const cadenceChain = () => foldAlarmChains(kernel, sessionId).get(`${watchId}:watch`);
    const chain = () => foldAlarmChains(kernel, sessionId).get(watchId ?? "");
    // #1477: a cadence tick is quiet for its own chain whether or not it
    // reconciles a hit — the core moves the SAME occurrence forward in the
    // armed index and writes nothing. The entity serves alarms in order, so the
    // hit a tick reconciles commits only after that tick moved the row: the
    // hit's delivered row is the deterministic barrier for the move.
    const reconcile = async (tick: number, content: string) => {
      const main = kernel.armedAlarms().find((row) => row.alarmId === watchId);
      if (main === undefined) throw new Error("missing live watch arm");
      const hit = committed(`${main.occurrenceId}:delivered`);
      const observed = nextResidentTurn(plane);
      const before = calls;
      writeFileSync(path, content);
      expect(kernel.actionById(`${main.occurrenceId}:prompt`)).toBeUndefined();
      await clock.adjust(1_000);
      await Promise.all([hit, observed]);
      expect(calls).toBe(before + 1);
      const prompt = kernel.actionById(`${main.occurrenceId}:prompt`);
      expect(prompt?.kind).toBe("prompt");
      expect(prompt?.effect.value).toMatchObject({ content: JSON.stringify({ path, event: "create" }) });
      expect(cadence().map((row) => [row.occurrenceId, row.fireAt])).toEqual([[empty.occurrenceId, tick + 1_000]]);
      expect(cadenceChain()?.armCount).toBe(1);
      expect(cadenceChain()?.settled.size).toBe(0);
      expect(kernel.actionById(`${empty.occurrenceId}:exhausted`)).toBeUndefined();
    };
    await reconcile(1_000, "created while the native stream drops the event");
    expect(chain()?.delivered).toBe(1);

    // The native stream sees the file go (nothing fires on a gap) and then
    // drops the second create too; the next tick reconciles that one.
    rmSync(path);
    native?.("rename", "target");
    expect(chain()?.delivered).toBe(1);
    await reconcile(2_000, "created again while the native stream drops the event");
    expect(chain()?.delivered).toBe(2);

    // A late native replay cannot duplicate the hit.
    native?.("rename", "target");
    expect(chain()?.delivered).toBe(2);

    const retired = eventSignal<void>("cadence retired", 10_000);
    suite.defer(Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
      if (event.sessionId === sessionId && event.kind === "alarm" &&
          foldAlarmChains(kernel, sessionId).get(`${watchId}:watch`)?.latest.at === null)
        retired.resolve();
    }));
    const cancelled = nextResidentTurn(plane);
    cancel = true;
    socket.send(JSON.stringify({ eventId: newTraceId(), text: "cancel the watch" }));
    await Promise.all([cancelled, retired.promise]);
    expect(cadence()).toHaveLength(0);
    expect(kernel.armedCount()).toBe(0);
    expect(closed).toBe(1);
    // The whole cadence chain: the install arm and the retire arm, nothing fired.
    expect(cadenceChain()?.armCount).toBe(2);
    expect(cadenceChain()?.settled.size).toBe(0);
    expect(chain()?.delivered).toBe(2);
  } finally {
    await suite.cleanup();
    await clock.dispose();
  }
});
