import { APPROVAL_POLICY } from "../../src/composition/policy";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bundle, Core, Testing } from "@oni/agent";
const createDispatcher = Bundle.createDispatcher;
const createExecutor = Core.createExecutor;
const createSessionRequests = Core.createSessionRequests;
const eraseTool = Core.eraseTool;
const session = Testing.session;
type SessionRuntime = Core.SessionRuntime;
import { Bus } from "./bus";
import { createAppLedger } from "./ledger";
import { type Delivery, Gateway, type LedgerSession, Outbound, type Tool } from "@oni/protocol";
import { channelRequests, channelStoreSource, createResidentGateway, type OutboundMessaging } from "../../src/gateway";
import { createChannelStores, decodeChannelFailure } from "@oni/channels";
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
const withExecutor = Core.withExecutor;
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
  seedKernelPolicyRows(plane.updatePolicy);
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
        const send = Gateway.SendMessage.parse(JSON.parse(input.messages.at(-1)?.text ?? "null"));
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
        const port = { ingest: (...args: Parameters<typeof gateway.ingest>) => runEffect(gateway.ingest(...args)) };
        if (send.to.kind === "origin") {
          // The reply door (#1569) is the app's own door, never a model tool:
          // the fixture ingests it from the runner body under the turn's
          // executor (`withExecutor`), the same way the resident's reply does.
          result = yield* Effect.promise(() =>
            withExecutor(executor, () => port.ingest({ kind: "session", id: sessionId }, send)).then(
              (admitted): Tool.Result => ({
                id: "reply",
                toolCallId: "reply",
                toolName: "reply",
                content: JSON.stringify(admitted),
                isError: admitted.status !== "executed",
                settlement: "settled",
              }),
            ),
          );
          return { kind: "result" as const, text: result.content ?? "" };
        }
        const dispatcher = yield* createDispatcher({ executor }).pipe(Effect.provideService(ToolCatalog, {
          definitions: [eraseTool(createSendMessageTool(port, () => 100))],
        }));
        result = yield* dispatcher.execute(
          { id: crypto.randomUUID(), tool: "send_message", input: toolInput(send) },
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
    /**
     * Commits a prompt as pending under the session's own fence without
     * driving a turn, so the next `send` opens its turn on both deliveries
     * (the kernel drains every pending prompt into one turn, oldest first).
     */
    async stage(text: string, origin: Delivery.Origin, media?: Gateway.MediaPart): Promise<void> {
      const kernel = plane.openKernel(sessionId);
      const row = kernel.row(sessionId);
      if (row.fenceOwner === null) throw new Error("fixture session holds no fence");
      await runEffect(
        kernel.commit({
          sessionId,
          owner: row.fenceOwner,
          fence: row.fence,
          now: 100,
          expectedRevision: row.revision,
          actions: [
            Core.receivedMessageAction({
              id: `staged-${row.revision}`,
              sessionId,
              kind: "prompt",
              content: [{ kind: "text", text }, ...(media === undefined ? [] : [media])],
              origin,
              at: 100,
              parentActionId: kernel.latestAction(sessionId)?.id ?? null,
            }),
          ],
          state: row.state,
        }),
      );
    },
    async send(
      input: Gateway.SendMessage,
      midTurn?: Effect.Effect<void>,
      /** The origin the prompt that opens the sending turn carries (#1569: an Owner-origin turn admits `as: owner`). */
      origin?: Delivery.Origin,
    ): Promise<Tool.Result> {
      result = undefined;
      beforeDispatch = midTurn;
      await runEffect(handle.prompt(JSON.stringify(input), origin));
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
  // The reply door is the app's own door (#1569); the runner routes it to its test face above.
  if (send.to.kind === "origin") throw new Error("an origin send is not a tool face");
  return {
    to:
      send.to.kind === "actor"
        ? {
            kind: "contact",
            id: send.to.actorId,
            ...(send.to.surface === undefined ? {} : { surface: send.to.surface }),
            ...(send.to.conversation === undefined ? {} : { conversation: send.to.conversation }),
            ...(send.to.as === undefined ? {} : { as: send.to.as }),
          }
        : send.to,
    ...toolLetter(send.content),
    kind: send.type === "message" ? "prompt" : send.type,
    ...(send.replyTo === undefined ? {} : { reply_to: send.replyTo }),
    ...(send.deadline === undefined ? {} : { deadline_ms: send.deadline - 100 }),
  };
}
