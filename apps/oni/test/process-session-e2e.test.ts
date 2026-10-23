import { boundToolHolder, bundleTools, testToolPorts } from "./helpers/tool-ports";
import { sessionTree } from "../../../packages/agent/test/store/helpers/session-tree";
import { expect, mock, spyOn, test } from "bun:test";
import { PassThrough, Readable } from "node:stream";
import { acquireAppResource, gatewayRuntime } from "../src/gateway";
import { Effect } from "effect";
import { ownerStart } from "./helpers/owner-start";
import { Core } from "@oni/agent";
const projectTools = Core.projectTools;
import { Bus } from "./helpers/bus";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { sessionFilePath } from "../../../packages/agent/src/core/session/host";
import { receivedMessages } from "./helpers/received-messages";
import { localDelivery, planeOf } from "./helpers/ledger";
import { PROCESS_SESSION_NO_REQUEST_EXIT, type ProcessReplies, runProcessEntry, serveProcessSession, type ProcessSessionRequest } from "../src/process-entry";
import { bounded } from "./helpers/protected-dispatch";
import { runEffect } from "./helpers/effect";
import { z } from "zod";
import { messageFixture } from "./helpers/message-fixture";
import { Delivery, Gateway, type LedgerAction, SessionTransition } from "@oni/protocol";
import { assistantMessage, requestToolStep } from "./helpers/assistant-message";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { messageStart, messageEnd, sseResponse } from "./helpers/anthropic-sse";

const suite = residentSuite();

type ProcessPlane = {
  catalogPath: string;
  sessionsDir: string;
  runtime: ReturnType<typeof gatewayRuntime>;
};

/**
 * The parent-side reply door a served child forwards its deliveries to
 * (#1346): the child maps each commit to its `Deliver` payload and never
 * writes another chain. The fixture parent is NOT an entity-owned session
 * (its sender turn runs under the fixture's local runner, so no activation
 * could adopt its fence); these drain tests claim the child's forwarding,
 * not admission, and land the row locally. Admission through the parent's
 * entity with the real frame payload is proven by the `startOni` test
 * below, where the parent is a booted app.
 */
function parentReplies(fixture: ReturnType<typeof messageFixture>): ProcessReplies {
  return {
    deliver: ({ commit }) => runEffect(localDelivery(fixture.plane, "process-parent", () => 100)(commit)),
  };
}

/** Per-fixture catalog/sessions paths plus a gateway runtime rooted in the fixture directory. */
function processPlane(fixture: { directory: string }): ProcessPlane {
  const catalogPath = join(fixture.directory, "catalog.sqlite");
  const sessionsDir = join(fixture.directory, "sessions");
  return {
    catalogPath,
    sessionsDir,
    runtime: gatewayRuntime({ composed: boundToolHolder(), observations: Bus, catalogPath, sessionsDir, clusterStoragePath: ":memory:" }),
  };
}

/** Commission a process-runner child from the fixture session and return its row. */
async function commissionChild(
  fixture: ReturnType<typeof messageFixture>,
  message: { content: string; replyTo: string; deadline?: number },
) {
  expect(
    (
      await fixture.send({
        to: { kind: "new_session", role: "child", runner: "process", parent: "me" },
        type: "message",
        ...message,
      })
    ).isError,
  ).not.toBe(true);
  const child = fixture.plane.listSessions().find((row) => row.role === "child");
  if (child === undefined) throw new Error("missing commissioned process session");
  return child;
}

/** A ProcessSessionRequest against the fake fixture model or a local anthropic SSE provider. */
function processRequest(
  sessionId: string,
  plane: ProcessPlane,
  provider?: { port: number | undefined },
): ProcessSessionRequest {
  const base = {
    sessionId,
    catalogPath: plane.catalogPath,
    sessionsDir: plane.sessionsDir,
    entityIdleMs: 50,
  };
  return provider === undefined
    ? { ...base, model: { provider: "fake", id: "fixture" }, apiKey: "fixture-key" }
    : {
        ...base,
        model: { provider: "anthropic", id: "claude-opus-4-5" },
        apiKey: "process-key",
        transport: { baseUrl: `http://127.0.0.1:${provider.port}/v1` },
      };
}

/** Common teardown: dispose the runtime, stop the provider, reset the bus, drop fixture files. */
async function releaseProcess(
  fixture: { directory: string },
  runtime: ReturnType<typeof gatewayRuntime>,
  provider?: ReturnType<typeof Bun.serve>,
) {
  await runtime.dispose();
  await provider?.stop(true);
  Bus.reset();
  rmSync(fixture.directory, { recursive: true, force: true });
}
function response(target?: string): Response {
  const block =
    target === undefined
      ? { type: "text", text: "" }
      : { type: "tool_use", id: "process-tool", name: "send_message", input: {} };
  const delta =
    target === undefined
      ? { type: "text_delta", text: "PROCESS_SENTINEL" }
      : {
          type: "input_json_delta",
          partial_json: JSON.stringify({
            to: { kind: "session", id: target },
            message: "PROCESS_TOOL_SENTINEL",
          }),
        };
  const frames = [
    messageStart(crypto.randomUUID(), "claude-opus-4-5", 4),
    { type: "content_block_start", index: 0, content_block: block },
    { type: "content_block_delta", index: 0, delta },
    { type: "content_block_stop", index: 0 },
    ...messageEnd(target === undefined ? "end_turn" : "tool_use", 2),
  ];
  return sseResponse(frames);
}

function toolResponse(input: object): Response {
  const frames = [
    messageStart(crypto.randomUUID(), "claude-opus-4-5", 4),
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "process-focused-tool",
        name: "send_message",
        input: {},
      },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    },
    { type: "content_block_stop", index: 0 },
    ...messageEnd("tool_use", 2),
  ];
  return sseResponse(frames);
}

test("process entry exits on empty stdin and closes its reply channel", async () => {
  const stdin = Readable.from([]);
  const pause = spyOn(stdin, "pause");
  const log = mock((line: string) => line);
  const exited = new Error("process exited");
  let pausesAtExit = 0;
  const exit = mock((code: number): never => {
    expect(code).toBe(PROCESS_SESSION_NO_REQUEST_EXIT);
    pausesAtExit = pause.mock.calls.length;
    throw exited;
  });
  try {
    await expect(bounded(runProcessEntry({ stdin, log, exit }))).rejects.toBe(exited);
    expect(exit).toHaveBeenCalledWith(78);
    expect(log).not.toHaveBeenCalled();
    expect(pause).toHaveBeenCalledTimes(pausesAtExit + 1);
    expect(stdin.listenerCount("data")).toBe(0);
  } finally {
    pause.mockRestore();
    stdin.destroy();
  }
});

test("process entry logs committed sessions and disposes its runtime", async () => {
  const fixture = messageFixture(
    "resident",
    undefined,
    projectTools(bundleTools(testToolPorts).filter((tool: import("@oni/protocol").AnyToolDefinition) => tool.visibility.model.includes("child") || tool.visibility.cell.includes("child"))).session,
  );
  const stdin = new PassThrough();
  let requests = 0;
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      requests += 1;
      return response(requests === 1 ? "sender" : undefined);
    },
  });
  const plane = processPlane(fixture);
  const { catalogPath, sessionsDir, runtime } = plane;
  const dispose = spyOn(runtime, "dispose");
  const createRuntime = mock((options: Parameters<typeof gatewayRuntime>[0]) => {
    expect(options).toMatchObject({ catalogPath, sessionsDir, clusterStoragePath: ":memory:" });
    // #1308: the child rebuilds the composition root; its generation lists the shipped bundles.
    // #1309: `send-message` requires the approval-policy seam, so compose orders
    // the provider ahead of it — the shipped list is dependency-sorted, not literal.
    expect(options.composed?.current().generation.bundles).toEqual([
      "file",
      "bash",
      "eval",
      "monitor",
      "child-activity",
      "cron",
      "hooks-json",
      "delegation-policy",
      "approval-policy",
      "send-message",
      "provision",
      "completion",
      "compaction-summarizer",
      "compaction-strategy",
    ]);
    return runtime;
  });
  const answerRequested = Promise.withResolvers<SessionTransition.Answer>();
  const answerFrame = z.object({ kind: z.literal("request_answer"), answer: SessionTransition.Answer });
  // #1346: the child's deliveries arrive as `request_deliver` frames; the
  // parent lands each row and acks with the pending row receipt.
  const deliverFrame = z.object({
    kind: z.literal("request_deliver"),
    commit: Delivery.Commit,
    deliver: z.object({ kind: z.string(), body: z.string(), source: z.string(), idempotencyKey: z.string() }),
  });
  const delivered: { readonly sessionId: string; readonly kind: string; readonly idempotencyKey: string }[] = [];
  const parent = parentReplies(fixture);
  const log = mock((line: string) => {
    const parsed = JSON.parse(line);
    const frame = answerFrame.safeParse(parsed);
    if (frame.success) answerRequested.resolve(frame.data.answer);
    const delivery = deliverFrame.safeParse(parsed);
    if (!delivery.success) return;
    const { commit, deliver } = delivery.data;
    delivered.push({ sessionId: commit.sessionId, kind: deliver.kind, idempotencyKey: deliver.idempotencyKey });
    // The frame carries the child's real mapped payload (#1346 M6): the
    // destination's `Deliver` body, source and idempotency key, not a stub.
    expect(deliver).toMatchObject({ kind: commit.kind, source: JSON.stringify(commit.origin.value), idempotencyKey: commit.id });
    expect(JSON.parse(deliver.body)).toMatchObject({ content: commit.content });
    void parent.deliver({ commit, deliver }).then(
      (row) => stdin.write(`${JSON.stringify({ ok: true, inputId: commit.id, row })}\n`),
      (error: Error) => stdin.write(`${JSON.stringify({ ok: false, inputId: commit.id, error: error.message })}\n`),
    );
  });
  const exit = mock((code: number): never => {
    throw new Error(`unexpected process exit: ${code}`);
  });
  try {
    const child = await commissionChild(fixture, {
      content: "work",
      replyTo: "process-entry-original",
    });
    const request = processRequest(child.id, plane, provider);
    const running = runProcessEntry({ stdin, log, exit, gatewayRuntime: createRuntime });
    stdin.write(`${JSON.stringify(request)}\n`);
    const answer = await bounded(answerRequested.promise);
    const resolution = await runEffect(fixture.requests.answer(answer));
    expect(resolution).toBe("resolved");
    stdin.write(`${JSON.stringify({ ok: true, inputId: answer.inputId, resolution })}\n`);
    await bounded(running);
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(requests).toBe(2);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ sessionIds: ["sender"] }));
    // The tool send crossed the parent door with the child's mapped payload;
    // the settlement rides the answer frame.
    expect(delivered).toEqual([{ sessionId: "sender", kind: "prompt", idempotencyKey: expect.any(String) }]);
    expect(exit).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(stdin.isPaused()).toBe(true);
    expect(stdin.listenerCount("data")).toBe(0);
    // #1311: the settlement is the bounded DelegationResult envelope, not the raw reply.
    const settled = receivedMessages(fixture.plane, "sender").filter(
      (row) => SessionTransition.OutboundMessage.safeParse(row.origin.value).success,
    );
    expect(settled).toHaveLength(1);
    expect(Gateway.DelegationResult.parse(JSON.parse(settled[0]?.content ?? ""))).toMatchObject({
      status: "completed",
      preview: "PROCESS_SENTINEL",
      pointer: { session: child.id },
    });
    expect(sessionTree("sender", fixture.plane.sessionStore("sender").actions).some((action) => action.id === delivered[0]?.idempotencyKey)).toBe(true);
  } finally {
    dispose.mockRestore();
    stdin.destroy();
    await releaseProcess(fixture, runtime, provider);
  }
});

test("process session drain stops without invoking a model when the session is idle", async () => {
  const fixture = messageFixture("resident");
  const plane = processPlane(fixture);
  const { runtime } = plane;
  try {
    await acquireAppResource(
      runtime,
      serveProcessSession(
        processRequest(fixture.sessionId, plane),
        () => {
          throw new Error("idle drain must not commit a message");
        },
        parentReplies(fixture),
        runtime,
      ),
    );
    expect(fixture.plane.openKernel(fixture.sessionId).pendingMessages(fixture.sessionId)).toEqual(
      [],
    );
  } finally {
    await releaseProcess(fixture, runtime);
  }
});

test("process session drain consumes resume backlog through the entity fold", async () => {
  const fixture = messageFixture("resident");
  const plane = processPlane(fixture);
  const { runtime } = plane;
  try {
    const kernel = fixture.plane.openKernel(fixture.sessionId);
    const initial = kernel.row(fixture.sessionId);
    const owner = "resume-fixture";
    const adopted = await runEffect(
      kernel.adoptFence({
        sessionId: fixture.sessionId,
        owner,
        fence: initial.fence + 1,
      }),
    );
    const row = kernel.row(fixture.sessionId);
    const resume: LedgerAction.Append = {
      id: "resume-pending",
      parentId: kernel.latestAction(fixture.sessionId)?.id ?? null,
      sessionId: fixture.sessionId,
      kind: "prompt",
      intent: { encodingVersion: 1, value: { kind: "sdk" } },
      effect: {
        encodingVersion: 1,
        value: { deliveryKind: "resume", content: "continue" },
      },
      irreversible: true,
      ts: 100,
    };
    await runEffect(
      kernel.commit({
        sessionId: fixture.sessionId,
        owner,
        fence: adopted.fence,
        now: 100,
        expectedRevision: row.revision,
        actions: [resume],
        state: "idle",
      }),
    );

    await acquireAppResource(
      runtime,
      serveProcessSession(
        processRequest(fixture.sessionId, plane),
        () => {
          throw new Error("an entity consume fold must not ring the delivery doorbell");
        },
        parentReplies(fixture),
        runtime,
      ),
    );

    // #1308: the child routes through the session entity, whose backlog drain
    // owns the consume fold — the resume is folded durably, not deferred.
    expect(kernel.pendingMessages(fixture.sessionId)).toEqual([]);
    expect(kernel.actionById("resume-pending:delivery")).toBeDefined();
  } finally {
    await releaseProcess(fixture, runtime);
  }
});

test("process session drain recovers an open turn through the default admission path", async () => {
  const fixture = messageFixture("resident");
  const plane = processPlane(fixture);
  const { runtime } = plane;
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => response(),
  });
  try {
    const kernel = fixture.plane.openKernel(fixture.sessionId);
    const generation = kernel.latestGenerationFor(fixture.sessionId);
    const row = kernel.row(fixture.sessionId);
    const owner = "recover-fixture";
    const adopted = await runEffect(
      kernel.adoptFence({
        sessionId: fixture.sessionId,
        owner,
        fence: row.fence + 1,
      }),
    );
    const current = kernel.row(fixture.sessionId);
    const turnId = "process-open-turn";
    await runEffect(
      kernel.commit({
        sessionId: fixture.sessionId,
        owner,
        fence: adopted.fence,
        now: 100,
        expectedRevision: current.revision,
        actions: [
          {
            id: turnId,
            parentId: kernel.latestAction(fixture.sessionId)?.id ?? null,
            sessionId: fixture.sessionId,
            kind: "turn",
            intent: {
              encodingVersion: 1,
              value: {
                phase: "intent",
                resultId: `${turnId}:result`,
                deliveryIds: [],
                resumeCount: 0,
                boundaryActionId: null,
                toolsGeneration: generation.generation,
                toolsHash: generation.toolsHash,
                systemHash: generation.systemHash,
                policyGeneration: generation.policyGeneration,
              },
            },
            effect: { encodingVersion: 1, value: { phase: "pending" } },
            ts: 100,
            irreversible: true,
          },
        ],
        state: "running",
      }),
    );

    await acquireAppResource(
      runtime,
      serveProcessSession(
        processRequest(fixture.sessionId, plane, provider),
        () => {
          throw new Error("recovery must not commit a child message");
        },
        parentReplies(fixture),
        runtime,
      ),
    );

    expect(kernel.latestTurnTerminal(fixture.sessionId)?.action.id).toBe(`${turnId}:result`);
    expect(kernel.row(fixture.sessionId).state).toBe("idle");
  } finally {
    await releaseProcess(fixture, runtime, provider);
  }
});

test.each([
  false,
  true,
])("process-session entry preserves deadline and parent with tool send %s", async (toolSend) => {
  const fixture = messageFixture(
    "resident",
    undefined,
    toolSend ? projectTools(bundleTools(testToolPorts).filter((tool: import("@oni/protocol").AnyToolDefinition) => tool.visibility.model.includes("child") || tool.visibility.cell.includes("child"))).session : [],
  );
  let requests = 0;
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      requests += 1;
      return response(toolSend && requests === 1 ? "sender" : undefined);
    },
  });
  const deadline = Date.now() + 60_000;
  const plane = processPlane(fixture);
  const { runtime } = plane;
  try {
    const child = await commissionChild(fixture, {
      content: "work",
      replyTo: "process-original",
      ...(toolSend ? {} : { deadline }),
    });
    const notified: string[] = [];
    await acquireAppResource(runtime, serveProcessSession(
      processRequest(child.id, plane, provider),
      (ids) => notified.push(...ids),
      parentReplies(fixture),
      runtime,
    ));
    expect(requests).toBe(toolSend ? 2 : 1);
    expect(notified).toContain("sender");
    expect(
      receivedMessages(fixture.plane, "sender").filter(
        (row) => row.content === "PROCESS_TOOL_SENTINEL",
      ),
    ).toHaveLength(toolSend ? 1 : 0);
    const received = receivedMessages(fixture.plane, "sender").filter(
      (row) => SessionTransition.OutboundMessage.safeParse(row.origin.value).success,
    );
    expect(received).toHaveLength(1);
    // #1311: the settlement is the bounded DelegationResult envelope.
    expect(received[0]?.origin.value).toMatchObject({
      replyTo: "process-original",
      terminal: "completed",
      delivery: "followUp",
    });
    expect(Gateway.DelegationResult.parse(JSON.parse(received[0]?.content ?? ""))).toMatchObject({
      status: "completed",
      preview: "PROCESS_SENTINEL",
      pointer: { session: child.id },
    });
    expect(
      sessionTree(child.id, fixture.plane.sessionStore(child.id).actions).filter(
        (action) => action.kind === "alarm",
      ),
    ).toEqual([]);
    const senderKernel = fixture.plane.openKernel("sender");
    expect(senderKernel.requestRows("sender")[0]?.state).toBe("resolved");
    // W5.2: no alarm rows exist; the resolved request carries no live deadline.
    expect(
      senderKernel
        .requestRows("sender")
        .filter((row) => row.state === "open" && row.deadline !== null && row.deadline <= deadline),
    ).toEqual([]);
  } finally {
    await releaseProcess(fixture, runtime, provider);
  }
});

test.each([
  {
    name: "reads policy generation for a new-session attempt",
    input: {
      to: { kind: "new_session", role: "child", runner: "resident", parent: "me" },
      message: "PROCESS_NEW_SESSION",
    },
    childCount: 1,
    senderMessages: 0,
    failTarget: false,
    requestCount: 2,
  },
  {
    name: "refuses a typed target commit failure",
    input: {
      to: { kind: "session", id: "sender" },
      message: "PROCESS_REFUSED_TARGET",
    },
    childCount: 1,
    senderMessages: 0,
    failTarget: true,
    requestCount: 2,
  },
])("process-session focused message path $name", async ({
  input,
  childCount,
  senderMessages,
  failTarget,
  requestCount,
}) => {
  const tools = projectTools(
    bundleTools(testToolPorts).filter(
      (tool: import("@oni/protocol").AnyToolDefinition) =>
        tool.visibility.model.includes("child") || tool.visibility.cell.includes("child"),
    ),
  ).session;
  const fixture = messageFixture("resident", undefined, tools);
  let requests = 0;
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      requests += 1;
      return requests === 1 ? toolResponse(input) : response();
    },
  });
  const plane = processPlane(fixture);
  const { runtime } = plane;
  try {
    const child = await commissionChild(fixture, {
      content: "focused process path",
      replyTo: "focused-process",
    });
    if (failTarget) {
      const database = new Database(sessionFilePath(plane.sessionsDir, "sender"));
      database.exec(
        "CREATE TRIGGER refuse_process_message BEFORE INSERT ON action BEGIN SELECT RAISE(ABORT, 'forced process refusal'); END",
      );
      database.close();
    }
    const serving = acquireAppResource(
      runtime,
      serveProcessSession(
        processRequest(child.id, plane, provider),
        () => undefined,
        parentReplies(fixture),
        runtime,
      ),
    );
    if (failTarget) {
      await expect(serving).rejects.toMatchObject({
        _tag: "AgentFailure",
        operation: "message.outbound",
      });
    } else await serving;

    expect(requests).toBe(requestCount);
    expect(fixture.plane.listSessions().filter((row) => row.role === "child")).toHaveLength(
      childCount,
    );
    expect(
      receivedMessages(fixture.plane, "sender").filter(
        (message) => message.content === "PROCESS_REFUSED_TARGET",
      ),
    ).toHaveLength(senderMessages);
  } finally {
    await releaseProcess(fixture, runtime, provider);
  }
});

test("startOni runs a process session and drains its atomic parent reply without ACK settlement", async () => {
  const settlementDrained = Promise.withResolvers<void>();
  const timer = setTimeout(
    () => settlementDrained.reject(new Error("process reply was not drained")),
    // Bounded, not timed: the child kernel boots ~10x slower under coverage instrumentation.
    60_000,
  );
  const received = settlementDrained.promise.then(
    () => ({ ok: true }),
    (error: Error) => ({ ok: false, error }),
  );
  suite.defer(() => clearTimeout(timer));
  suite.defer(
    Bus.subscribe(Gateway.MessageObserved, (event) => {
      if (event.kind === "message.drained" && event.messageId.endsWith(":reply"))
        settlementDrained.resolve();
    }),
  );
  let requests = 0;
  let parentSessionId = "";
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      requests += 1;
      return response(requests === 1 ? parentSessionId : undefined);
    },
  });
  suite.defer(() => provider.stop(true));
  let commissioned = false;
  const app = await suite.boot({
    config: suite.config("process-message-", {
      wsToken: "token",
      model: {
        provider: "anthropic",
        id: "claude-opus-4-5",
        apiKey: "process-key",
        baseUrl: `http://127.0.0.1:${provider.port}/v1`,
      },
    }),
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        parentSessionId = input.trace.sessionId;
        if (!commissioned) {
          const output = requestToolStep(input, sink, {
            id: "process-send",
            tool: "send_message",
            input: {
              to: { kind: "new_session", role: "child", runner: "process", parent: "me" },
              message: "run process",
              reply_to: "process-binding",
              // #1258: delegation policy refuses child creation without a spend cap.
              spend_cap: 1,
            },
          });
          if (output === undefined) return { type: "stop" };
          expect(output.isError).not.toBe(true);
          commissioned = true;
        }
        sink.onMessage(assistantMessage(input, { text: "PARENT_SENTINEL" }));
        return { type: "stop" as const };
      }),
    },
  });
  await ownerStart(app, "initial-process");
  expect(await received).toEqual({ ok: true });
  const plane = await planeOf(app.runtime);
  const child = plane.listSessions().find((row) => row.role === "child");
  if (child?.parentId === undefined || child.parentId === null)
    throw new Error("missing process child");
  const replies = receivedMessages(plane, child.parentId).filter((row) =>
    row.id.endsWith(":reply"),
  );
  expect(requests).toBe(2);
  expect(
    receivedMessages(plane, child.parentId).some(
      (row) => row.content === "PROCESS_TOOL_SENTINEL",
    ),
  ).toBe(true);
  expect(replies).toHaveLength(1);
  expect(Gateway.DelegationResult.parse(JSON.parse(replies[0]?.content ?? ""))).toMatchObject({
    status: "completed",
    preview: "PROCESS_SENTINEL",
    pointer: { session: child.id },
  });
  expect(replies[0]?.origin.value).toMatchObject({
    sourceSessionId: child.id,
    replyTo: "process-binding",
    terminal: "completed",
    delivery: "followUp",
  });
  // Writer identity (#1346 M6): both child deliveries (the tool send and the
  // settlement reply) crossed the parent's `request_deliver` door into the
  // parent's Session entity, whose activation holds the fence under this
  // app's writer — the row's fence owner is `oni:<pid>`, never the
  // child's `process:<pid>` nor a test-adopted owner, and the chain is
  // the entity's single-writer sequence (strictly increasing ordinals).
  const parentRow = plane.openKernel(child.parentId).row(child.parentId);
  expect(parentRow).toMatchObject({ fenceOwner: `oni:${process.pid}` });
  const parentChain = sessionTree(child.parentId, plane.sessionStore(child.parentId).actions);
  const chainIds = new Set(parentChain.filter((action) => action.sessionId === child.parentId).map((action) => action.id));
  const landed = receivedMessages(plane, child.parentId).filter(
    (row) => row.id === replies[0]?.id || (row.content === "PROCESS_TOOL_SENTINEL" && !row.id.endsWith(":delivery")),
  );
  expect(landed).toHaveLength(2);
  expect(landed.every((row) => chainIds.has(row.id))).toBe(true);
  expect(parentChain.map((action) => action.ordinal)).toEqual([...parentChain.map((action) => action.ordinal)].sort((a, b) => a - b));
}, 60_000);
