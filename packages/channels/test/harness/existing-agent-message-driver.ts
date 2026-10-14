import { sessionTree } from "../../../agent/test/store/helpers/session-tree";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { type LedgerAction, Outbound, type SessionTransition } from "@openomni/protocol";
import { z } from "zod";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ledger, resetLedger } from "../helpers/ledger";
import { Bus } from "../helpers/observation";
import { runEffect } from "../helpers/effect";
import { channelRequests } from "../helpers/channel-requests";
import { channelTransaction } from "../helpers/channel-transaction";
import { answer, originalAction, requestPort } from "../helpers/requests";
import { createExistingAgentMessaging } from "../../src/router/messaging/send";

type OutboundMessage = Parameters<Parameters<typeof createExistingAgentMessaging>[0]["deliver"]>[0];
import { findRequestCandidates } from "../../src/router/request/correlation";

const version = "existing-agent-message-driver-v2";
const scenarios = ["restart-quorum", "duplicate-ambiguous"] as const;
type Scenario = (typeof scenarios)[number];
export type ExistingAgentMessageDriverExecution = Readonly<{ exitCode: 0 | 1; stdout: string }>;
const USAGE = `Usage: existing-agent-message-driver --scenario <${scenarios.join("|")}> --json`;

async function prepareScenario() {
  const actors = ledger().stores.actors;
  for (const id of ["target", "a", "b", "c", "multi"]) {
    actors.registerIdentity({ id, kind: "human", trustTier: "collaborator" });
  }
  actors.registerEndpoint({
    id: "endpoint",
    actorId: "target",
    channel: "qa",
    externalId: "target",
  });
  for (const id of ["one", "two"])
    actors.registerEndpoint({ id, actorId: "multi", channel: "qa", externalId: id });
  originalAction("request:qa:briefing", "session:qa-owner", { content: "verdict" });
  const baseline = ledger().kernel.listRows().length;
  const deliveries: OutboundMessage[] = [];
  const messaging = createExistingAgentMessaging({
    stores: ledger().stores,
    transaction: channelTransaction,
    requests: channelRequests(requestPort(() => 10)),
    publish: Bus.publish,
    grants: () =>
      ["target", "multi"].map((targetActorId: string) => ({
        id: `grant:${targetActorId}`,
        senderId: "owner",
        targetActorId,
        operations: ["awaited", "fire_and_forget"],
      })),
    deliver: (message: OutboundMessage) => {
      deliveries.push(message);
      return { value: "accepted", externalMessageId: "platform" };
    },
  });
  const fire = await runEffect(messaging.send({
    messageId: "notify",
    traceId: "trace",
    senderId: "owner",
    target: { actorId: "target" },
    operation: "fire_and_forget",
    payload: Outbound.payload("notice"),
    at: 10,
  }));
  const countAfterFire = ledger().kernel.requestRows().length;
  await runEffect(messaging.send({
    messageId: "physical",
    traceId: "trace",
    senderId: "owner",
    target: { actorId: "target" },
    operation: "awaited",
    payload: Outbound.payload("verdict"),
    at: 10,
    requestSpec: {
      requestId: "request:qa:briefing",
      sessionId: "session:qa-owner",
      expectedResponders: ["a", "b", "c"],
      allowedActions: ["report_result"],
      resolution: "quorum",
      threshold: 2,
      deadline: 100,
      correlation: { channelId: "room" },
    },
  }));
  const first = await runEffect(answer("request:qa:briefing", "a", "reply-a", 20));
  return { messaging, baseline, deliveries, fire, countAfterFire, first };
}

type ScenarioContext = Awaited<ReturnType<typeof prepareScenario>>;

async function restartQuorum(context: ScenarioContext, restart: () => void) {
  const { baseline, deliveries, fire, countAfterFire, first } = context;
  restart();
  const reopened = ledger().kernel.requestById("request:qa:briefing");
  const second = await runEffect(answer("request:qa:briefing", "b", "reply-b", 30));
  const final = ledger().kernel.requestById("request:qa:briefing");
  const terminals = sessionTree("session:qa-owner", ledger().sessions.actions).filter(
    (action: LedgerAction.Node) => action.id === "request:qa:briefing:resolution",
  );
  const allocationDelta = ledger().kernel.listRows().length - baseline;
  const ok =
    fire.kind === "sent" &&
    countAfterFire === 0 &&
    first === "attached" &&
    second === "resolved" &&
    reopened?.replies.length === 1 &&
    final?.state === "resolved" &&
    terminals.length === 1 &&
    allocationDelta === 0;
  return {
    version,
    mode: "scenario",
    scenario: "restart-quorum",
    ok,
    resultCode: ok ? "restart_quorum_resolved" : "restart_quorum_failed",
    allocationDelta,
    sessionId: final?.sessionId ?? "",
    requestState: final?.state ?? "",
    resolutionActions: terminals.map((action: LedgerAction.Node) => ({
      requestId: "request:qa:briefing",
      sessionId: action.sessionId,
      actionId: action.id,
    })),
    fireAndForget: { outcome: fire.kind, requestCountAfterSend: countAfterFire },
    restart: {
      storageReopened: true,
      stateAtRestart: reopened?.state ?? "",
      repliesPersistedAcrossRestart: reopened?.replies.length ?? 0,
    },
    deliveries: deliveries.map((message: OutboundMessage) => ({
      messageId: message.messageId,
      operation: message.operation,
      endpointId: message.target.endpointId,
    })),
  };
}

async function duplicateAmbiguous(context: ScenarioContext) {
  const { messaging, baseline } = context;
  const before = ledger().kernel.requestById("request:qa:briefing");
  const replay = await runEffect(answer("request:qa:briefing", "a", "reply-a", 20));
  const replayUnchanged =
    JSON.stringify(before) ===
    JSON.stringify(ledger().kernel.requestById("request:qa:briefing"));
  const duplicate = await runEffect(answer("request:qa:briefing", "a", "reply-a-new", 21));
  const claim = { endpointId: "endpoint", channelId: "room", replyToMessageId: "platform" };
  originalAction("second-request", "session:qa-owner");
  await runEffect(channelRequests(requestPort(() => 30)).open({
    requestId: "second-request",
    sessionId: "session:qa-owner",
    expectedResponders: ["a"],
    correlation: claim,
    allowedActions: ["report_result"],
    resolution: "first",
    threshold: 1,
    deadline: 100,
    at: 30,
  }));
  const ambiguous = findRequestCandidates(ledger().kernel.requestRows(), claim);
  const denied = await runEffect(messaging.send({
    messageId: "multi",
    traceId: "trace",
    senderId: "owner",
    target: { actorId: "multi" },
    operation: "fire_and_forget",
    payload: Outbound.payload("ambiguous"),
    at: 30,
  }));
  const after = ledger().kernel.requestById("request:qa:briefing");
  const unchanged =
    before?.state === after?.state &&
    before?.threshold === after?.threshold &&
    JSON.stringify(before?.replies) === JSON.stringify(after?.replies);
  const allocationDelta = ledger().kernel.listRows().length - baseline;
  const ok =
    replay === "attached" &&
    replayUnchanged &&
    duplicate === "duplicate" &&
    ambiguous.kind === "ambiguous" &&
    denied.kind === "denied" &&
    denied.code === "target_ambiguous" &&
    unchanged &&
    allocationDelta === 0;
  return {
    version,
    mode: "scenario",
    scenario: "duplicate-ambiguous",
    ok,
    resultCode: ok ? "duplicate_and_ambiguous_denied" : "denials_not_observed",
    denials: [
      { plane: "reply", code: duplicate },
      { plane: "correlation", code: ambiguous.kind },
      { plane: "messaging", code: denied.kind === "denied" ? denied.code : denied.kind },
    ],
    quorum: {
      unchanged,
      after: quorumState(after),
    },
    childAllocated: false,
    allocationDelta,
  };
}

function quorumState(request: SessionTransition.Request | undefined) {
  return {
    state: request?.state ?? "",
    replies: request?.replies.length ?? 0,
    responders: new Set(request?.replies.map((reply: SessionTransition.Request["replies"][number]) => reply.responderId)).size,
    threshold: request?.threshold ?? 0,
  };
}

async function scenario(name: Scenario) {
  const directory = mkdtempSync(join(tmpdir(), "channels-request-"));
  const paths = {
    catalog: join(directory, "catalog.sqlite"),
    sessions: join(directory, "sessions.sqlite"),
  };
  let result:
    | Awaited<ReturnType<typeof restartQuorum>>
    | Awaited<ReturnType<typeof duplicateAmbiguous>>;
  try {
    resetLedger(paths);
    const context = await prepareScenario();
    result =
      name === "restart-quorum"
        ? await restartQuorum(context, () => {
            // A real process restart: close every handle, reopen the same files.
            resetLedger(paths);
          })
        : await duplicateAmbiguous(context);
  } finally {
    resetLedger();
    Bus.reset();
    rmSync(directory, { recursive: true, force: true });
  }
  if (existsSync(directory)) throw new Error("temporary database cleanup failed");
  return result;
}

async function executeDriver(
  args: readonly string[],
): Promise<ExistingAgentMessageDriverExecution> {
  if (args.length === 1 && args[0] === "--help") return { exitCode: 0, stdout: USAGE };
  const name = args[1];
  if (
    args.length !== 3 ||
    args[0] !== "--scenario" ||
    args[2] !== "--json" ||
    (name !== "restart-quorum" && name !== "duplicate-ambiguous")
  )
    return {
      exitCode: 1,
      stdout: JSON.stringify({
        version,
        mode: "argument_error",
        ok: false,
        resultCode: "invalid_arguments",
      }),
    };
  const receipt = await scenario(name);
  return { exitCode: receipt.ok ? 0 : 1, stdout: JSON.stringify(receipt) };
}

const DriverFailure = z
  .instanceof(Error)
  .transform((error: Error) => error.name)
  .catch("NonError")
  .transform(
    (errorType: string): ExistingAgentMessageDriverExecution => ({
      exitCode: 1,
      stdout: JSON.stringify({
        version,
        mode: "driver_error",
        ok: false,
        resultCode: "driver_threw",
        errorType,
      }),
    }),
  );

export function runExistingAgentMessageDriver(
  args: readonly string[],
): Promise<ExistingAgentMessageDriverExecution> {
  return executeDriver(args).catch(DriverFailure.parse);
}

if (import.meta.main) {
  const result = await runExistingAgentMessageDriver(Bun.argv.slice(2));
  process.stdout.write(`${result.stdout}\n`);
  process.exitCode = result.exitCode;
}
