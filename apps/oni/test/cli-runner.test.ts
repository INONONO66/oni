import { expect, test } from "bun:test";
import { type MachineHandle, MachineRefusalError } from "@oni/machines";
import { Effect } from "effect";
import { type Machine, type Provisioning, L0Observation } from "@oni/protocol";
import { committedOn, createCliRunner, type CliRunnerDeps, IMPORTED_TURN } from "../src/bundles/child-activity/contact/runner";
import { Bus } from "./helpers/bus";
import { runAbortableEffect, runEffect } from "./helpers/effect";
import type { ChildWatch } from "../src/bundles/child-activity/index";
import { type ChildRow, contactCursor, reconcile } from "../src/bundles/child-activity/reconcile";
import { childSource } from "../src/composition/watch-sources";

const SENDER = "resident-1";
const cursor: Machine.AgentSessionCursor = { sessionId: "agent-1", generation: 1, byteOffset: 0, recordHash: "a".repeat(64) };
const contact: Provisioning.ChannelInstance = {
  id: "channel:cli:reviewer", provider: "cli", identity: "bot", enabled: true,
  settings: { dialect: "claude-code", machine: "m-1", cwd: "/work" },
  revision: 1, createdBy: "owner", updatedAt: 0,
};
/** A contact attached to the session `hand-1` the Owner ran by hand (#1779). */
const handContact: Provisioning.ChannelInstance = {
  ...contact, id: "channel:cli:hand",
  settings: { dialect: "claude-code", machine: "m-1", cwd: "/work", attach: "existing", sessionId: "hand-1" },
};

/** A hand-run transcript served page by page: one record per byte, three records per page, one generation. */
function handRunTranscript(records: Machine.AgentTranscriptRecord[]) {
  const PAGE = 3;
  const tails: number[] = [];
  const at = (byteOffset: number): Machine.AgentSessionCursor =>
    ({ sessionId: "hand-1", generation: 1, byteOffset, recordHash: byteOffset.toString(16).padStart(64, "0") });
  return {
    records, tails, origin: at(0),
    tail: (request: Machine.AgentSessionTailRequest): Promise<Machine.AgentSessionTailResult> => {
      const from = "cursor" in request ? request.cursor : at(0);
      if (from.sessionId !== "hand-1" || from.generation !== 1 || from.recordHash !== at(from.byteOffset).recordHash)
        return Promise.resolve({ status: "refused", reason: "invalid_cursor" });
      tails.push(from.byteOffset);
      const page = records.slice(from.byteOffset, from.byteOffset + PAGE);
      const end = from.byteOffset + page.length;
      return Promise.resolve({ status: "ok", records: page, cursor: at(end), hasMore: end < records.length });
    },
  };
}

interface HarnessOptions {
  readonly sendRefused?: boolean;
  /** The send lands but no transcript fact follows, so the turn stays parked. */
  readonly silent?: boolean;
  /** The named machine call fails with a MachineError instead of answering. */
  readonly failing?: "open" | "send" | "stop";
  /** No observation bus: `committed` offers no subscription. */
  readonly bus?: false;
  readonly deadline?: boolean;
  /** The hand-run transcript behind `cli:hand`; installs then run the real child source over it. */
  readonly existing?: ReturnType<typeof handRunTranscript>;
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
  const existing = options.existing;
  const sources = new Map<string, ReturnType<typeof childSource>>();
  const agentSession: NonNullable<MachineHandle["agentSession"]> = {
    list: () => Effect.die(new Error("unused")),
    tail: (request) => existing === undefined ? Effect.die(new Error("unused")) : Effect.promise(() => existing.tail(request)),
    open: (request) => options.failing === "open" ? Effect.fail(failure) : Effect.sync(() => {
      calls.push(`open:${request.cli}:${request.project}${request.sessionId === undefined ? "" : `:${request.sessionId}`}`);
      return { status: "ok" as const, cursor: request.sessionId === "hand-1" && existing !== undefined ? existing.origin : cursor };
    }),
    send: (request) => {
      if (options.failing === "send") return Effect.fail(failure);
      if (existing !== undefined && request.sessionId === "hand-1") return Effect.promise(async () => {
        calls.push(`send:${request.sessionId}:${request.text}`);
        // The resumed CLI answers into its transcript; the live watch's next drain admits it.
        existing.records.push({ kind: "turn", role: "assistant", text: "resumed" });
        await sources.get(`cli:${request.sessionId}`)?.observe();
        for (const listener of listeners) listener();
        return { status: "ok" as const };
      });
      return Effect.sync(() => {
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
      });
    },
    stop: (request) => options.failing === "stop" ? Effect.fail(failure) : Effect.sync(() => {
      calls.push(`stop:${request.sessionId}`);
      return { status: "ok" as const };
    }),
  };
  const runner = createCliRunner({
    instances: { get: (id) => (id === contact.id ? contact : id === handContact.id ? handContact : undefined) },
    machineKnown: (id) => id === "m-1",
    host: { get: () => ({ agentSession }) },
    watch: {
      install: (spec) => {
        installed.push(spec);
        if (existing === undefined) return Effect.void;
        // The hand-run path drains the real child source over the served pages, as the watch plane does.
        const source = childSource(spec, {
          machines: { get: () => ({ agentSession: { tail: existing.tail } }) },
          rows: () => rows,
          admit: (_sessionId, admitted) => {
            rows.push(...admitted);
            return Promise.resolve(admitted);
          },
        }, { clock: () => 1, failure: (error) => { throw error; } });
        sources.set(spec.id, source);
        return Effect.promise(async () => {
          await source.ready;
        });
      },
      close: (id) => {
        calls.push(`close:${id}`);
        const source = sources.get(id);
        sources.delete(id);
        return source === undefined ? Effect.void : Effect.promise(() => source.close());
      },
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

test("a contact attached to a hand-run session imports its transcript from byte zero, then resumes it on send", async () => {
  const existing = handRunTranscript([
    { kind: "turn", role: "user", text: "fix the build" },
    { kind: "tool_call", callId: "c-1", name: "bash", input: "bun run build" },
    { kind: "corrupt", reason: "invalid_shape", excerpt: "{" },
    { kind: "tool_result", callId: "c-1", output: "ok", failed: false },
    { kind: "turn", role: "assistant", text: "built" },
    { kind: "turn", role: "user", text: "now lint" },
    { kind: "turn", role: "assistant", text: "linted" },
  ]);
  const { runner, calls, installed, rows } = harness({ existing });
  const turn = await runEffect(runner.run({ agent: "hand", message: "continue", sender: SENDER, turnId: "t-1", key: "k-1" }));
  expect(turn).toEqual({ child: "hand-1", turn: "k-1", facts: 1 });
  // The open adopts the session without launching; every page is imported from byte zero before the send resumes it.
  expect(calls).toEqual(["open:claude-code:/work:hand-1", "close:cli:hand-1", "send:hand-1:continue"]);
  expect(existing.tails).toEqual([0, 3, 6, 7, 7]);
  expect(installed.map((spec) => [spec.id, spec.turn, spec.cursor.byteOffset])).toEqual([
    ["cli:hand-1", IMPORTED_TURN, 0], ["cli:hand-1", "k-1", 7],
  ]);
  // The history is admitted as the same rows under its own label; only the resumed answer ends the live turn.
  expect(rows.flatMap((row) => row.kind === "child_fact" ? [row.content] : [])).toEqual([
    { child: "hand-1", turn: IMPORTED_TURN, phase: "observed" },
    { child: "hand-1", turn: IMPORTED_TURN, phase: "requested", toolUseId: "c-1" },
    { child: "hand-1", turn: IMPORTED_TURN, phase: "result", toolUseId: "c-1" },
    { child: "hand-1", turn: IMPORTED_TURN, phase: "terminal" },
    { child: "hand-1", turn: "k-1", phase: "terminal" },
  ]);
  expect(rows.filter((row) => row.kind === "child_diagnostic")).toHaveLength(1);
  expect(contactCursor(rows, "hand")).toEqual({ ...existing.origin, byteOffset: 8, recordHash: "8".padStart(64, "0") });

  // A later letter continues from the persisted cursor, never byte zero: nothing is re-read.
  const again = await runEffect(runner.run({ agent: "hand", message: "more", sender: SENDER, turnId: "t-2", key: "k-2" }));
  expect(again).toEqual({ child: "hand-1", turn: "k-2", facts: 1 });
  expect(calls.slice(3)).toEqual(["close:cli:hand-1", "close:cli:hand-1", "send:hand-1:more"]);
  expect(installed.slice(2).map((spec) => [spec.turn, spec.cursor.byteOffset])).toEqual([[IMPORTED_TURN, 8], ["k-2", 8]]);
  expect(existing.tails.slice(5)).toEqual([8, 8, 8]);
  expect(contactCursor(rows, "hand")?.byteOffset).toBe(9);
});

test("an interrupt wakes the pending turn with the landed refusal and stops the child", async () => {
  const { runner, calls, listeners } = harness({ silent: true });
  const pending = runEffect(Effect.flip(runner.run({ agent: "reviewer", message: "review", sender: SENDER, turnId: "t-1", key: "k-1" })));
  expect(runner.owner("agent-1")).toBe(SENDER);
  await runEffect(runner.interrupt("agent-1"));
  expect(await pending).toEqual({ reason: "deadline expired; the child was interrupted", landed: true });
  expect(runner.owner("agent-1")).toBeUndefined();
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
