import { expect, test } from "bun:test";
import { type MachineHandle, MachineRefusalError } from "@oni/machines";
import { Effect } from "effect";
import { type Machine, type Provisioning, L0Observation } from "@oni/protocol";
import { committedOn, createCliRunner, type CliRunnerDeps } from "../src/bundles/child-activity/contact/runner";
import { Bus } from "./helpers/bus";
import { runAbortableEffect, runEffect } from "./helpers/effect";
import type { ChildWatch } from "../src/bundles/child-activity/index";
import { type ChildRow, reconcile } from "../src/bundles/child-activity/reconcile";

const SENDER = "resident-1";
const cursor: Machine.AgentSessionCursor = { sessionId: "agent-1", generation: 1, byteOffset: 0, recordHash: "a".repeat(64) };
const contact: Provisioning.ChannelInstance = {
  id: "channel:cli:reviewer", provider: "cli", identity: "bot", enabled: true,
  settings: { dialect: "claude-code", machine: "m-1", cwd: "/work" },
  revision: 1, createdBy: "owner", updatedAt: 0,
};

interface HarnessOptions {
  readonly sendRefused?: boolean;
  /** The send lands but no transcript fact follows, so the turn stays parked. */
  readonly silent?: boolean;
  /** The named machine call fails with a MachineError instead of answering. */
  readonly failing?: "open" | "send" | "stop";
  /** No observation bus: `committed` offers no subscription. */
  readonly bus?: false;
  readonly deadline?: boolean;
}

type DeadlineRecord = Parameters<NonNullable<CliRunnerDeps["deadline"]>>[0];

function harness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  const installed: ChildWatch[] = [];
  const rows: ChildRow[] = [];
  const listeners = new Set<() => void>();
  const armed: DeadlineRecord[] = [];
  const retired: number[] = [];
  const subscribed = Promise.withResolvers<void>();
  const failure = new MachineRefusalError({ reason: "disconnected", message: "peer gone" });
  const agentSession: NonNullable<MachineHandle["agentSession"]> = {
    list: () => Effect.die(new Error("unused")),
    tail: () => Effect.die(new Error("unused")),
    open: (request) => options.failing === "open" ? Effect.fail(failure) : Effect.sync(() => {
      calls.push(`open:${request.cli}:${request.project}`);
      return { status: "ok" as const, cursor };
    }),
    send: (request) => options.failing === "send" ? Effect.fail(failure) : Effect.sync(() => {
      calls.push(`send:${request.sessionId}:${request.text}`);
      if (options.sendRefused === true) return { status: "refused" as const, reason: "session_not_available" as const };
      if (options.silent === true) return { status: "ok" as const };
      const spec = installed.at(-1);
      if (spec === undefined) throw new Error("send before watch install");
      rows.push(...reconcile({
        machine: spec.machine, contact: spec.contact, child: spec.child, turn: spec.turn,
        records: [{ kind: "turn", role: "assistant", text: "done" }],
        cursor: { ...cursor, byteOffset: 8, recordHash: "b".repeat(64) }, previous: spec.cursor, observedAt: 1,
      }, rows));
      for (const listener of listeners) listener();
      return { status: "ok" as const };
    }),
    stop: (request) => options.failing === "stop" ? Effect.fail(failure) : Effect.sync(() => {
      calls.push(`stop:${request.sessionId}`);
      return { status: "ok" as const };
    }),
  };
  const runner = createCliRunner({
    instances: { get: (id) => (id === contact.id ? contact : undefined) },
    machineKnown: (id) => id === "m-1",
    host: { get: () => ({ agentSession }) },
    watch: {
      install: (spec) => Effect.sync(() => void installed.push(spec)),
      close: (id) => Effect.sync(() => void calls.push(`close:${id}`)),
      rows: () => ({ rows, revision: rows.length }),
    },
    committed: (_sessionId, listener) => {
      if (options.bus === false) return undefined;
      listeners.add(listener);
      subscribed.resolve();
      return () => listeners.delete(listener);
    },
    ...(options.deadline === true ? {
      deadline: (input: DeadlineRecord) => Effect.sync(() => {
        armed.push(input);
        return { retire: Effect.sync(() => void retired.push(armed.length)) };
      }),
    } : {}),
    now: () => 0,
  });
  return { runner, calls, installed, rows, listeners, armed, retired, subscribed: subscribed.promise };
}

const RUN = { agent: "reviewer", message: "review", sender: SENDER, turnId: "t-1", key: "k-1" };

test("a cli turn opens a machine-client session, sends, and ends on the terminal transcript fact", async () => {
  const { runner, calls, installed, listeners } = harness();
  const turn = await runEffect(runner.run({ agent: "reviewer", message: "review", sender: SENDER, turnId: "t-1", key: "k-1" }));
  expect(turn).toEqual({ child: "agent-1", turn: "k-1", facts: 1 });
  expect(listeners.size).toBe(0);
  expect(installed).toEqual([{
    id: "cli:agent-1", sessionId: SENDER, contact: "reviewer", child: "agent-1", turn: "k-1", machine: "m-1", cursor,
  }]);
  const interrupted = await runEffect(Effect.flip(runner.interrupt("agent-1")));
  expect(interrupted.code).toBe("turn_already_ended");

  const second = await runEffect(runner.run({ agent: "reviewer", message: "again", sender: SENDER, turnId: "t-2", key: "k-2" }));
  expect(second).toEqual({ child: "agent-1", turn: "k-2", facts: 1 });
  expect(installed.at(-1)?.cursor).toEqual({ ...cursor, byteOffset: 8, recordHash: "b".repeat(64) });

  await runEffect(runner.close());
  expect(calls).toEqual([
    "open:claude-code:/work", "send:agent-1:review", "close:cli:agent-1", "send:agent-1:again", "stop:agent-1", "close:cli:agent-1",
  ]);
});

test("an interrupt wakes the pending turn with the landed refusal and stops the child", async () => {
  const { runner, calls, listeners } = harness({ silent: true });
  const pending = runEffect(Effect.flip(runner.run({ agent: "reviewer", message: "review", sender: SENDER, turnId: "t-1", key: "k-1" })));
  await runEffect(runner.interrupt("agent-1"));
  expect(await pending).toEqual({ reason: "deadline expired; the child was interrupted", landed: true });
  expect(calls).toEqual(["open:claude-code:/work", "send:agent-1:review", "stop:agent-1", "close:cli:agent-1"]);
  expect(listeners.size).toBe(0);
});

test("a refused send and an undeclared contact surface typed refusals", async () => {
  const { runner } = harness({ sendRefused: true });
  const refused = await runEffect(Effect.flip(runner.run({ agent: "reviewer", message: "x", sender: SENDER, turnId: "t", key: "k" })));
  expect(refused.reason).toBe("agent.send refused: session_not_available");
  const unknown = await runEffect(Effect.flip(runner.run({ agent: "nobody", message: "x", sender: SENDER, turnId: "t", key: "k2" })));
  expect(unknown.reason).toBe("no cli contact nobody is declared");
});

test("a machine failure on open, send or stop is the typed refusal naming the operation", async () => {
  const opening = harness({ failing: "open" });
  expect(await runEffect(Effect.flip(opening.runner.run(RUN)))).toEqual({ reason: "agent.open: peer gone" });
  expect(opening.installed).toEqual([]);

  const sending = harness({ failing: "send" });
  expect(await runEffect(Effect.flip(sending.runner.run(RUN)))).toEqual({ reason: "agent.send: peer gone" });
  expect(sending.listeners.size).toBe(0);
  expect(sending.calls).toEqual(["open:claude-code:/work"]);

  const stopping = harness({ failing: "stop", silent: true });
  const pending = runEffect(Effect.flip(stopping.runner.run(RUN)));
  await stopping.subscribed;
  expect(await runEffect(Effect.flip(stopping.runner.interrupt("agent-1")))).toEqual({ reason: "agent.stop: peer gone" });
  expect(await pending).toEqual({ reason: "deadline expired; the child was interrupted", landed: true });
  expect(stopping.calls).toEqual(["open:claude-code:/work", "send:agent-1:review"]);
});

test("without an observation bus the sent turn cannot be awaited", async () => {
  const { runner, calls, listeners } = harness({ bus: false });
  expect(await runEffect(Effect.flip(runner.run(RUN)))).toEqual({
    reason: "the observation bus offers no subscription; a cli turn cannot be awaited",
  });
  expect(calls).toEqual(["open:claude-code:/work", "send:agent-1:review"]);
  expect(listeners.size).toBe(0);
});

test("a deadline is armed on the cli contact's own chain and retired once the turn lands", async () => {
  const { runner, armed, retired } = harness({ deadline: true });
  const turn = await runEffect(runner.run({ ...RUN, deadlineMs: 500 }));
  expect(turn).toEqual({ child: "agent-1", turn: "k-1", facts: 1 });
  expect(armed).toEqual([{ sessionId: SENDER, turnId: "t-1", child: "agent-1", contact: "cli:reviewer", at: 500 }]);
  expect(retired).toEqual([1]);
});

test("a landed turn replays on its key without a second send", async () => {
  const { runner, calls } = harness();
  const first = await runEffect(runner.run(RUN));
  const replay = await runEffect(runner.run({ ...RUN, turnId: "t-1-retry" }));
  expect(replay).toEqual(first);
  expect(calls).toEqual(["open:claude-code:/work", "send:agent-1:review"]);
});

test("an interrupt names a child nobody runs", async () => {
  const { runner, calls } = harness();
  expect(await runEffect(Effect.flip(runner.interrupt("ghost")))).toEqual({ reason: "no cli child ghost is running" });
  expect(calls).toEqual([]);
});

test("a fiber interrupt of the parked turn drops its bus listener", async () => {
  const { runner, calls, listeners, subscribed } = harness({ silent: true });
  const controller = new AbortController();
  const pending = runAbortableEffect(runner.run(RUN), controller.signal);
  await subscribed;
  expect(listeners.size).toBe(1);
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(listeners.size).toBe(0);
  await runEffect(runner.close());
  expect(calls).toEqual(["open:claude-code:/work", "send:agent-1:review", "stop:agent-1", "close:cli:agent-1"]);
});

test("the committed port wakes its listener on the sender session's committed actions only", async () => {
  const landed = Promise.withResolvers<void>();
  let wakes = 0;
  const unsubscribe = committedOn(Bus)(SENDER, () => {
    wakes += 1;
    landed.resolve();
  });
  const committed = (sessionId: string) => ({ id: `action-${sessionId}`, sessionId, revision: 1, kind: "message" as const });
  Bus.publish(L0Observation.ActionCommittedEvent, committed("other-session"));
  Bus.publish(L0Observation.ActionCommittedEvent, committed(SENDER));
  await landed.promise;
  expect(wakes).toBe(1);
  unsubscribe?.();
  Bus.reset();
  expect(committedOn({})(SENDER, () => undefined)).toBeUndefined();
});
