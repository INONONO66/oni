import { expect, test } from "bun:test";
import type { MachineHandle } from "@oni/machines";
import type { Machine, Provisioning } from "@oni/protocol";
import { Effect } from "effect";
import { createCliRunner } from "../src/bundles/child-activity/contact/runner";
import type { ChildWatch } from "../src/bundles/child-activity/index";
import { type ChildRow, reconcile } from "../src/bundles/child-activity/reconcile";

const SENDER = "resident-1";
const cursor: Machine.AgentSessionCursor = { sessionId: "agent-1", generation: 1, byteOffset: 0, recordHash: "a".repeat(64) };
const contact: Provisioning.ChannelInstance = {
  id: "channel:cli:reviewer", provider: "cli", identity: "bot", enabled: true,
  settings: { dialect: "claude-code", machine: "m-1", cwd: "/work" },
  revision: 1, createdBy: "owner", updatedAt: 0,
};

function harness(options: { readonly sendRefused?: boolean; readonly silent?: boolean } = {}) {
  const calls: string[] = [];
  const installed: ChildWatch[] = [];
  const rows: ChildRow[] = [];
  const listeners = new Set<() => void>();
  const agentSession: NonNullable<MachineHandle["agentSession"]> = {
    list: () => Effect.die(new Error("unused")),
    tail: () => Effect.die(new Error("unused")),
    open: (request) => Effect.sync(() => {
      calls.push(`open:${request.cli}:${request.project}`);
      return { status: "ok" as const, cursor };
    }),
    send: (request) => Effect.sync(() => {
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
    stop: (request) => Effect.sync(() => {
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
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    now: () => 0,
  });
  return { runner, calls, installed, rows, listeners };
}

test("a cli turn opens a machine-client session, sends, and ends on the terminal transcript fact", async () => {
  const { runner, calls, installed, listeners } = harness();
  const turn = await Effect.runPromise(runner.run({ agent: "reviewer", message: "review", sender: SENDER, turnId: "t-1", key: "k-1" }));
  expect(turn).toEqual({ child: "agent-1", turn: "k-1", facts: 1 });
  expect(listeners.size).toBe(0);
  expect(installed).toEqual([{
    id: "cli:agent-1", sessionId: SENDER, contact: "reviewer", child: "agent-1", turn: "k-1", machine: "m-1", cursor,
  }]);
  const interrupted = await Effect.runPromise(Effect.flip(runner.interrupt("agent-1")));
  expect(interrupted.code).toBe("turn_already_ended");

  const second = await Effect.runPromise(runner.run({ agent: "reviewer", message: "again", sender: SENDER, turnId: "t-2", key: "k-2" }));
  expect(second).toEqual({ child: "agent-1", turn: "k-2", facts: 1 });
  expect(installed.at(-1)?.cursor).toEqual({ ...cursor, byteOffset: 8, recordHash: "b".repeat(64) });

  await Effect.runPromise(runner.close());
  expect(calls).toEqual([
    "open:claude-code:/work", "send:agent-1:review", "close:cli:agent-1", "send:agent-1:again", "stop:agent-1", "close:cli:agent-1",
  ]);
});

test("an interrupt wakes the pending turn with the landed refusal and stops the child", async () => {
  const { runner, calls, listeners } = harness({ silent: true });
  const pending = Effect.runPromise(Effect.flip(runner.run({ agent: "reviewer", message: "review", sender: SENDER, turnId: "t-1", key: "k-1" })));
  await Effect.runPromise(runner.interrupt("agent-1"));
  expect(await pending).toEqual({ reason: "deadline expired; the child was interrupted", landed: true });
  expect(calls).toEqual(["open:claude-code:/work", "send:agent-1:review", "stop:agent-1", "close:cli:agent-1"]);
  expect(listeners.size).toBe(0);
});

test("a refused send and an undeclared contact surface typed refusals", async () => {
  const { runner } = harness({ sendRefused: true });
  const refused = await Effect.runPromise(Effect.flip(runner.run({ agent: "reviewer", message: "x", sender: SENDER, turnId: "t", key: "k" })));
  expect(refused.reason).toBe("agent.send refused: session_not_available");
  const unknown = await Effect.runPromise(Effect.flip(runner.run({ agent: "nobody", message: "x", sender: SENDER, turnId: "t", key: "k2" })));
  expect(unknown.reason).toBe("no cli contact nobody is declared");
});
