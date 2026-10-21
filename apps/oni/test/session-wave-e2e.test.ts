import { sessionTree } from "../../../packages/agent/test/store/helpers/session-tree";
import { dispatcherFixture } from "./helpers/dispatcher-fixture";
import { expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Core } from "@oni/agent";
const currentExecutor = Core.currentExecutor;
const InvocationClosed = Core.InvocationClosed;
type InvocationClosed = Core.InvocationClosed;
type ExecutionApprovalRequest = Core.ExecutionApprovalRequest;
import { Bus, newTraceId } from "./helpers/bus";
import { z } from "zod";
import {
  LlmCall,
  L0Observation,
  Tool,
  type AnyToolDefinition,
  type PlainObject,
} from "@oni/protocol";
import { sessionFilePath, type AppLedgerPlane } from "../src/composition/cluster-runtime";
import { runAppEffect } from "../src/gateway";
import { planeOf } from "./helpers/ledger";
import { residentSuite } from "./helpers/resident-suite";
import { nextResidentTurn } from "./helpers/resident-turn";
import { runEffect } from "./helpers/effect";
import { testToolsBundle } from "./helpers/app-fixture";
import type { AppSessionHandle } from "../src/index";
import { contentBlocks, messageStart, messageEnd, sseResponse } from "./helpers/anthropic-sse";
import {
  adoptAtFence,
  bounded as waveBounded,
  commitInterrupt,
  commitPrompt,
  interruptDeliveries,
  ProviderRequest,
  trackedWaveTools,
  waveTool,
  interruptDuringSecondModel,
  interruptSecondModel,
} from "./helpers/session-wave";
import { approvalPolicy } from "./helpers/approval-policy";

const suite = residentSuite();
// The booted app's ledger plane, reset per test (W5.2): free helpers below
// read durable state through it instead of the deleted global store.
const planeRef: { current: AppLedgerPlane | undefined } = { current: undefined };
function plane(): AppLedgerPlane {
  if (planeRef.current === undefined) throw new Error("app plane not booted");
  return planeRef.current;
}
function tree(sessionId: string) {
  return sessionTree(sessionId, plane().sessionStore(sessionId).actions);
}
async function adoptPlane(runtime: Parameters<typeof planeOf>[0]) {
  planeRef.current = await planeOf(runtime);
  suite.defer(() => {
    planeRef.current = undefined;
  });
}

function bounded<T>(promise: Promise<T>, label = "wave/recovery"): Promise<T> {
  return waveBounded(promise).catch((cause: Error) => {
    throw new Error(`missing ${label}`, { cause });
  });
}

function waveConfig(prefix: string, providerPort: number | undefined) {
  return suite.config(prefix, {
    compactionSummarizer: false,
    wsToken: "wave-token",
    model: {
      provider: "anthropic",
      id: "wave",
      apiKey: "key",
      baseUrl: `http://127.0.0.1:${providerPort}/v1`,
    },
  });
}

function waveLlm(): NonNullable<Parameters<typeof suite.boot>[0]>["llm"] {
  return {
    resolveModel: () =>
      Effect.succeed({
        id: "wave",
        name: "wave",
        providerID: "anthropic",
        api: { npm: "@ai-sdk/anthropic" },
        limit: { context: 100000 },
      }),
  };
}

/** A contender at the held fence is refused while the live effect retains it. */
function expectFenceHeld(sessionId: string, contender: string, fenceOwner: string | null) {
  const held = plane().openKernel(sessionId).row(sessionId);
  expect(adoptAtFence(plane(), sessionId, contender, held.fence)).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "FenceRefused", reason: "stale" },
  });
  expect(held.fenceOwner).toBe(fenceOwner);
}

/** W5.2: the turn's adopted fence is permanent; a strictly newer fence still adopts. */
function expectFenceHandover(sessionId: string, contender: string) {
  const released = plane().openKernel(sessionId).row(sessionId);
  expect(adoptAtFence(plane(), sessionId, contender, released.fence + 1)).toMatchObject({
    _tag: "Success",
    success: { fence: released.fence + 1 },
  });
}

/** A settled executor refuses stale raw bodies without ever starting them. */
async function expectStaleClosed<A, E>(
  stale: () => Effect.Effect<A, E>,
  bodyStarts: () => number,
): Promise<void> {
  expect(await runEffect(Effect.flip(stale()))).toMatchObject({
    _tag: "InvocationClosed",
    reason: "settled",
  });
  expect(bodyStarts()).toBe(0);
}

interface ProviderCall {
  readonly id: string;
  readonly name: string;
  readonly input: PlainObject;
}
function providerResponse(calls: readonly ProviderCall[]): Response {
  const blocks =
    calls.length > 0
      ? calls.map((call) => ({
          start: { type: "tool_use", id: call.id, name: call.name, input: {} },
          delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
        }))
      : [{ start: { type: "text", text: "" }, delta: { type: "text_delta", text: "finished" } }];
  const frames = [
    messageStart("wave-provider", "wave", 10),
    ...contentBlocks(blocks),
    ...messageEnd(calls.length > 0 ? "tool_use" : "end_turn", 2),
  ];
  return sseResponse(frames);
}

test("real provider returns calls before any app tool body starts", async () => {
  // Given: real app, SQLite, SDK and a provider tool-use response.
  let requests = 0;
  let bodies = 0;
  const countsAtModelReturn: number[] = [];
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests += 1;
      return providerResponse(
        requests === 1
          ? [
              {
                id: "original-call",
                name: "provision",
                input: { operation: { op: "status", args: {} } },
              },
            ]
          : [],
      );
    },
  });
  suite.defer(() => provider.stop(true));
  const app = await suite.boot({
    config: waveConfig("oni-937-wave-red-", provider.port),
    llm: waveLlm(),
  });
  await adoptPlane(app.runtime);
  suite.defer(
    Bus.subscribe(Tool.Events.Started, (event) => {
      if (event.toolName === "provision") bodies += 1;
    }),
  );
  suite.defer(
    Bus.subscribe(LlmCall.Events.Completed, () => {
      countsAtModelReturn.push(bodies);
    }),
  );
  const socket = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "wave-token"]);
  // When: the public channel triggers a model step with a native tool call.
  const response = nextResidentTurn(plane(), 5000);
  socket.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "read current status" }));
  await response;
  // Then: provider I/O did not execute the body before returning its calls.
  expect(countsAtModelReturn[0]).toBe(0);
  expect(bodies).toBe(1);
});

async function waveApp(
  definitions: readonly AnyToolDefinition[],
  names: readonly string[],
  sessionRuntime?: NonNullable<Parameters<typeof suite.boot>[0]>["sessionRuntime"],
  /** Parks the provider's n-th response until the promise settles (exact-state gating). */
  hold?: (request: number) => Promise<void>,
) {
  const received: z.infer<typeof ProviderRequest>[] = [];
  const calls = names.map((name) => ({ id: `call-${name}`, name, input: { slot: name } }));
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      received.push(ProviderRequest.parse(JSON.parse(await request.text())));
      await hold?.(received.length);
      return providerResponse(received.length === 1 ? calls : []);
    },
  });
  suite.defer(async () => {
    const port = provider.port;
    await provider.stop(true);
    const probe = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() });
    await probe.stop(true);
  });
  const config = waveConfig("oni-937-wave-", provider.port);
  const app = await suite.boot({
    config,
    bundles: [testToolsBundle(definitions)],
    sessionRuntime: { closeGraceMs: 0, ...sessionRuntime },
    llm: waveLlm(),
  });
  await adoptPlane(app.runtime);
  const socket = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "wave-token"]);
  const cleanup = async () => {
    await suite.cleanup();
    if (config.catalogPath === undefined) throw new Error("suite config always sets catalogPath");
    expect(existsSync(dirname(config.catalogPath))).toBe(false);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    const probe = Bun.serve({ hostname: "127.0.0.1", port: app.port, fetch: () => new Response() });
    await probe.stop(true);
  };
  const sessionsDir = config.sessionsDir;
  if (sessionsDir === undefined) throw new Error("suite config always sets sessionsDir");
  return { app, socket, received, sessionDbPath: (sessionId: string) => sessionFilePath(sessionsDir, sessionId), cleanup };
}

function toolResults(sessionId: string) {
  const result = z.object({ phase: z.literal("result"), terminal: z.string(), callId: z.string() });
  return tree(sessionId)
    .filter(
      (action) =>
        action.kind === "tool" &&
        z.object({ op: z.string() }).parse(action.intent.value).op !== "send_message",
    )
    .flatMap((action) => {
      const parsed = result.safeParse(action.effect.value);
      return parsed.success ? [parsed.data] : [];
    });
}

function nextTerminal(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error("missing session terminal"));
    }, 5000);
    const stop = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
      if (event.sessionId === "gateway-ingress" || event.kind !== "turn") return;
      const terminal = tree(event.sessionId).find(
        (action) => action.id === event.id,
      );
      if (terminal === undefined || Core.SessionHandleStore.turnTerminal(terminal) === undefined) return;
      clearTimeout(timer);
      stop();
      resolve();
    });
    suite.defer(() => {
      clearTimeout(timer);
      stop();
    });
  });
}

function activeRow() {
  const row = plane().listSessions().find((item) => item.id !== "gateway-ingress");
  if (row === undefined) throw new Error("missing app session");
  return row;
}

function nextApproval(app: Awaited<ReturnType<typeof waveApp>>["app"]) {
  const waiting = Promise.withResolvers<{
    handle: AppSessionHandle;
    request: ExecutionApprovalRequest;
  }>();
  suite.defer(
    Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
      const handle = app.sessions.get(event.sessionId);
      const request = handle?.approvals.pending()[0];
      if (handle !== undefined && request !== undefined) waiting.resolve({ handle, request });
    }),
  );
  return waiting.promise;
}

function requireBApproval() {
  const policies = plane().catalog.policies;
  expect(
    policies.append(approvalPolicy("approve-B")),
  ).toBe(true);
}

test("after-model SDK interrupt starts zero bodies and seals one interrupted terminal", async () => {
  // Given: subscribe before the real model emits its complete invocation.
  let bodies = 0;
  const { app, socket, received } = await waveApp(
    [
      waveTool("A", async () => {
        bodies += 1;
        return "A";
      }),
    ],
    ["A"],
  );
  const interrupted = Promise.withResolvers<void>();
  suite.defer(
    Bus.subscribe(LlmCall.Events.Completed, (event) => {
      const handle = app.sessions.get(event.sessionId);
      if (handle === undefined) return interrupted.reject(new Error("missing live SDK handle"));
      void runEffect(handle.interrupt()).then(interrupted.resolve, interrupted.reject);
    }),
  );
  // When: interrupt at the real provider-return boundary, before any tool body.
  const settled = nextTerminal();
  socket.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "run A" }));
  await bounded(interrupted.promise);
  // The seal is the turn fiber's own commit; await its exact terminal signal.
  await settled;
  // Then: exactly the original turn is interrupted without a body or second call.
  expect(bodies).toBe(0);
  expect(received).toHaveLength(1);
  const terminals = tree(activeRow().id).flatMap((action) => {
    const terminal = Core.SessionHandleStore.turnTerminal(action);
    return terminal ? [terminal] : [];
  });
  expect(terminals.map((terminal) => terminal.kind)).toEqual(["interrupted"]);
});

// #1346: the interrupt rides the entity's `Deliver` door. The two cases the
// asynchronous door must not regress: an interrupt issued on the turn's LAST
// model completion still aborts it (the live turn holds its seal), and an
// interrupt that arrives once the turn has sealed writes no stray signal.
test("an interrupt on the last model completion aborts the turn through the entity door", async () => {
  const { app, socket, received, cleanup } = await waveApp([waveTool("A", async () => "A")], ["A"]);
  const interrupted = interruptSecondModel(suite, () => received.length, () => app.sessions.get(activeRow().id));
  const settled = nextTerminal();
  try {
    socket.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "run A" }));
    await bounded(interrupted);
    await settled;
    const row = activeRow();
    // The last completion carried no calls: the turn had nothing left but its
    // seal, and the interrupt still won — durable row, drain, interrupted terminal.
    expect(received).toHaveLength(2);
    expect(toolResults(row.id).map((result) => [result.callId, result.terminal])).toEqual([["call-A", "executed"]]);
    const actions = tree(row.id);
    const interruptRow = actions.find(
      (action) => action.kind === "signal" && z.object({ deliveryKind: z.literal("interrupt") }).safeParse(action.effect.value).success,
    );
    if (interruptRow === undefined) throw new Error("missing durable interrupt row");
    const kernel = plane().openKernel(row.id);
    const current = kernel.row(row.id);
    // The entity writer owns the interrupt row: the row's commit owner is the
    // activation's fence owner, and the transition `running -> interrupted` is durable.
    expect(current.fenceOwner).not.toBeNull();
    expect(interruptRow.sessionId).toBe(row.id);
    expect(current.state).toBe("interrupted");
    const terminals = actions.flatMap((action) => {
      const terminal = Core.SessionHandleStore.turnTerminal(action);
      return terminal ? [terminal] : [];
    });
    expect(terminals.map((terminal) => terminal.kind)).toEqual(["interrupted"]);
    expect(kernel.pendingMessages(row.id).filter((item) => item.kind === "interrupt")).toEqual([]);
  } finally {
    await cleanup();
  }
});

test("an interrupt after the turn sealed leaves no stray consumable signal", async () => {
  const { app, socket, cleanup } = await waveApp([waveTool("A", async () => "A")], ["A"]);
  const settled = nextTerminal();
  try {
    socket.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "run A" }));
    await settled;
    const row = activeRow();
    const kernel = plane().openKernel(row.id);
    // The facade: no live turn means no handle at all — the early return
    // is structural, nothing can issue an interrupt on a sealed session.
    expect(app.sessions.get(row.id)).toBeUndefined();
    // The entity door itself: an interrupt control with no running turn is
    // consumed by the activation's drain as a no-op delivery — the control
    // row and its delivery record land, nothing stays pending for the NEXT
    // turn to abort, and the row state is untouched (no `interrupted`).
    const landed = await runAppEffect(
      app.runtime,
      Effect.scoped(
        Effect.gen(function* () {
          const makeClient = yield* Core.SessionEntity.client;
          return yield* makeClient(row.id).Deliver({
            kind: "signal",
            body: JSON.stringify({ content: "", control: "interrupt" }),
            source: JSON.stringify({ kind: "session", id: row.id }),
            idempotencyKey: "late-interrupt",
          });
        }),
      ),
    );
    expect(landed.existed).toBe(false);
    expect(tree(row.id).map((action) => action.id)).toEqual(expect.arrayContaining(["late-interrupt", "late-interrupt:delivery"]));
    expect(kernel.row(row.id)).toMatchObject({ state: "idle" });
    expect(kernel.pendingMessages(row.id)).toEqual([]);
    const terminals = tree(row.id).flatMap((action) => {
      const terminal = Core.SessionHandleStore.turnTerminal(action);
      return terminal ? [terminal] : [];
    });
    expect(terminals.map((terminal) => terminal.kind)).toEqual(["result"]);
  } finally {
    await cleanup();
  }
});

test("all pre decisions precede A B C and reverse completion preserves ledger/provider order across D", async () => {
  // Given: exact body-entry signals and independently controlled completion.
  const gates = new Map(
    ["A", "B", "C", "D"].map((name) => [name, Promise.withResolvers<string>()]),
  );
  const entered = Promise.withResolvers<void>();
  const dEntered = Promise.withResolvers<void>();
  const started: string[] = [];
  const preCounts: number[] = [];
  const definitions = [...gates].map(([name, gate]) =>
    waveTool(
      name,
      async () => {
        started.push(name);
        preCounts.push(
          tree(activeRow().id).filter(
            (action) =>
              action.kind === "policy.decision" &&
              z.object({ hook: z.literal("tool.pre") }).safeParse(action.intent.value).success,
          ).length,
        );
        if (started.length === 3) entered.resolve();
        if (name === "D") dEntered.resolve();
        return gate.promise;
      },
      name === "D" ? true : undefined,
    ),
  );
  const { socket, received, sessionDbPath, cleanup } = await waveApp(definitions, ["A", "B", "C", "D"]);
  const response = nextResidentTurn(plane(), 5000);
  try {
    // When: complete parallel bodies in reverse while D is a sequential barrier.
    socket.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "run wave" }));
    await bounded(entered.promise);
    expect(started).toEqual(["A", "B", "C"]);
    expect(preCounts).toEqual([4, 4, 4]);
    gates.get("C")?.resolve("C");
    gates.get("B")?.resolve("B");
    expect(started).toEqual(["A", "B", "C"]);
    gates.get("A")?.resolve("A");
    await bounded(dEntered.promise);
    expect(received).toHaveLength(1);
    gates.get("D")?.resolve("D");
    await response;
    // Then: both durable result ordinals and real next-provider blocks preserve slots.
    expect(started).toEqual(["A", "B", "C", "D"]);
    expect(toolResults(activeRow().id).map((result) => result.callId)).toEqual([
      "call-A",
      "call-B",
      "call-C",
      "call-D",
    ]);
    const blocks =
      received[1]?.messages.flatMap((message) =>
        typeof message.content === "string" ? [] : message.content,
      ) ?? [];
    expect(
      blocks.filter((block) => block.type === "tool_result").map((block) => block.tool_use_id),
    ).toEqual(["call-A", "call-B", "call-C", "call-D"]);
    const db = new Database(sessionDbPath(activeRow().id), { readonly: true });
    try {
      const persisted = db
        .query<{ effect: string }, []>(
          "SELECT effect FROM action WHERE kind = 'tool' AND json_extract(intent, '$.op') != 'send_message' ORDER BY ordinal",
        )
        .all();
      const decoded = persisted.flatMap((row) => {
        const parsed = z
          .object({ phase: z.literal("result"), callId: z.string() })
          .safeParse(JSON.parse(row.effect));
        return parsed.success ? [parsed.data.callId] : [];
      });
      expect(decoded).toEqual(["call-A", "call-B", "call-C", "call-D"]);
    } finally {
      db.close();
    }
    console.log(
      "937 ordered wave",
      JSON.stringify({
        preCounts,
        results: toolResults(activeRow().id),
        requests: received.length,
      }),
    );
  } finally {
    for (const [name, gate] of gates) gate.resolve(name);
    await cleanup();
  }
});

for (const decision of ["approve", "refuse"] as const) {
  test(`authenticated ${decision} of B holds A/C and retains the original invocation`, async () => {
    const started: string[] = [];
    const definitions = ["A", "B", "C"].map((name) =>
      waveTool(name, async () => {
        started.push(name);
        return name;
      }),
    );
    const { app, socket, received } = await waveApp(definitions, ["A", "B", "C"]);
    requireBApproval();
    const waiting = nextApproval(app);
    const response = nextResidentTurn(plane(), 5000);
    socket.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "approved wave" }));
    const { handle, request } = await bounded(waiting);
    expect(started).toEqual([]);
    expect(request).toMatchObject({ callId: "call-B", generation: 1, intent: { slot: "B" } });
    expect(
      await runEffect(
        Effect.flip(handle.approvals.answer({ request, decision, credential: "forged" })),
      ),
    ).toMatchObject({ code: "unauthenticated" });
    expect(
      await runEffect(
        Effect.flip(
          handle.approvals.answer({
            request: { ...request, inputHash: "wrong" },
            decision,
            credential: "wave-token",
          }),
        ),
      ),
    ).toMatchObject({ code: "stale_approval" });
    expect(started).toEqual([]);
    // When: authenticated Owner evidence answers the captured original request.
    await runEffect(handle.approvals.answer({ request, decision, credential: "wave-token" }));
    await response;
    // Then: refusal affects only B, approval executes that same slot exactly once.
    expect(started).toEqual(decision === "approve" ? ["A", "B", "C"] : ["A", "C"]);
    expect(received).toHaveLength(2);
    expect(toolResults(handle.id).map((result) => [result.callId, result.terminal])).toEqual([
      ["call-A", "executed"],
      ["call-B", decision === "approve" ? "executed" : "blocked_pre"],
      ["call-C", "executed"],
    ]);
    expect(
      await runEffect(
        Effect.flip(handle.approvals.answer({ request, decision, credential: "wave-token" })),
      ),
    ).toMatchObject({ code: "stale_approval" });
  });
}

test("interrupting pending B cancels every unstarted positional slot", async () => {
  const started: string[] = [];
  const { app, socket, received } = await waveApp(trackedWaveTools(started), ["A", "B", "C"]);
  requireBApproval();
  const waiting = nextApproval(app);
  socket.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "hold wave" }));
  const { handle, request } = await bounded(waiting);
  expect(started).toEqual([]);
  const settled = nextTerminal();
  await bounded(runEffect(handle.interrupt()));
  await settled;
  expect(started).toEqual([]);
  expect(received).toHaveLength(1);
  expect(toolResults(handle.id).map((result) => [result.callId, result.terminal])).toEqual([
    ["call-A", "interrupted"],
    ["call-B", "blocked_pre"],
    ["call-C", "interrupted"],
  ]);
  expect(
    await runEffect(
      Effect.flip(
        handle.approvals.answer({ request, decision: "approve", credential: "wave-token" }),
      ),
    ),
  ).toMatchObject({ code: "stale_approval" });
});

test("noncooperative bodies release the wave but retain fence ownership and cannot commit late", async () => {
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const late = Promise.withResolvers<string>();
  let signal: AbortSignal | undefined;
  const definitions = [
    waveTool("A", async () => "A", true),
    waveTool("B", async (currentSignal) => {
      signal = currentSignal;
      const executor = currentExecutor();
      entered.resolve();
      await gate.promise;
      const outcome = await runEffect(
        Effect.exit(
          executor.run({ kind: "tool", op: "late-callback", intent: {}, effect: {} }, () =>
            Effect.succeed({ bad: true }),
          ),
        ),
      );
      late.resolve(
        Exit.isFailure(outcome)
          ? Cause.hasInterrupts(outcome.cause)
            ? "interrupted"
            : "failed"
          : "committed",
      );
      return "late B";
    }),
  ];
  const { app, socket, received } = await waveApp(definitions, ["A", "B"]);
  try {
    socket.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "interrupt running wave" }));
    await bounded(entered.promise);
    const row = activeRow();
    const handle = app.sessions.get(row.id);
    if (handle === undefined) throw new Error("missing session handle");
    const settled = nextTerminal();
    await bounded(runEffect(handle.interrupt()));
    await settled;
    expect(signal?.aborted).toBe(true);
    expect(toolResults(row.id).map((result) => [result.callId, result.terminal])).toEqual([
      ["call-A", "executed"],
      ["call-B", "outcome_unknown"],
    ]);
    expect(plane().openKernel(row.id).row(row.id).fenceOwner).not.toBeNull();
    expect(received).toHaveLength(1);
    gate.resolve();
    expect(await bounded(late.promise)).toBe("failed");
    // W5.2: the close plane is gone; the turn's fence adoption is permanent,
    // so the durable owner stays on the row after the raw body settles.
    expect(plane().openKernel(row.id).row(row.id).fenceOwner).not.toBeNull();
    expect(
      tree(row.id).some(
        (action) =>
          z.object({ op: z.literal("late-callback") }).safeParse(action.intent.value).success,
      ),
    ).toBe(false);
    expect(received).toHaveLength(1);
  } finally {
    gate.resolve();
  }
});

for (const door of ["captured-cell", "captured-wave"] as const) {
  test(`nested raw effects retain fence ownership through ${door} after caller interruption`, async () => {
    // Given: the review countercase, through the real app/SDK/SSE and file SQLite.
    const captured = Promise.withResolvers<ReturnType<typeof currentExecutor>>();
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    const outerDone = Promise.withResolvers<void>();
    const parentSettled = Promise.withResolvers<void>();
    const wrapperSettled = Promise.withResolvers<string | InvocationClosed>();
    const directory = suite.tempDir("oni-937-nested-effect-");
    const marker = join(directory, "effect.bin");
    const bytes = new Uint8Array([9, 3, 7]);
    const rawBody = async () => {
      entered.resolve();
      await gate.promise;
      writeFileSync(marker, bytes);
      completed.resolve();
      return "effect";
    };
    const request = { kind: "tool", op: "nested-effect", intent: {}, effect: {} };
    let signal = new AbortController().signal;
    let sessionId = "";
    const attemptInvoke = async (executor: ReturnType<typeof currentExecutor>): Promise<string> => {
      const dispatcher = dispatcherFixture([waveTool("inner", rawBody)], { executor });
      const call = { id: "inner-call", tool: "inner", input: { slot: "inner" } };
      const context = { sessionId, turnId: "captured-turn", signal };
      if (door === "captured-cell") {
        const outcome = await runEffect(dispatcher.executeCell(call, context));
        return outcome.isError ? "outcome_unknown" : "executed";
      }
      const results = await runEffect(dispatcher.executeWave([call], context));
      return results.every((result) => result.isError) ? "outcome_unknown" : "executed";
    };
    const invoke = (executor: ReturnType<typeof currentExecutor>): Promise<string | InvocationClosed> =>
      attemptInvoke(executor).catch((error: Error) =>
        error instanceof InvocationClosed ? error : error.name);
    let handle: AppSessionHandle | undefined;
    const interrupt = interruptDuringSecondModel(() => handle);
    const { app, socket, received, cleanup } = await waveApp(
      [
        waveTool("A", async () => "A", true),
        waveTool("outer", async (turnSignal) => {
          signal = turnSignal;
          const executor = currentExecutor();
          captured.resolve(executor);
          try {
            await outerDone.promise;
          } finally {
            parentSettled.resolve();
          }
          return "outer";
        }),
      ],
      ["A", "outer"],
      undefined,
      interrupt.hold,
    );
    try {
      socket.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "run nested effect" }));
      const executor = await bounded(captured.promise);
      const row = activeRow();
      sessionId = row.id;
      handle = app.sessions.get(row.id);
      if (handle === undefined) throw new Error("missing live SDK handle");
      // This continuation was registered outside both ambient execution scopes.
      expect(() => currentExecutor()).toThrow("executor context is required");
      void invoke(executor).then(wrapperSettled.resolve, wrapperSettled.reject);
      await bounded(entered.promise);
      // When: interrupt returns and the parent unwinds while the raw effect is gated.
      // Finish the top-level body first, so it cannot mask missing captured
      // retention; the interrupt lands while the second model call is parked.
      outerDone.resolve();
      await bounded(interrupt.interrupted);
      await bounded(parentSettled.promise);
      expect(await bounded(wrapperSettled.promise)).toMatchObject({ _tag: "InvocationClosed", reason: "settled" });
      expect(existsSync(marker)).toBe(false);
      expect(signal.aborted).toBe(true);
      expect(
        toolResults(row.id)
          .filter((result) => result.callId.startsWith("call-"))
          .map((result) => [result.callId, result.terminal]),
      ).toEqual([
        ["call-A", "executed"],
        ["call-outer", "executed"],
      ]);
      // Then: abort-raced wrapper settlement cannot regress the live effect's fence.
      expectFenceHeld(row.id, "nested-contender", row.fenceOwner);
      // The gated wrapper's grace outcome lands exactly once under the inner
      // intent: the executor's zero-grace row at wave close. Every other count
      // below excludes that one row.
      const innerIntent = tree(row.id).find(
        (action) =>
          action.kind === "tool" &&
          z.object({ phase: z.literal("intent"), callId: z.literal("inner-call") }).safeParse(action.intent.value).success,
      );
      if (innerIntent === undefined) throw new Error("missing inner intent row");
      const innerRows = () => tree(row.id).filter((action) => action.parentId === innerIntent.id);
      const otherRows = () => tree(row.id).filter((action) => action.parentId !== innerIntent.id);
      const beforeActions = otherRows().length;
      let staleBodyStarts = 0;
      const stale = () =>
        executor.run(request, () =>
          Effect.sync(() => {
            staleBodyStarts += 1;
            return null;
          }),
        );
      await expectStaleClosed(stale, () => staleBodyStarts);
      expect(otherRows()).toHaveLength(beforeActions);
      gate.resolve();
      // The raw effect's own completion signal is the join point (close plane gone).
      await bounded(completed.promise);
      expect(readFileSync(marker)).toEqual(Buffer.from(bytes));
      expectFenceHandover(row.id, "nested-contender");
      await expectStaleClosed(stale, () => staleBodyStarts);
      expect(innerRows().map((action) => action.kind)).toEqual(["tool"]);
      z.object({
        phase: z.literal("result"),
        terminal: z.literal("outcome_unknown"),
        reason: z.enum(["raw_body_unsettled_after_grace", "shutdown_grace_exhausted"]),
      }).parse(innerRows()[0]?.effect.value);
      // Raw completion commits nothing else; the close plane's interrupt
      // ingress is gone, so no row lands after the wrapper's grace outcome.
      expect(
        otherRows()
          .slice(beforeActions)
          .map((action) => ({ kind: action.kind, effect: action.effect.value })),
      ).toEqual([]);
      expect(received).toHaveLength(2);
    } finally {
      outerDone.resolve();
      gate.resolve();
      await bounded(completed.promise);
      await bounded(wrapperSettled.promise);
      await cleanup();
      expect(existsSync(directory)).toBe(false);
    }
  }, 15000);
}

for (const door of ["current-cell", "current-wave", "captured-cell", "captured-wave"] as const) {
  for (const rejects of [false, true]) {
    test(`timed ${door} retains the actual definition until ${rejects ? "rejection" : "fulfillment"}`, async () => {
      // Given: the review timeout countercase with a real file effect and actual app stack.
      const captured = Promise.withResolvers<ReturnType<typeof currentExecutor>>();
      const outerGate = Promise.withResolvers<void>();
      const rawGate = Promise.withResolvers<void>();
      const timedOut = Promise.withResolvers<void>();
      const rawDone = Promise.withResolvers<void>();
      const wrapper = Promise.withResolvers<readonly { readonly isError?: boolean }[]>();
      const directory = suite.tempDir("oni-937-timed-effect-");
      const marker = join(directory, "effect.bin");
      const current = door.startsWith("current-");
      let rawStarted = false;
      let sessionId = "";
      const inner = waveTool("inner", async (signal) => {
        signal.addEventListener("abort", () => timedOut.resolve(), { once: true });
        rawStarted = true;
        await rawGate.promise;
        writeFileSync(marker, new Uint8Array([9, 3, 7]));
        rawDone.resolve();
        if (rejects) throw new Error("raw effect rejected");
        return "effect";
      });
      const dispatch = (executor?: ReturnType<typeof currentExecutor>) => {
        // The current door resolves its executor from the enclosing tool scope.
        const dispatcher = dispatcherFixture([inner], {
          executor: executor ?? currentExecutor(),
          timeoutMs: 0,
        });
        const call = { id: "timed-inner", tool: "inner", input: { slot: "inner" } };
        const context = { sessionId, turnId: "timed-turn", signal: new AbortController().signal };
        return door.endsWith("cell")
          ? runEffect(dispatcher.executeCell(call, context)).then((result) => [result])
          : runEffect(dispatcher.executeWave([call], context));
      };
      let handle: AppSessionHandle | undefined;
      const interrupt = interruptDuringSecondModel(() => handle);
      const { app, socket, received, sessionDbPath, cleanup } = await waveApp(
        [
          waveTool("A", async () => "A", true),
          waveTool("outer", async () => {
            captured.resolve(currentExecutor());
            await outerGate.promise;
            if (current) wrapper.resolve(await dispatch());
            return "outer";
          }),
        ],
        ["A", "outer"],
        undefined,
        interrupt.hold,
      );
      try {
        socket.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "run timed nested effect" }));
        const executor = await bounded(captured.promise);
        const row = activeRow();
        sessionId = row.id;
        handle = app.sessions.get(sessionId);
        if (handle === undefined) throw new Error("missing SDK handle");
        if (current) outerGate.resolve();
        else {
          expect(() => currentExecutor()).toThrow("executor context is required");
          void dispatch(executor).then(wrapper.resolve, wrapper.reject);
        }
        // When: the real zero-duration timeout releases the wrapper, not the definition.
        await bounded(timedOut.promise);
        expect((await bounded(wrapper.promise)).map((result) => result.isError)).toEqual([true]);
        outerGate.resolve();
        await bounded(interrupt.interrupted);
        expect(existsSync(marker)).toBe(false);
        expect(toolResults(sessionId).map((result) => [result.callId, result.terminal])).toEqual([
          ["timed-inner", "outcome_unknown"],
          ["call-A", "executed"],
          ["call-outer", "executed"],
        ]);
        // Then: neither timeout nor SDK interruption regresses the live effect's fence.
        expectFenceHeld(sessionId, "timed-contender", row.fenceOwner);
        const beforeActions = tree(sessionId).length;
        const db = new Database(sessionDbPath(sessionId), { readonly: true });
        try {
          expect(
            db
              .query<{ count: number }, [string]>(
                "SELECT count(*) AS count FROM action WHERE session_id=?",
              )
              .get(sessionId)?.count,
          ).toBe(beforeActions);
        } finally {
          db.close();
        }
        let staleStarts = 0;
        const stale = () =>
          executor.run({ kind: "tool", op: "stale", intent: {}, effect: {} }, () =>
            Effect.sync(() => {
              staleStarts += 1;
              return null;
            }),
          );
        await expectStaleClosed(stale, () => staleStarts);
        expect(tree(sessionId)).toHaveLength(beforeActions);
        rawGate.resolve();
        await bounded(rawDone.promise);
        expect(readFileSync(marker)).toEqual(Buffer.from([9, 3, 7]));
        expectFenceHandover(sessionId, "timed-contender");
        await expectStaleClosed(stale, () => staleStarts);
        // The close plane's interrupt ingress is gone: raw completion after
        // the fence handover commits nothing.
        expect(
          tree(sessionId)
            .slice(beforeActions)
            .map((action) => ({
              kind: action.kind,
              effect: action.effect.value,
            })),
        ).toEqual([]);
        expect(received).toHaveLength(2);
      } finally {
        outerGate.resolve();
        rawGate.resolve();
        if (rawStarted) await bounded(rawDone.promise);
        await cleanup();
        expect(existsSync(directory)).toBe(false);
      }
    }, 15000);
  }
}

test("approval-time prompts retain durable identities and enter the next model separately in order", async () => {
  // Given: a real model invocation suspended on its original B approval.
  const { app, socket, received } = await waveApp([waveTool("B", async () => "B")], ["B"]);
  requireBApproval();
  const waiting = nextApproval(app);
  const response = nextResidentTurn(plane(), 5000);
  socket.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "initial" }));
  const { handle, request } = await bounded(waiting);
  // When: two durable prompts arrive while the wave is held, before any next
  // boundary - committed under the live activation's borrowed authority.
  await commitPrompt(plane(), handle.id, "held-prompt-first", "first continuation");
  await commitPrompt(plane(), handle.id, "held-prompt-second", "second continuation");
  // W5.2: the delivery is the prompt-action chain; pending = not yet delivered.
  const prompts = tree(handle.id).filter(
    (action) =>
      action.kind === "prompt" &&
      z.object({ deliveryKind: z.literal("prompt") }).safeParse(action.effect.value).success,
  );
  const pendingIds = plane()
    .openKernel(handle.id)
    .pendingMessages(handle.id)
    .filter((row) => row.kind === "prompt")
    .map((row) => row.id);
  expect(prompts.map((row) => (pendingIds.includes(row.id) ? "pending" : "consumed"))).toEqual([
    "consumed",
    "pending",
    "pending",
  ]);
  expect(received).toHaveLength(1);
  await runEffect(
    handle.approvals.answer({ request, decision: "approve", credential: "wave-token" }),
  );
  await bounded(response);
  // #1253 boundary rule: prompts default `delivery: followUp` and are consumed
  // only at turn end - never mid-turn at a tool boundary - so the two held
  // prompts enter a separate follow-up turn (the follow-up terminal below
  // cannot precede this subscription: it requires another provider roundtrip).
  const followUp = nextResidentTurn(plane(), 5000);
  await bounded(followUp, "follow-up turn");
  // Then: canonical next-model admission names the original ordered prompt IDs.
  // #1252: attempt rows share the llm kind and spread the invocation fields;
  // only the logical intent (no attempt ordinal) names the admission.
  const modelIntent = z.object({
    phase: z.literal("intent"),
    op: z.literal("chat"),
    attempt: z.number().optional(),
    value: z.object({ messageIds: z.array(z.string()) }),
  });
  const inputs = tree(handle.id)
    .filter((action) => action.kind === "llm")
    .flatMap((action) => {
      const parsed = modelIntent.safeParse(action.intent.value);
      return parsed.success && parsed.data.attempt === undefined
        ? [parsed.data.value.messageIds]
        : [];
    });
  const promptIds = prompts.map((row) => row.id);
  const [initialId, firstId, secondId] = promptIds;
  if (initialId === undefined || firstId === undefined || secondId === undefined)
    throw new Error("missing prompt IDs");
  expect(inputs[0]).toEqual([initialId]);
  // The held prompts never merge into the suspended turn's model steps...
  for (const step of inputs.slice(0, -1)) {
    expect(step.filter((id) => id === firstId || id === secondId)).toEqual([]);
  }
  // ...and the follow-up turn's model names every durable prompt id, with the
  // two held prompts as separate ordered entries after the initial one.
  const last = inputs.at(-1);
  expect(last?.filter((id) => promptIds.includes(id))).toEqual(promptIds);
  const delivered = tree(handle.id).flatMap((action) => {
    const delivery = Core.SessionHandleStore.delivery(action);
    return delivery?.kind === "prompt" ? [delivery] : [];
  });
  const initialTurn = delivered[0]?.turnId;
  expect(delivered.slice(1).map((delivery) => [delivery.deliveryId, delivery.boundary])).toEqual([
    [firstId, "before_llm"],
    [secondId, "before_llm"],
  ]);
  expect(delivered.slice(1).every((delivery) => delivery.turnId !== initialTurn)).toBe(true);
  // Nothing is dropped: no pending prompt rows remain after the follow-up turn.
  expect(
    plane()
      .openKernel(handle.id)
      .pendingMessages(handle.id)
      .filter((row) => row.kind === "prompt"),
  ).toEqual([]);
  expect(received).toHaveLength(3);
});

test("an exact approval deadline refuses only B and cannot grant late authority", async () => {
  let now = 100;
  const started: string[] = [];
  const { app, socket } = await waveApp(trackedWaveTools(started), ["A", "B", "C"], {
    clock: () => now,
    approvalTimeoutMs: 1,
  });
  requireBApproval();
  const waiting = nextApproval(app);
  const response = nextResidentTurn(plane(), 5000);
  socket.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "deadline wave" }));
  const { handle, request } = await bounded(waiting);
  try {
    expect(request.expiresAt).toBe(101);
    expect(started).toEqual([]);
    // W5.2: the alarm child is gone and the durable DeliverAt Deadline
    // serializes behind the live turn's own entity RPC; a mid-turn expiry
    // rides the facade's borrowed-authority request timeout, which notifies
    // the turn's live approval gate.
    const open = plane()
      .openKernel(handle.id)
      .requestRows(handle.id)
      .find((row) => row.state === "open");
    if (open === undefined) throw new Error("missing open approval request");
    now = 101;
    await runEffect(handle.requests.timeout(open.requestId, now));
    await response;
    expect(started).toEqual(["A", "C"]);
    expect(toolResults(handle.id).map((result) => [result.callId, result.terminal])).toEqual([
      ["call-A", "executed"],
      ["call-B", "blocked_pre"],
      ["call-C", "executed"],
    ]);
    expect(
      await runEffect(
        Effect.flip(
          handle.approvals.answer({ request, decision: "approve", credential: "wave-token" }),
        ),
      ),
    ).toMatchObject({ code: "stale_approval" });
  } finally {
    if (handle.approvals.pending().length > 0) await runEffect(handle.interrupt());
  }
});

test("a durable after-model delivery interrupt drains before tools without an eager local signal", async () => {
  let bodies = 0;
  const { socket, received } = await waveApp(
    [
      waveTool("A", async () => {
        bodies += 1;
        return "A";
      }),
    ],
    ["A"],
  );
  let queued = false;
  suite.defer(
    Bus.subscribe(LlmCall.Events.Completed, (event) => {
      if (queued) return;
      queued = true;
      // Cross-process control arrives through the public durable delivery, not the local AbortController.
      void commitInterrupt(plane(), event.sessionId, "after-model-interrupt");
    }),
  );
  const response = nextTerminal();
  socket.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "interrupt at the drain" }));
  await response;
  expect(bodies).toBe(0);
  expect(received).toHaveLength(1);
  expect(interruptDeliveries(plane(), activeRow().id)).toMatchObject([
    { deliveryId: "after-model-interrupt", boundary: "after_llm" },
  ]);
});

test("an interrupt after wave results drains before another provider step", async () => {
  const { socket, received } = await waveApp([waveTool("A", async () => "A")], ["A"]);
  suite.defer(
    Bus.subscribe(Tool.Events.Completed, (event) => {
      void commitInterrupt(plane(), event.sessionId, "after-wave-interrupt");
    }),
  );
  const response = nextTerminal();
  socket.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "stop after A" }));
  await response;
  expect(received).toHaveLength(1);
  expect(toolResults(activeRow().id)).toMatchObject([{ callId: "call-A", terminal: "executed" }]);
  // PubSub drains run before the kernel reaches its after_tools boundary
  // check (#1249 removed the manual bus's microtask hop), so the interrupt is
  // durable by then and drains there — still before another provider step.
  expect(interruptDeliveries(plane(), activeRow().id)).toMatchObject([
    { deliveryId: "after-wave-interrupt", boundary: "after_tools" },
  ]);
});
