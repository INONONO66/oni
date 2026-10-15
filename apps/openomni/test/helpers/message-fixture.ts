import { APPROVAL_POLICY } from "../../src/bundles/approval-policy/index";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bundle, Core, Testing } from "@openomni/agent";
const createDispatcher = Bundle.createDispatcher;
const createExecutor = Core.createExecutor;
const createSessionRequests = Core.createSessionRequests;
const eraseTool = Core.eraseTool;
const session = Testing.session;
type SessionRuntime = Core.SessionRuntime;
import { Bus } from "./bus";
import { createAppLedger } from "./ledger";
import { Gateway, type LedgerSession, Outbound, type Tool } from "@openomni/protocol";
import { channelRequests, channelStoreSource, createResidentGateway, type OutboundMessaging } from "../../src/gateway";
import { createChannelStores, decodeChannelFailure } from "@openomni/channels";
import {
  messageMaterialization,
  prepareMessage,
} from "../../src/composition/message-session";
import { localDelivery } from "./ledger";
import { allowConfigure, generationServices } from "./generation-services";
const ToolCatalog = Core.ToolCatalog;
import { seedKernelPolicyRows } from "../../src/composition/policy";
import { createSendMessageTool } from "../../src/bundles/messaging/send-message/index";
import { dispatchOutboundMessage } from "../../src/composition/terminal-message";
import type { z } from "zod";
import { Effect } from "effect";
import { acquireSyncEffect, runEffect, runSyncEffect } from "./effect";
import { testIds } from "./test-entropy";

/** The model-facing vocabulary is read off the sealed tool, not re-exported for tests. */
type SendMessageInput = z.output<ReturnType<typeof createSendMessageTool>["input"]>;

export function messageFixture(
  role: LedgerSession.Role = "resident",
  messaging?: OutboundMessaging,
  tools: Parameters<ReturnType<typeof messageMaterialization>>[0]["tools"] = [],
) {
  const directory = mkdtempSync(join(tmpdir(), "message-policy-"));
  const catalogPath = join(directory, "catalog.sqlite");
  const sessionsDir = join(directory, "sessions");
  const plane = createAppLedger({ now: () => 100, catalogPath, sessionsDir, observationSink: Bus });
  seedKernelPolicyRows(plane.catalog.policies);
  const sessionId = "sender";
  const runtime: SessionRuntime = {
    approvalPolicy: APPROVAL_POLICY,
    authorizeConfigure: allowConfigure,
    openKernel: plane.openKernel,
    listSessions: plane.listSessions,
    dispatchOutbound: dispatchOutboundMessage(
      (...args) => gateway.ingest(...args),
      plane.openKernel,
    ),
  };
  const context = acquireSyncEffect(generationServices({ clock: () => 100, plane }));
  const requests = runSyncEffect(createSessionRequests(runtime).pipe(Effect.provide(context)));
  const gateway = runSyncEffect(createResidentGateway({
    now: () => 100,
    id: testIds("message-fixture"),
    requests: channelRequests(requests),
    stores: createChannelStores(channelStoreSource(plane, () => 100)),
    delivery: { commit: (input) => localDelivery(plane, "message-fixture", () => 100)(input).pipe(Effect.mapError(decodeChannelFailure("delivery.commit"))) },
    prepare: prepareMessage(plane, (id, parentId, childRole, runner) =>
      messageMaterialization(() => plane.openKernel(id).currentPolicyGeneration(), testIds("materialize"))({
        id,
        parentId,
        role: childRole,
        runner,
        tools,
        preset: "",
        at: 100,
      })),
  }, messaging).pipe(Effect.provide(context)));
  let result: Tool.Result | undefined;
  // Optional mid-turn arrival: committed inside the running turn (riding the
  // live owner+fence) so it is still pending when the send is admitted —
  // boundary drains consume everything committed before the turn opened.
  let beforeDispatch: Effect.Effect<void> | undefined;
  const handle = acquireSyncEffect(session(
    {
      id: sessionId,
      role,
      runner: (input) => Effect.gen(function* () {
        if (beforeDispatch !== undefined) {
          const hook = beforeDispatch;
          beforeDispatch = undefined;
          yield* hook;
        }
        const payload = toolInput(
          Gateway.SendMessage.parse(JSON.parse(input.messages.at(-1)?.text ?? "null")),
        );
        const executor = yield* createExecutor({
          approvalPolicy: APPROVAL_POLICY,
          identity: {
            sessionId,
            role,
            parentActionId: input.turnId,
            turnId: input.turnId,
            toolsHash: input.toolsHash,
            toolsGeneration: input.toolsGeneration,
          },
          ledger: input.ledger,
        });
        const dispatcher = yield* createDispatcher({ executor }).pipe(Effect.provideService(ToolCatalog, { definitions: [eraseTool(createSendMessageTool({ ingest: (...args) => runEffect(gateway.ingest(...args)) }, () => 100))] }));
        result = yield* dispatcher.execute(
          { id: crypto.randomUUID(), tool: "send_message", input: payload },
          { sessionId, turnId: input.turnId },
        );
        return { kind: "result" as const, text: result.content ?? "" };
      }),
    },
    runtime,
  ).pipe(Effect.provide(context)));
  return {
    directory,
    plane,
    gateway,
    sessionId,
    requests,
    async send(input: Gateway.SendMessage, midTurn?: Effect.Effect<void>): Promise<Tool.Result> {
      result = undefined;
      beforeDispatch = midTurn;
      await runEffect(handle.prompt(JSON.stringify(input)));
      if (result === undefined) throw new Error("fixture tool did not execute");
      return result;
    },
  };
}

/** The tool's letter face for a gateway content: the string sugar, the spec, or the one reaction. */
function toolLetter(content: Gateway.SendMessage["content"]): Pick<SendMessageInput, "message" | "react"> {
  if (typeof content === "string") return { message: content };
  if (content.kind === "react") return { react: content.emoji };
  return { message: content.spec ?? Outbound.text(content) };
}

/**
 * Fixtures speak the gateway contract; the tool speaks the model vocabulary
 * (§3.5). Deadlines are absolute against the fixture clock of 100.
 */
function toolInput(send: Gateway.SendMessage): SendMessageInput {
  return {
    to: send.to.kind === "actor" ? { kind: "contact", id: send.to.actorId } : send.to,
    ...toolLetter(send.content),
    kind: send.type === "message" ? "prompt" : send.type,
    ...(send.replyTo === undefined ? {} : { reply_to: send.replyTo }),
    ...(send.deadline === undefined ? {} : { deadline_ms: send.deadline - 100 }),
  };
}
