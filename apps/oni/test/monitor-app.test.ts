import { sessionTree } from "../../../packages/agent/test/store/helpers/session-tree";
import { Effect } from "effect";
import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import type { Core } from "@oni/agent";
import { Bus, newTraceId } from "./helpers/bus";
import { Delivery, L0Observation, type Tool } from "@oni/protocol";
import { z } from "zod";
import { foldAlarmChains, watchStateOf } from "../src/bundles/alarms/index";
import { assistantMessage, requestToolStep } from "./helpers/assistant-message";
import { planeOf } from "./helpers/ledger";
import { residentSuite, fakeProviderModel } from "./helpers/resident-suite";
import { attachMachineDaemon } from "@oni/machines";
import { acquireEffect, runEffect } from "./helpers/scoped-effect";
import { testIds } from "./helpers/test-entropy";
import { testSelfMachine } from "./helpers/self-machine";

const suite = residentSuite();
type Plane = Awaited<ReturnType<typeof planeOf>>;

function monitorConfig(prefix: string) {
  return suite.config(prefix, { wsToken: "monitor-test", compactionSummarizer: false });
}

function monitorTurn(input: Core.RunInput, sink: Core.LlmSink, call: number, request: Tool.Call, reply: string) {
  if (call === 1) requestToolStep(input, sink, request);
  else sink.onMessage(assistantMessage(input, { text: reply }));
  return { type: "stop" as const };
}

function sendPrompt(ws: WebSocket, text: string) {
  ws.send(JSON.stringify({ type: "message", eventId: newTraceId(), text }));
}

async function monitorConnection(app: Awaited<ReturnType<typeof suite.boot>>) {
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "monitor-test"]);
  const plane = await planeOf(app.runtime);
  return { ws, plane };
}

async function awaitWaiting(plane: Plane, send: () => void, message: string, timeout: number) {
  const waiting = Promise.withResolvers<void>();
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.kind !== "turn") return;
    const snapshot = plane.openKernel(event.sessionId).getSnapshot(event.sessionId);
    if (snapshot.turns.at(-1)?.terminal?.kind === "waiting") waiting.resolve();
  });
  const timer = setTimeout(() => waiting.reject(new Error(message)), timeout);
  try {
    send();
    await waiting.promise;
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

function createdWatch(plane: Plane) {
  const arm = plane.listSessions().flatMap((row) =>
    sessionTree(row.id, plane.sessionStore(row.id).actions)
      .filter((action) => action.kind === "alarm" && action.id.includes(":arm:"))
      .map((action) => ({ sessionId: row.id, watchId: action.id.split(":arm:")[0] ?? "" })),
  )[0];
  if (arm === undefined) throw new Error("no created watch");
  return arm;
}

function onResult(plane: Plane, sessionId: string, message: string, timeout: number) {
  const woke = Promise.withResolvers<void>();
  const guard = AbortSignal.timeout(timeout);
  const abort = () => woke.reject(new Error(message));
  guard.addEventListener("abort", abort, { once: true });
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.sessionId !== sessionId || event.kind !== "turn") return;
    if (plane.openKernel(sessionId).getSnapshot(sessionId).turns.at(-1)?.terminal?.kind === "result") woke.resolve();
  });
  return {
    promise: woke.promise,
    close: () => { unsubscribe(); guard.removeEventListener("abort", abort); },
  };
}

function alarmPrompts(plane: Plane, sessionId: string, watchId: string) {
  return sessionTree(sessionId, plane.sessionStore(sessionId).actions).filter((action) => {
    if (action.kind !== "prompt") return false;
    const intent = action.intent.value as { kind?: string; alarmId?: string };
    return intent.kind === "alarm" && intent.alarmId === watchId;
  });
}

function fifoWriter(fifo: string) {
  const writer = Bun.spawn(["/bin/sh", "-c", `printf 'WAKE\\n' > '${fifo}'`]);
  suite.defer(async () => {
    if (writer.exitCode === null) writer.kill();
    await writer.exited;
  });
  return writer;
}

test("app monitor source escapes the creating tool wave and wakes the session on its hit", async () => {
  const directory = suite.tempDir("monitor-app-");
  const fifo = join(directory, "source");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  let calls = 0;
  const app = await suite.boot({
    config: monitorConfig("monitor-app-db-"),
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        calls += 1;
        return monitorTurn(input, sink, calls, {
          id: "monitor-create", tool: "monitor",
          input: { operation: { op: "create", description: "external signal", source: {
            kind: "command", command: `cat '${fifo}'; cat '${fifo}'; read value`,
            filter: "^WAKE$", persistent: true,
          } } },
        }, "observed");
      }),
    },
  });
  const { ws, plane } = await monitorConnection(app);
  // The waiting commit follows installation of the native watch.
  await awaitWaiting(plane, () => sendPrompt(ws, "watch for the signal"), "monitor did not suspend", 5000);
  const arm = createdWatch(plane);
  const kernel = plane.openKernel(arm.sessionId);
  expect(calls).toBe(1);
  const chain = foldAlarmChains(kernel, arm.sessionId).get(arm.watchId);
  if (chain === undefined) throw new Error("no armed chain");
  expect(watchStateOf(chain, arm.sessionId)).toMatchObject({ kind: "watch", status: "armed", notifications: 0 });
  expect(kernel.getSnapshot(arm.sessionId).turns.at(-1)?.terminal?.kind).toBe("waiting");
  expect(app.sessions.get(arm.sessionId)).toBeUndefined();

  // The native hit enters through the entity alarm door and re-arms the persistent chain.
  const wake = onResult(plane, arm.sessionId, "monitor hit never woke the session", 10_000);
  suite.defer(wake.close);
  const writer = fifoWriter(fifo);
  await wake.promise;
  expect(await writer.exited).toBe(0);
  expect(calls).toBe(2);
  const prompts = alarmPrompts(plane, arm.sessionId, arm.watchId);
  expect(prompts).toHaveLength(1);
  expect(Delivery.text(z.object({ content: Delivery.Content }).parse(prompts[0]?.effect.value).content)).toBe("WAKE");
  const delivered = () => sessionTree(arm.sessionId, plane.sessionStore(arm.sessionId).actions)
    .filter((action) => action.kind === "alarm" && action.id.endsWith(":delivered")).length;
  expect(delivered()).toBe(1);
  const rearmed = foldAlarmChains(kernel, arm.sessionId).get(arm.watchId);
  if (rearmed === undefined) throw new Error("chain lost after the hit");
  expect(watchStateOf(rearmed, arm.sessionId)).toMatchObject({ status: "armed", notifications: 1 });
  expect(rearmed.latest.occurrenceId).not.toBe(chain.latest.occurrenceId);

  // A second line must wake via a new occurrence, not resend the settled one.
  const woke2 = Promise.withResolvers<void>();
  const guard2 = AbortSignal.timeout(10_000);
  const abort2 = () => woke2.reject(new Error("second monitor hit never woke the session"));
  guard2.addEventListener("abort", abort2, { once: true });
  const unsubscribe2 = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.sessionId !== arm.sessionId || event.kind !== "turn") return;
    if (delivered() === 2 && kernel.getSnapshot(arm.sessionId).turns.at(-1)?.terminal?.kind === "result") woke2.resolve();
  });
  suite.defer(() => { unsubscribe2(); guard2.removeEventListener("abort", abort2); });
  const writer2 = fifoWriter(fifo);
  await woke2.promise;
  expect(await writer2.exited).toBe(0);
  expect(calls).toBe(3);
  const prompts2 = alarmPrompts(plane, arm.sessionId, arm.watchId);
  expect(prompts2).toHaveLength(2);
  const occurrenceIds = prompts2.map((action) => (action.intent.value as { occurrenceId?: string }).occurrenceId);
  expect(new Set(occurrenceIds).size).toBe(2);
  const chain2 = foldAlarmChains(kernel, arm.sessionId).get(arm.watchId);
  if (chain2 === undefined) throw new Error("chain lost after the second hit");
  expect(watchStateOf(chain2, arm.sessionId)).toMatchObject({ status: "armed", notifications: 2 });
  expect(chain2.latest.occurrenceId).not.toBe(rearmed.latest.occurrenceId);
}, 30_000);

/** A terminal watch drains cursor reads, never replaying a tmux repaint. */
test("a monitor watch observes a named tmux terminal and leaves it open", async () => {
  const tmuxSocket = `oo-1273-monitor-${process.pid}`;
  suite.defer(() => { Bun.spawnSync(["tmux", "-L", tmuxSocket, "kill-server"]); });
  const machinesSocket = join(suite.tempDir("monitor-pty-machines-"), "machines.sock");
  let calls = 0;
  const app = await suite.boot({
    config: { ...monitorConfig("monitor-pty-db-"), machines: {
      self: testSelfMachine(), listen: { unix: machinesSocket },
      enrolled: [{ name: "workstation", machineId: "m-1", allowedCapabilities: ["pty.session"],
        allowedExports: ["shell"],
        publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        enrolledAt: 1000 }],
    } },
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        calls += 1;
        return monitorTurn(input, sink, calls, {
          id: "monitor-pty-create", tool: "monitor",
          input: { operation: { op: "create", description: "named terminal signal", source: {
            kind: "terminal", machine: "m-1", session: "qa", filter: "WAKE-7342", persistent: true,
          } } },
        }, "observed terminal");
      }),
    },
  });
  const daemon = await acquireEffect(attachMachineDaemon({
    dispatcherBound: 8, socketPath: machinesSocket, id: testIds("monitor-pty-daemon"),
    offer: { machineId: "m-1", daemonVersion: "0.1.0", platform: "darwin", offeredAt: 2000,
      offeredCapabilities: ["pty.session"], exports: [{ name: "shell", path: "/" }] },
    fsExports: new Map([["shell", "/"]]), pty: { socketName: tmuxSocket },
  }));
  const { ws, plane } = await monitorConnection(app);
  // The waiting commit follows install's cursor baseline, before the trigger.
  await awaitWaiting(plane, () => sendPrompt(ws, "watch the terminal"), "terminal watch did not suspend", 10_000);
  expect(Bun.spawnSync(["tmux", "-L", tmuxSocket, "has-session", "-t", "qa"], { stderr: "pipe" }).exitCode).toBe(0);
  const arm = createdWatch(plane);
  const wake = onResult(plane, arm.sessionId, "terminal watch wake timed out", 15_000);
  suite.defer(wake.close);
  // printf's format string avoids matching the typed keystroke echo.
  expect(Bun.spawnSync(["tmux", "-L", tmuxSocket, "send-keys", "-t", "qa", "-l", "printf 'WAKE-%d\\n' 7342"]).exitCode).toBe(0);
  expect(Bun.spawnSync(["tmux", "-L", tmuxSocket, "send-keys", "-t", "qa", "Enter"]).exitCode).toBe(0);
  await wake.promise;
  expect(calls).toBe(2);
  const prompts = alarmPrompts(plane, arm.sessionId, arm.watchId);
  expect(prompts).toHaveLength(1);
  const prompt = prompts[0];
  if (prompt === undefined) throw new Error("missing watch prompt");
  expect(Delivery.text(z.object({ content: Delivery.Content }).parse(prompt.effect.value).content)).toContain("WAKE-7342");
  const tree = sessionTree(arm.sessionId, plane.sessionStore(arm.sessionId).actions);
  expect(tree.filter((action) => action.kind === "alarm" && action.id.endsWith(":delivered"))).toHaveLength(1);
  await runEffect(daemon.close());
  expect(Bun.spawnSync(["tmux", "-L", tmuxSocket, "has-session", "-t", "qa"], { stderr: "pipe" }).exitCode).toBe(0);
}, 60_000);

/** Cron scheduling returns before DeliverAt fires and suspends on live-wait evidence. */
test("monitor cron create arms a grid chain and the turn suspends instead of blocking on the tick", async () => {
  let calls = 0;
  const app = await suite.boot({
    config: monitorConfig("monitor-cron-db-"),
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        calls += 1;
        return monitorTurn(input, sink, calls, {
          id: "cron-create", tool: "monitor",
          input: { operation: { op: "create", description: "five minute grid",
            source: { kind: "cron", expr: "*/5 * * * *", tz: "UTC" } } },
        }, "cron armed");
      }),
    },
  });
  const { ws, plane } = await monitorConnection(app);
  await awaitWaiting(plane, () => sendPrompt(ws, "arm the cron"), "cron create did not suspend", 15_000);
  expect(calls).toBe(1);
  const session = plane.listSessions().find((row) => row.id !== "gateway-ingress");
  if (session === undefined) throw new Error("no resident session");
  const kernel = plane.openKernel(session.id);
  const chains = [...foldAlarmChains(kernel, session.id).values()];
  expect(chains).toHaveLength(1);
  const chain = chains[0];
  if (chain === undefined) throw new Error("no cron chain");
  const state = watchStateOf(chain, session.id);
  expect(state).toMatchObject({ kind: "cron", status: "armed", notifications: 0 });
  if (state.fireAt === null) throw new Error("armed cron without a fire instant");
  expect(state.fireAt % 60_000).toBe(0);
  expect(new Date(state.fireAt).getUTCMinutes() % 5).toBe(0);
  expect(state.fireAt).toBeGreaterThan(Date.now());
}, 30_000);

/**
 * App wiring over the core host: the channel stores ride the catalog handle
 * the host owns (one SQLite file, no second connection, no independent
 * close), and the entity ports the composition root binds after the host
 * mounts run a prompt. Stopping the app releases the catalog exactly once.
 */
test("channel stores ride the host's catalog handle and the bound entity ports stay live", async () => {
  const config = suite.config("monitor-host-db-", { wsToken: "monitor-test", compactionSummarizer: false });
  let calls = 0;
  const app = await suite.boot({
    config,
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        calls += 1;
        sink.onMessage(assistantMessage(input, { text: "host bound" }));
        return { type: "stop" as const };
      }),
    },
  });
  const plane = await planeOf(app.runtime);
  const catalogPath = config.catalogPath;
  if (catalogPath === undefined) throw new Error("the suite config names a catalog file");
  expect(plane.catalogDatabase.filename).toBe(catalogPath);
  const tables = plane.catalogDatabase
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_index', 'cluster_messages', 'channel_instance') ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  expect(tables).toEqual(["channel_instance", "cluster_messages", "session_index"]);
  plane.stores.instances.put({
    id: "channel:fixture:main",
    provider: "telegram",
    identity: "bot",
    enabled: true,
    settings: {},
    credentialRef: "secret:fixture",
    revision: 0,
    createdBy: "owner",
    updatedAt: 1,
  });
  expect(plane.catalogDatabase.query<{ id: string }, []>("SELECT id FROM channel_instance").all()).toEqual([
    { id: "channel:fixture:main" },
  ]);

  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "monitor-test"]);
  const settled = Promise.withResolvers<void>();
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.kind !== "turn") return;
    const snapshot = plane.openKernel(event.sessionId).getSnapshot(event.sessionId);
    if (snapshot.turns.at(-1)?.terminal?.kind === "result") settled.resolve();
  });
  const guard = setTimeout(() => settled.reject(new Error("the bound entity ports never ran the prompt")), 10_000);
  try {
    ws.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "are the ports bound" }));
    await settled.promise;
  } finally {
    clearTimeout(guard);
    unsubscribe();
  }
  expect(calls).toBe(1);

  const closes = spyOn(plane.catalog, "close");
  await app.stop();
  expect(closes).toHaveBeenCalledTimes(1);
  expect(Bun.file(`${catalogPath}-wal`).size).toBe(0);
  expect(() => plane.catalogDatabase.query("SELECT 1").get()).toThrow();
});
