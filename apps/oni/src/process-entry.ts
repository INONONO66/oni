import type { Readable } from "node:stream";
import { Bundle, Core } from "@oni/agent";
const Entropy = Core.Entropy;
const GenerationLayers = Core.GenerationLayers;
const ObservationSink = Core.ObservationSink;
const closeSessions = Core.closeSessions;
const currentExecutor = Core.currentExecutor;
const AgentFailure = Core.AgentFailure;
type AgentFailure = Core.AgentFailure;
type SessionError = Core.SessionError;
type SessionHostRuntime = Core.SessionHostRuntime;
import { createChannelStores, createGatewayRouter, decodeChannelFailure } from "@oni/channels";
import { Effect, Logger } from "effect";
import {
  acquireAppResource,
  channelRequests,
  runAppEffect,
  channelStoreSource,
  channelTransaction,
  gatewayRuntime,
  toolPorts,
} from "./gateway";
import { AppInvariantError } from "./invariant";
import { AppScope, DeliveryMediaRegistry, SessionEntityBinding, type AppRuntime } from "./runtime";
import { type Delivery, Model, type SessionTransition } from "@oni/protocol";
import { z } from "zod";
import { AppLedger } from "./composition/cluster-runtime";
import { ComposedGeneration } from "./composition/composed";
import { createCompletionPort } from "./composition/completion";
import { configureAuthority } from "./composition/generation-layers";
import { GATEWAY_INGRESS_SESSION } from "./composition/ingress-executor";
import { captureNow } from "./composition/platform";
import { createResident } from "./composition/resident";
import { type DeliverPayload, deliverPayload, prepareMessage } from "./composition/message-session";
import { messageDecisionRules } from "./composition/message-decision";
import { gateRowPolicySeeds } from "./bundles/core-policy/index";
import { ownerPolicy, seedKernelPolicyRows, SHIPPED_OWNER_POLICY, type OwnerPolicy } from "./composition/policy";
import { AppPointTable } from "./composition/point-table";
import { dispatchOutboundMessage, outboundMessage } from "./composition/terminal-message";
import { settleChild } from "./bundles/delegation-policy/index";
import { createProcessReplyChannel, type ProcessMedia } from "./composition/process-replies";
import { appManifest } from "./manifest";
import { createWatchPlane } from "./composition/watch-plane";
import { composedHolderOf, alarmPortsSlot, toolPortsSlot } from "./composition/composed";
import { readHooksJson } from "./bundles/hooks-json/index";
import { loadPromptCatalog } from "./bundles/prompt/data";

export const ProcessSessionRequest = z
  .object({
    sessionId: z.string().min(1),
    catalogPath: z.string().min(1),
    sessionsDir: z.string().min(1),
    entityIdleMs: z.number().int().positive(),
    model: Model.Ref,
    apiKey: z.string().min(1),
    hooksPath: z.string().min(1).optional(),
    policyPath: z.string().min(1).optional(),
    promptsDir: z.string().min(1).optional(),
    skillsDir: z.string().min(1).optional(),
    off: z.array(z.string().min(1)).optional(),
    transport: z
      .object({
        baseUrl: z.string().optional(),
        headers: z.record(z.string(), z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ProcessSessionRequest = z.infer<typeof ProcessSessionRequest>;
export const PROCESS_SESSION_NO_REQUEST_EXIT = 78;

/**
 * The parent-side door one process child's deliveries go through (#1346):
 * the child maps each prepared commit to its entity `Deliver` payload and
 * the parent, which owns the cluster, creates the destination and runs the
 * RPC. The child itself never writes another session's chain.
 */
export interface ProcessDelivery {
  readonly commit: Delivery.Commit;
  readonly deliver: DeliverPayload;
}

export interface ProcessReplies {
  readonly answer?: (input: SessionTransition.Answer) => Promise<SessionTransition.Resolution>;
  readonly deliver: (input: ProcessDelivery) => Promise<Delivery.Row>;
  readonly media?: ProcessMedia;
}

/** The child's delivery commit: payload mapping here, admission in the parent's entity. */
export function forwardedDeliveryCommit(deliver: ProcessReplies["deliver"]) {
  return (input: Delivery.Commit): Effect.Effect<Delivery.Row, AgentFailure> =>
    deliverPayload(input).pipe(
      Effect.flatMap((payload) =>
        Effect.tryPromise({
          try: () => deliver({ commit: input, deliver: payload }),
          catch: (error) => new AgentFailure({ operation: "message.deliver", cause: String(error) }),
        }),
      ),
    );
}

export function serveProcessSession(
  request: ProcessSessionRequest,
  committed: (ids: readonly string[]) => void,
  replies: ProcessReplies,
  appRuntime: AppRuntime,
  policy: OwnerPolicy = SHIPPED_OWNER_POLICY,
) {
  const answer = replies.answer;
  return Effect.gen(function* () {
  const composed = yield* ComposedGeneration;
  const generations = yield* GenerationLayers;
  const plane = yield* AppLedger;
  const scope = yield* AppScope;
  const now = yield* captureNow;
  const entropy = yield* Entropy;
  const observations = yield* ObservationSink;
  const owner = `process:${process.pid}`;
  // Fail closed before any entity wake: a session absent from the durable
  // plane is the typed child refusal here — the activation would otherwise
  // die building its handlers and the wake would never ack.
  plane.read.session(request.sessionId).row(request.sessionId);
  if (replies.media !== undefined) {
    const media = yield* DeliveryMediaRegistry;
    media.bind(replies.media.bytes, replies.media.derive);
  }
  seedKernelPolicyRows(
    plane.updatePolicy,
    gateRowPolicySeeds(composed.current().generation),
    yield* AppPointTable,
    policy.rows,
  );
  const runtime: SessionHostRuntime = plane.runtime({
    // #1309: approval/budget policy values from the product bundle.
    approvalPolicy: policy.approval,
    processId: owner,
    onDeliveryCommitted: committed,
    dispatchOutbound: dispatchOutboundMessage(
      (...args) => gateway.ingest(...args),
      plane.read.session,
      policy.approval,
    ),
    authorizeConfigure: configureAuthority(generations, plane.read.session),
    // #1311: the product settlement fold injected into the core seam.
    settleChild,
  });
  const messages = {
    ingest: (...args: Parameters<ReturnType<typeof createGatewayRouter>["ingest"]>) =>
      gateway.ingest(...args),
  };
  // The process's one sub-model seam: the configured model's credential and transport, real I/O.
  const llm = createCompletionPort(
    {
      ...request.model,
      apiKey: request.apiKey,
      ...(request.transport === undefined ? {} : { transport: request.transport }),
    },
    { now, id: entropy.id },
  );
  const tools = toolPorts(appRuntime, { messages, completion: llm, now, id: entropy.id });
  composed.tools.bind(tools);
  const resident = createResident({
    composed: { current: composed.current },
    model: request.model,
    apiKey: request.apiKey,
    ...(request.transport === undefined ? {} : { transport: request.transport }),
    prompts: loadPromptCatalog(request),
    sessionRuntime: runtime.options,
    tools,
    policyGeneration: () =>
      plane.read.session(GATEWAY_INGRESS_SESSION).currentPolicyGeneration(),
  });
  yield* generations.initialize({ resident: [], child: [] });
  const requests = yield* runtime.requests("adopt");
  const commitDelivery = forwardedDeliveryCommit(replies.deliver);
  const gateway = createGatewayRouter({
    sink: observations.publish,
    now,
    id: entropy.id,
    stores: createChannelStores(channelStoreSource(plane, now)),
    transaction: channelTransaction(plane),
    delivery: { commit: (input) => commitDelivery(input).pipe(Effect.mapError(decodeChannelFailure("message.commit"))) },
    prepare: prepareMessage(plane, resident.genesis),
    run: (sender, execution, body) => Effect.gen(function* () {
      const outbound = yield* outboundMessage;
      const result = yield* (outbound?.executor ?? currentExecutor()).run(
        execution,
        (intent) => body(intent).pipe(Effect.mapError((error) => new AgentFailure({ operation: "message.body", cause: String(error) }))),
      );
      if (sender.kind !== "session") return yield* Effect.die(new Error("process gateway requires a session sender"));
      return {
        ...result,
        matchedRuleIds: messageDecisionRules(plane.read.session(sender.id), sender.id, execution),
      };
    }).pipe(Effect.mapError(decodeChannelFailure("message.run"))),
    requests: { ...channelRequests(requests), ...(answer === undefined ? {} : { answer: (input: SessionTransition.Answer) => Effect.tryPromise({ try: () => answer(input), catch: decodeChannelFailure("process.answer") }) }) },
    committed: (row) => committed([row.sessionId]),
  });
  // The child's drain IS the entity's (#1308): bind the activation ports to
  // the Resident's runner with an inline detach — the child owns the whole
  // turn's lifetime, so the wake only acks after the backlog ran dry — then
  // wake the session entity once with the entity-internal `rescan`
  // occurrence. The entity owns fence rotation, consume folds and
  // passivation arming; this function declares nothing twice.
  const turns = yield* runtime.turns;
  // A turn refusal must end the child typed (non-zero exit), not vanish into
  // an activation log: the first failure is recorded and surfaced after the
  // wake. A failure that left the journal unmoved is a wiring defect and dies
  // — the drain would otherwise re-admit the same decision forever.
  let refused: SessionError | undefined;
  const runTurn: Core.SessionEntityPorts["runTurn"] = (input) =>
    Effect.suspend(() => {
      const reads = Core.sessionReadModel(input.kernel);
      const before = reads.row(input.authority.sessionId).revision;
      return turns.run(
        resident.runnerFor(reads.row(input.authority.sessionId)),
        scope,
      )({ ...input, detach: (body) => body }).pipe(
        Effect.catch((error) =>
          reads.row(input.authority.sessionId).revision === before
            ? Effect.die(error)
            : Effect.sync(() => {
                refused ??= error;
              }),
        ),
      );
    });
  const binding = yield* SessionEntityBinding;
  // Live reads: the bound ports reflect the composed generation at admission
  // time, not at bind time — a recompose between bind and wake must win.
  const entityPorts: Core.SessionEntityPorts = { runTurn, approvalPolicy: runtime.options.approvalPolicy, dispatchOutbound: turns.dispatchOutbound, get inputRegistrations(): readonly string[] { return ["prompt", "signal", ...composed.current().generation.inputs]; },
    get capabilityKinds(): readonly string[] { return Object.keys(composed.current().generation.kinds); } };
  binding.bind(entityPorts);
  const entityClient = yield* Core.sessionClient;
  const wake = entityClient(request.sessionId)
    .Alarm({
      occurrenceId: `${request.sessionId}:rescan:${entropy.id()}`,
      purpose: "rescan",
      alarmId: `${request.sessionId}:rescan`,
      armSeq: 0,
      sourceKey: "rescan",
      payload: "{}",
      fireAt: now(),
    })
    .pipe(
      Effect.mapError((error) => new AgentFailure({ operation: "process.wake", cause: String(error) })),
      Effect.andThen(Effect.suspend(() => (refused === undefined ? Effect.void : Effect.fail(refused)))),
    );
  yield* wake.pipe(Effect.ensuring(closeSessions(runtime).pipe(Effect.orDie)));
  });
}

export async function runProcessEntry(io: {
  stdin: Readable;
  log: (line: string) => void;
  exit: (code: number) => never;
  gatewayRuntime?: typeof gatewayRuntime;
}): Promise<void> {
  // The reply channel exists before the runtime (the first frame carries the
  // runtime's paths), but answers only flow while serveProcessSession runs —
  // by then the runtime is constructed, so the lazy run port is total.
  let runtime: AppRuntime | undefined;
  const replies = createProcessReplyChannel(io.stdin, io.log, (effect) => {
    if (runtime === undefined) throw new AppInvariantError("process reply before runtime construction");
    return runAppEffect(runtime, effect);
  });
  try {
    const line = await replies.first;
    if (line === undefined) io.exit(PROCESS_SESSION_NO_REQUEST_EXIT);
    const request = ProcessSessionRequest.parse(JSON.parse(line));
    // The child rebuilds the SAME composition root the parent booted from
    // (config -> manifest -> compose -> runtime): the request carries the
    // manifest inputs, never a tool list. A bad hooks file or a compose
    // refusal is the typed child-boot failure, before any work.
    const alarmsSlot = alarmPortsSlot();
    const toolsSlot = toolPortsSlot();
    const watchPlane = createWatchPlane();
    const hooks = request.hooksPath === undefined ? undefined : readHooksJson(request.hooksPath);
    const policy = ownerPolicy(request.policyPath);
    const manifest = appManifest({
      alarm: watchPlane.contract,
      wake: watchPlane.wake,
      alarms: alarmsSlot.current,
      tools: toolsSlot.current,
      ...(hooks === undefined ? {} : { hooks }),
      policy,
      ...(request.off === undefined ? {} : { off: request.off }),
    });
    const composed = composedHolderOf({ manifest, generation: Bundle.composeSync(manifest) }, alarmsSlot, toolsSlot);
    runtime = (io.gatewayRuntime ?? gatewayRuntime)({
      catalogPath: request.catalogPath,
      sessionsDir: request.sessionsDir,
      // Never the shared catalog: the parent's SingleRunner owns its cluster_* tables.
      clusterStoragePath: ":memory:",
      composed,
      media: replies.media,
      // stdout is the parent's JSON-lines wire (`io.log`): every Effect log goes to the
      // inherited stderr, so an activation log can never corrupt a frame.
      logger: Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)]),
    });
    try {
      await acquireAppResource(runtime, serveProcessSession(
        request,
        (sessionIds) => io.log(JSON.stringify({ sessionIds })),
        { answer: replies.answer, deliver: replies.deliver, media: replies.media },
        runtime,
        policy,
      ));
    } finally {
      await runtime.dispose();
    }
  } finally {
    replies.close();
  }
}

if (import.meta.main) {
  await runProcessEntry({ stdin: process.stdin, log: console.log, exit: process.exit });
}
