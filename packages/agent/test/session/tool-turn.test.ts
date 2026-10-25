import { expect, test } from "bun:test";
import { canonicalJson, type PlainValue, type Tool } from "@oni/protocol";
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { SingleRunner } from "effect/cluster";
import { TestClock } from "effect/testing";
import { z } from "zod";
import { defineTool } from "../../src/core/loop/tool";
import { executeExternalTool, createSessionEntityRunTool } from "../../src/core/session/tool-turn";
import { drain } from "../../src/core/session/entity-delivery";
import { ToolTurnRefused } from "../../src/core/journal/messages";
import { turnIntentAction, turnStopAction } from "../../src/core/journal/turn-rows";
import { receivedMessageAction, deliveryActions } from "../../src/core/journal/delivery";
import { runAgent } from "../helpers/isolated";
import { toolTurnWorld } from "../helpers/tool-turn";
import { compiledPolicy } from "../helpers/compiled-policy";
import { createSessionEntityLayer, SessionEntity, SessionEntityContext } from "../../src/core/session/entity";
import { createSessionPortsSlot, sessionTool } from "../../src/core/session/host";
import { BunTestCrypto } from "../helpers/cluster-runtime";
import { currentInvocation } from "../../src/core/loop/invocation";
import { deliver } from "../../src/core/session/entity-delivery";

const call: Tool.Call = { id: "outside-1", tool: "probe", input: { n: 7 } };
const probe = defineTool({
  name: "probe", description: "Probe", category: "query",
  input: z.object({ n: z.number() }), output: z.object({ n: z.number() }),
  visibility: { model: ["resident"], cell: ["resident"] },
  execute: async (input) => input, render: (_input, output) => JSON.stringify(output),
});

function countedProbe(onExecute: () => void) {
  return defineTool({
    ...probe, execute: async (value) => {
      onExecute();
      return value;
    },
  });
}

type World = Effect.Success<ReturnType<typeof toolTurnWorld>>;

/** A world whose first prompt has sealed, and the external call input naming that turn. */
function sealedWorld(options: Parameters<typeof toolTurnWorld>[0] = { definitions: [probe] }, origin?: PlainValue) {
  return Effect.gen(function* () {
    const world = yield* toolTurnWorld(options);
    yield* world.prompt(origin);
    yield* world.settled;
    return { world, input: source(world) };
  });
}

/** Holds a second model turn open until `finish` completes. */
function busyTurn(world: World) {
  return Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    world.run(() => Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Deferred.await(finish)), Effect.as({ kind: "result", text: "" }),
    ));
    yield* world.prompt();
    yield* Deferred.await(entered);
    return { finish, before: world.kernel.row(world.sessionId).revision };
  });
}

function entityLayer(world: World) {
  const slot = createSessionPortsSlot();
  slot.bind(world.handle.env.ports);
  return createSessionEntityLayer(world.handle.drain).pipe(
      Layer.provide(Layer.succeed(SessionEntityContext, {
        ...world.handle.env, ports: slot.ports, openSession: world.plane.handles.openSession,
      })),
      Layer.provideMerge(SingleRunner.layer({ runnerStorage: "sql" }).pipe(
        Layer.provide(SqliteClient.layer({ filename: ":memory:" })), Layer.provide(BunTestCrypto),
      )),
    );
}

test("the bound session tool client reaches the real entity activation and current fence", () =>
  runAgent(Effect.scoped(Effect.gen(function* () {
    const { world, input } = yield* sealedWorld();
    const result = yield* Effect.gen(function* () {
      const execute = yield* sessionTool;
      return yield* execute(world.sessionId, input);
    }).pipe(Effect.provide(entityLayer(world)));
    expect(result.structuredContent).toEqual({ n: 7 });
    expect(world.kernel.row(world.sessionId).fence).toBeGreaterThan(world.handle.authority.fence);
    expect(world.kernel.latestTurnTerminal(world.sessionId)?.effect.kind).toBe("result");
  }))));

test("interrupting the real client cancels the admitted body and seals before returning", () =>
  runAgent(Effect.scoped(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const aborted = yield* Deferred.make<void>();
    const blocking = defineTool({
      ...probe, execute: async (input, context) => {
        const done = Promise.withResolvers<void>();
        context.signal.addEventListener("abort", () => {
          Deferred.doneUnsafe(aborted, Exit.void);
          done.resolve();
        }, { once: true });
        Deferred.doneUnsafe(entered, Exit.void);
        await done.promise;
        return input;
      },
    });
    const { world, input } = yield* sealedWorld({ definitions: [blocking] });
    yield* Effect.gen(function* () {
      const execute = yield* sessionTool;
      const fiber = yield* Effect.forkChild(execute(world.sessionId, input));
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      yield* Deferred.await(aborted);
      expect(world.kernel.latestOpenTurn(world.sessionId)).toBeUndefined();
    }).pipe(Effect.provide(entityLayer(world)));
  }))));

test("a cancellation received before execution prevents a late request from running", () =>
  runAgent(Effect.scoped(Effect.gen(function* () {
    const { world, input } = yield* sealedWorld();
    const revision = world.kernel.row(world.sessionId).revision;
    yield* Effect.gen(function* () {
      const client = (yield* SessionEntity.client)(world.sessionId);
      yield* client.Tool({ op: "cancel", callId: call.id });
      yield* client.Tool({ op: "cancel", callId: call.id });
      const exit = yield* Effect.exit((yield* sessionTool)(world.sessionId, input));
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(world.kernel.row(world.sessionId).revision).toBe(revision);
    }).pipe(Effect.provide(entityLayer(world)));
  }))));

test("a retained tool generation releases after its external turn seals", () =>
  runAgent(Effect.scoped(Effect.gen(function* () {
    const retained = Promise.withResolvers<() => void>();
    const { world, input } = yield* sealedWorld({ definitions: [defineTool({
      ...probe, execute: async (value) => {
        retained.resolve(currentInvocation().generation.retain());
        return value;
      },
    })] });
    expect((yield* world.tool(input)).structuredContent).toEqual({ n: 7 });
    const release = yield* Effect.promise(() => retained.promise);
    release();
    yield* world.runtime.generations.settle;
  }))));

test("a completed external call id refuses replay without executing its body twice", () =>
  runAgent(Effect.scoped(Effect.gen(function* () {
    let executions = 0;
    const { world, input } = yield* sealedWorld({ definitions: [countedProbe(() => { executions++; })] });
    expect((yield* world.tool(input)).structuredContent).toEqual({ n: 7 });
    const revision = world.kernel.row(world.sessionId).revision;
    expect(yield* Effect.flip(world.tool(input))).toEqual(new ToolTurnRefused({ code: "duplicate" }));
    expect(world.kernel.row(world.sessionId).revision).toBe(revision);
    expect(executions).toBe(1);
  }))));

test("a new activation over the same store refuses an already recorded external call", () =>
  runAgent(Effect.scoped(Effect.gen(function* () {
    let executions = 0;
    const { world, input } = yield* sealedWorld({ definitions: [countedProbe(() => { executions++; })] });
    yield* world.tool(input);
    const kernel = world.plane.openKernel(world.sessionId);
    const authority = {
      ...world.handle.authority, fence: world.plane.catalog.rotateFence(world.sessionId),
    };
    yield* kernel.adoptFence(authority);
    const replacement = {
      ...world.handle, kernel, authority, toolCalls: new Map(world.handle.toolCalls),
    };
    const revision = kernel.row(world.sessionId).revision;
    expect(yield* Effect.flip(executeExternalTool(replacement, {
      ...input, call: canonicalJson(input.call),
    }))).toEqual(new ToolTurnRefused({ code: "duplicate" }));
    expect(kernel.row(world.sessionId).revision).toBe(revision);
    expect(executions).toBe(1);
  }))));

test("changing parameters cannot reuse a recorded external call id", () =>
  runAgent(Effect.scoped(Effect.gen(function* () {
    const { world, input } = yield* sealedWorld();
    yield* world.tool(input);
    const revision = world.kernel.row(world.sessionId).revision;
    expect(yield* Effect.flip(world.tool({
      ...input, call: { ...call, input: { n: 8 } },
    }))).toEqual(new ToolTurnRefused({ code: "duplicate" }));
    expect(world.kernel.row(world.sessionId).revision).toBe(revision);
  }))));

test("a distinct external call id still runs after another call seals", () =>
  runAgent(Effect.scoped(Effect.gen(function* () {
    let executions = 0;
    const { world, input } = yield* sealedWorld({ definitions: [countedProbe(() => { executions++; })] });
    expect((yield* world.tool(input)).structuredContent).toEqual({ n: 7 });
    expect((yield* world.tool({
      ...input, call: { ...input.call, id: "outside-2" },
    })).structuredContent).toEqual({ n: 7 });
    expect(executions).toBe(2);
  }))));

test("a distinct external call id scans past the first history page", () =>
  runAgent(Effect.scoped(Effect.gen(function* () {
    const { world, input } = yield* sealedWorld();
    yield* world.tool(input);
    const row = world.kernel.row(world.sessionId);
    const actions: ReturnType<typeof turnStopAction>[] = [];
    for (let index = 0; index < 260; index++) {
      actions.push(turnStopAction({
        id: `page-stop-${index}`, parentId: null, sessionId: world.sessionId,
        generation: 1, verdict: {}, state: {}, ts: 1,
      }));
    }
    yield* world.kernel.commit({
      ...world.handle.authority, now: 1, expectedRevision: row.revision, state: row.state,
      actions,
    });
    expect((yield* world.tool({
      ...input, call: { ...input.call, id: "after-page" },
    })).structuredContent).toEqual({ n: 7 });
  }))));

test("a recorded external call remains busy while its body is in flight", () =>
  runAgent(Effect.scoped(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = Promise.withResolvers<void>();
    const { world, input } = yield* sealedWorld({ definitions: [defineTool({
      ...probe, execute: async (value) => {
        Deferred.doneUnsafe(entered, Exit.void);
        await release.promise;
        return value;
      },
    })] });
    const running = yield* Effect.forkChild(world.tool(input), { startImmediately: true });
    yield* Deferred.await(entered);
    expect(yield* Effect.flip(world.tool(input))).toEqual(new ToolTurnRefused({ code: "busy" }));
    release.resolve();
    expect((yield* Fiber.join(running)).structuredContent).toEqual({ n: 7 });
    expect(yield* Effect.flip(world.tool(input))).toEqual(new ToolTurnRefused({ code: "duplicate" }));
  }))));

function source(world: World) {
  const terminal = world.kernel.latestTurnTerminal(world.sessionId);
  if (terminal === undefined) throw new Error("source turn has not sealed");
  return { sourceTurnId: terminal.effect.turnId, call, waitMs: 500 };
}

test("an external tool waits for the active turn's terminal without interleaving", () =>
  runAgent(Effect.scoped(Effect.gen(function* () {
    const { world, input } = yield* sealedWorld();
    const { finish, before } = yield* busyTurn(world);
    const pending = yield* Effect.forkChild(world.tool(input), { startImmediately: true });
    expect(world.kernel.row(world.sessionId).revision).toBe(before);
    yield* Deferred.succeed(finish, undefined);
    const result = yield* Fiber.join(pending);
    expect(result.structuredContent).toEqual({ n: 7 });
    const actions = world.kernel.historyPage(world.sessionId).actions;
    const interveningTerminal = actions.find((row) => row.ordinal > before && row.kind === "turn" &&
      z.object({ phase: z.literal("terminal") }).safeParse(row.effect.value).success);
    const intent = actions.find((row) => row.kind === "tool" &&
      z.object({ phase: z.literal("intent"), op: z.literal("probe") }).safeParse(row.intent.value).success);
    expect(intent?.ordinal).toBeGreaterThan(interveningTerminal?.ordinal ?? Number.MAX_SAFE_INTEGER);
  })).pipe(Effect.provide(TestClock.layer()))));

test("bounded busy admission returns its typed refusal and commits nothing", () =>
  runAgent(Effect.scoped(Effect.gen(function* () {
    const { world, input } = yield* sealedWorld();
    const { finish, before } = yield* busyTurn(world);
    const pending = yield* Effect.forkChild(Effect.flip(world.tool(input)), { startImmediately: true });
    expect(yield* Effect.flip(world.tool(input))).toEqual(new ToolTurnRefused({ code: "busy" }));
    yield* TestClock.adjust(500);
    expect(yield* Fiber.join(pending)).toEqual(new ToolTurnRefused({ code: "busy" }));
    expect(world.kernel.row(world.sessionId).revision).toBe(before);
    yield* Deferred.succeed(finish, undefined);
    yield* world.settled;
  })).pipe(Effect.provide(TestClock.layer()))));

test.each([
  ["missing", { kind: "external", inboundTreatment: "full_access" }],
  ["evidence", { kind: "external", inboundTreatment: "evidence_only" }],
] as const)("a %s source authority cannot enter an external tool turn", (_name, origin) =>
  runAgent(Effect.scoped(Effect.gen(function* () {
    const { world, input } = yield* sealedWorld({ definitions: [probe] }, origin);
    const before = world.kernel.row(world.sessionId).revision;
    expect(yield* Effect.flip(world.tool({
      ...input, sourceTurnId: _name === "missing" ? "absent" : input.sourceTurnId,
    }))).toEqual(new ToolTurnRefused({ code: "origin" }));
    expect(world.kernel.row(world.sessionId).revision).toBe(before);
  }))));

test("an action-only turn never borrows an earlier trusted prompt", () =>
  runAgent(Effect.scoped(Effect.gen(function* () {
    const { world } = yield* sealedWorld();
    yield* deliver(world.handle, {
      kind: "action", body: '{"content":"untrusted call"}',
      source: canonicalJson({ kind: "external", inboundTreatment: "evidence_only" }),
      idempotencyKey: "untrusted-action",
    });
    yield* world.settled;
    const before = world.kernel.row(world.sessionId).revision;
    expect(yield* Effect.flip(world.tool(source(world)))).toEqual(new ToolTurnRefused({ code: "origin" }));
    expect(world.kernel.row(world.sessionId).revision).toBe(before);
  }))));

test("an external turn retains its source authority after a later evidence-only prompt", () =>
  runAgent(Effect.scoped(Effect.gen(function* () {
    const { world, input } = yield* sealedWorld();
    yield* world.prompt({ kind: "external", inboundTreatment: "evidence_only" });
    yield* world.settled;
    expect((yield* world.tool(input)).structuredContent).toEqual({ n: 7 });
    // A tool that starts another external producer uses that turn's recorded source.
    expect((yield* world.tool({ ...source(world), call: { ...call, id: "outside-2" } })).structuredContent).toEqual({ n: 7 });
  }))));

test.each([
  ["full_access", true],
  ["evidence_only", false],
] as const)("an action-only %s turn gates a later external tool from its recorded origin", (treatment, allowed) =>
  runAgent(Effect.scoped(Effect.gen(function* () {
    let authority: string | undefined;
    const world = yield* toolTurnWorld({
      definitions: [probe],
      runner: (input) => {
        authority = input.authority;
        return Effect.succeed({ kind: "result", text: "" });
      },
    });
    yield* deliver(world.handle, {
      kind: "action", body: '{"content":"start call"}',
      source: canonicalJson({
        kind: "external", inboundTreatment: treatment,
        automation: { id: "call-rule", newSession: false },
      }), idempotencyKey: "call-trigger",
    });
    yield* world.settled;
    const input = source(world);
    const before = world.kernel.row(world.sessionId).revision;
    if (allowed) {
      expect(authority).toBe("act");
      expect((yield* world.tool(input)).structuredContent).toEqual({ n: 7 });
    } else {
      expect(authority).toBe("evidence_only");
      expect(yield* Effect.flip(world.tool(input))).toEqual(new ToolTurnRefused({ code: "origin" }));
      expect(world.kernel.row(world.sessionId).revision).toBe(before);
    }
  }))));

test.each([
  ["malformed", "{}", 1],
  ["malformed", canonicalJson(call), -1],
  ["malformed", canonicalJson(call), 60_001],
  ["malformed", canonicalJson(call), Number.NaN],
] as const)("external admission refuses %s payload %s and bound %s", (code, encoded, waitMs) =>
  runAgent(Effect.scoped(Effect.gen(function* () {
    const world = yield* toolTurnWorld();
    expect(yield* Effect.flip(executeExternalTool(world.handle, {
      sourceTurnId: "absent", call: encoded, waitMs,
    }))).toEqual(new ToolTurnRefused({ code }));
  }))));

test.each(["closed", "busy", "unavailable"] as const)("external admission refuses a %s activation", (code) =>
  runAgent(Effect.scoped(Effect.gen(function* () {
    const { world, input } = yield* sealedWorld({});
    if (code === "closed") world.handle.closing.current = true;
    if (code === "busy") {
      const row = world.kernel.row(world.sessionId);
      yield* world.kernel.commit({
        ...world.handle.authority, now: 1, expectedRevision: row.revision, actions: [], state: "interrupted",
      });
    }
    const handle = code === "unavailable" ? {
      ...world.handle,
      env: { ...world.handle.env, ports: { ...world.handle.env.ports, runTool: undefined } },
    } : world.handle;
    expect(yield* Effect.flip(executeExternalTool(handle, { ...input, call: canonicalJson(call) })))
      .toEqual(new ToolTurnRefused({ code }));
  }))));

test("a denied external turn returns one failure without running its tool", () =>
  runAgent(Effect.scoped(Effect.gen(function* () {
    const { world, input } = yield* sealedWorld({ definitions: [probe], policy: compiledPolicy([{
      name: "deny-turn", kind: "turn", phase: "pre", priority: 1, generation: 1,
      match: { encodingVersion: 1, value: {} },
      verdict: { encodingVersion: 1, value: { type: "deny", reason: "turn_denied" } },
    }]) });
    const result = yield* world.tool(input);
    expect(result.isError).toBe(true);
    expect(result.content).toBe("session policy refused");
    expect(world.kernel.historyPage(world.sessionId).actions.filter((row) => row.kind === "tool")).toHaveLength(0);
  }))));

test("a turn.post refusal returns the sealed error even after the tool body succeeds", () =>
  runAgent(Effect.scoped(Effect.gen(function* () {
    let executions = 0;
    const world = yield* toolTurnWorld({
      definitions: [defineTool({
        ...probe, execute: async (input) => {
          executions++;
          return input;
        },
      })],
      policy: compiledPolicy([{
        name: "deny-terminal", kind: "turn", phase: "post", priority: 1, generation: 1,
        match: { encodingVersion: 1, value: {} },
        verdict: { encodingVersion: 1, value: { type: "deny", reason: "terminal_refused" } },
      }]),
    });
    yield* world.prompt();
    yield* world.settled;
    const result = yield* world.tool(source(world));
    expect(executions).toBe(1);
    expect(world.kernel.latestTurnTerminal(world.sessionId)?.effect.kind).toBe("error");
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toBe("session policy refused");
  }))));

test("the run port independently refuses a missing source before writing", () =>
  runAgent(Effect.scoped(Effect.gen(function* () {
    const world = yield* toolTurnWorld();
    const port = createSessionEntityRunTool(world.execute, world.runtime, world.handle.scope);
    const result = yield* Effect.flip(port({
      authority: world.handle.authority, kernel: world.kernel, call, sourceTurnId: "missing",
    }));
    expect(result).toMatchObject({ _tag: "AgentFailure", operation: "session.tool", cause: "origin" });
  }))));

test("external tool turns bind the app's live runner surfaces", () =>
  runAgent(Effect.scoped(Effect.gen(function* () {
    const turns: string[] = [];
    const { world, input } = yield* sealedWorld({ definitions: [probe], wrap: (runner) => (turn) => {
        turns.push(turn.turnId);
        return runner(turn);
      } });
    expect((yield* world.tool(input)).structuredContent).toEqual({ n: 7 });
    expect(turns).toHaveLength(1);
    expect(turns[0]).not.toBe(input.sourceTurnId);
    expect(turns[0]).toBe(world.kernel.latestTurnTerminal(world.sessionId)?.effect.turnId);
  }))));

test("recovery seals an external turn without entering the model runner", () =>
  runAgent(Effect.scoped(Effect.gen(function* () {
    let modelCalls = 0;
    const world = yield* toolTurnWorld({ runner: () => {
      modelCalls += 1;
      return Effect.succeed({ kind: "result", text: "" });
    } });
    const input = {
      id: "external-input", sessionId: world.sessionId, kind: "action" as const, content: "",
      origin: { encodingVersion: 1 as const, value: {
        kind: "external", inboundTreatment: "full_access", toolCall: call, sourceTurnId: "origin",
      } },
      status: "pending" as const, consumedBy: null, consumedAt: null, createdAt: 1, ordinal: 2,
    };
    const actions = [
      receivedMessageAction({ ...input, parentActionId: null, at: 1 }),
      ...deliveryActions([input], { kind: "turn", turnId: "abandoned" }, "before_llm", null),
      turnIntentAction({
        id: "abandoned", sessionId: world.sessionId, parentId: "external-input:delivery",
        resultId: "abandoned:result", deliveryIds: [input.id], generation: world.kernel.latestGenerationFor(world.sessionId),
        resumeCount: 0, boundaryActionId: null, at: 1,
      }),
    ];
    yield* world.kernel.commit({
      ...world.handle.authority, now: 1, expectedRevision: world.kernel.row(world.sessionId).revision,
      actions, state: "running",
    });
    yield* drain(world.handle);
    expect(modelCalls).toBe(0);
    expect(world.kernel.latestTurnTerminal(world.sessionId)?.effect.kind).toBe("error");
    expect(world.kernel.row(world.sessionId).state).toBe("idle");
  }))));
