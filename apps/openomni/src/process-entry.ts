import type { Readable } from "node:stream";
import { Bundle, Core } from "@openomni/agent";
const Entropy = Core.Entropy;
const GenerationLayers = Core.GenerationLayers;
const ObservationSink = Core.ObservationSink;
const closeSessions = Core.closeSessions;
const createSessionRequests = Core.createSessionRequests;
const currentExecutor = Core.currentExecutor;
const AgentFailure = Core.AgentFailure;
type AgentFailure = Core.AgentFailure;
const adoptSessionAuthority = Core.adoptSessionAuthority;
const SessionEntity = Core.SessionEntity;
type SessionError = Core.SessionError;
const receivedMessageAction = Core.receivedMessageAction;
type SessionEntryServices = Core.SessionEntryServices;
type SessionRuntime = Core.SessionRuntime;
import { createChannelStores, createGatewayRouter, decodeChannelFailure } from "@openomni/channels";
import { Effect } from "effect";
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
import { AppScope, SessionEntityBinding, type AppRuntime } from "./runtime";
import { type Delivery, Model, type SessionTransition } from "@openomni/protocol";
import { z } from "zod";
import { AppLedger, type AppLedgerPlane } from "./composition/cluster-runtime";
import { ComposedGeneration } from "./composition/composed";
import { createCompletionPort } from "./composition/completion";
import { configureAuthority } from "./composition/generation-layers";
import { GATEWAY_INGRESS_SESSION } from "./composition/ingress-executor";
import { captureNow } from "./composition/platform";
import { createResident } from "./resident";
import { materializeDeliveryTarget, pendingDeliveryRow, prepareMessage } from "./composition/message-session";
import { messageDecisionRules } from "./composition/message-decision";
import { gateRowPolicySeeds, seedKernelPolicyRows } from "./policy-seed";
import { AppPointTable } from "./composition/point-table";
import { dispatchOutboundMessage, outboundMessage } from "./composition/terminal-message";
import { settleChild } from "./bundles/delegation-policy";
import { APPROVAL_POLICY } from "./bundles/approval-policy";
import { createProcessReplyChannel } from "./composition/process-replies";
import { appManifest } from "./manifest";
import { createWatchPlane } from "./composition/watch-plane";
import { composedHolderOf, alarmPortsSlot } from "./composition/composed";
import { readHooksJson } from "./bundles/hooks-json";

export const ProcessSessionRequest = z
  .object({
    sessionId: z.string().min(1),
    catalogPath: z.string().min(1),
    sessionsDir: z.string().min(1),
    entityIdleMs: z.number().int().positive(),
    model: Model.Ref,
    apiKey: z.string().min(1),
    hooksPath: z.string().min(1).optional(),
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
 * Direct chain commit of one received message (child-side delivery). The
 * child has no cluster client; an idle destination gets a fence takeover and
 * relies on the parent's `committed` doorbell (stdout) for any further wake
 * (the parent's entity re-adopts on its next activation — the same takeover
 * the fence CAS exists for). A RUNNING destination's live authority is
 * borrowed instead (W5.2 S4, same rule as `requestAuthorityKernel`):
 * stealing a live turn's fence would refuse that turn's own commits
 * mid-flight, and with the delivering RPC acking at the durable boundary
 * there is no redelivery to absorb that refusal — the row lands between the
 * turn's awaits and the turn's continuation drain consumes it.
 */
export function localDeliveryCommit(plane: AppLedgerPlane, owner: string, clock: () => number) {
  return (input: Delivery.Commit): Effect.Effect<Delivery.Row, AgentFailure> =>
    Effect.gen(function* () {
      yield* materializeDeliveryTarget(plane, input, clock);
      const kernel = plane.openKernel(input.sessionId);
      const existing = kernel.actionById(input.id);
      if (existing !== undefined) return pendingDeliveryRow(input, existing.ordinal);
      const refuse = (error: { readonly _tag: string }) =>
        new AgentFailure({ operation: "message.commit", cause: error._tag });
      const live = kernel.row(input.sessionId);
      const authority =
        live.state === "running" && live.fenceOwner !== null
          ? { owner: live.fenceOwner, fence: live.fence }
          : {
              owner,
              fence: yield* adoptSessionAuthority(kernel, input.sessionId, owner).pipe(
                Effect.mapError(refuse),
              ),
            };
      const row = kernel.row(input.sessionId);
      const action = receivedMessageAction({ ...input, at: input.createdAt });
      const committed = yield* kernel
        .commit({
          sessionId: input.sessionId,
          owner: authority.owner,
          fence: authority.fence,
          now: clock(),
          expectedRevision: row.revision,
          actions: [action],
          state: row.state,
        })
        .pipe(Effect.mapError(refuse));
      const receipt = committed.receipts[0];
      if (receipt === undefined)
        return yield* new AgentFailure({ operation: "message.commit", cause: "no receipt" });
      return pendingDeliveryRow(input, receipt.action.ordinal);
    });
}

export function serveProcessSession(
  request: ProcessSessionRequest,
  committed: (ids: readonly string[]) => void,
  answer: ((input: SessionTransition.Answer) => Promise<SessionTransition.Resolution>) | undefined,
  appRuntime: AppRuntime,
) {
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
  plane.openKernel(request.sessionId).row(request.sessionId);
  seedKernelPolicyRows(plane.catalog.policies, gateRowPolicySeeds(composed.current().generation), yield* AppPointTable);
  const runtime: SessionRuntime = {
    // #1309: approval/budget policy values from the product bundle.
    approvalPolicy: APPROVAL_POLICY,
    openKernel: plane.openKernel,
    listSessions: plane.listSessions,
    processId: owner,
    onDeliveryCommitted: committed,
    dispatchOutbound: dispatchOutboundMessage(
      (...args) => gateway.ingest(...args),
      now,
      plane.openKernel,
    ),
    authorizeConfigure: configureAuthority(generations, plane.openKernel),
    // #1311: the product settlement fold injected into the core seam.
    settleChild,
  };
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
  const resident = createResident({
    composed: { current: composed.current },
    model: request.model,
    apiKey: request.apiKey,
    ...(request.transport === undefined ? {} : { transport: request.transport }),
    sessionRuntime: runtime,
    tools: toolPorts(appRuntime, { messages, completion: llm, now, id: entropy.id }),
    policyGeneration: () =>
      plane.openKernel(GATEWAY_INGRESS_SESSION).currentPolicyGeneration(),
  });
  yield* generations.initialize(resident.definitions);
  const requests = yield* createSessionRequests(runtime);
  const commitDelivery = localDeliveryCommit(plane, owner, now);
  const gateway = createGatewayRouter({
    sink: observations.publish,
    now,
    id: entropy.id,
    stores: createChannelStores(channelStoreSource(plane, now)),
    transaction: channelTransaction(plane.sessionStore(GATEWAY_INGRESS_SESSION).transaction),
    delivery: { commit: (input) => commitDelivery(input).pipe(Effect.mapError(decodeChannelFailure("message.commit"))) },
    prepare: prepareMessage(plane, resident.materialize),
    run: (sender, execution, body) => Effect.gen(function* () {
      const outbound = yield* outboundMessage;
      const result = yield* (outbound?.executor ?? currentExecutor()).run(
        execution,
        (intent) => body(intent).pipe(Effect.mapError((error) => new AgentFailure({ operation: "message.body", cause: String(error) }))),
      );
      if (sender.kind !== "session") return yield* Effect.die(new Error("process gateway requires a session sender"));
      return {
        ...result,
        matchedRuleIds: messageDecisionRules(plane.openKernel(sender.id), sender.id, execution),
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
  const resolved: Core.ResolvedSessionRuntime = {
    ...runtime,
    clock: now,
    entropy: entropy.id,
    observations,
    generations,
    services: yield* Effect.context<SessionEntryServices>(),
  };
  // A turn refusal must end the child typed (non-zero exit), not vanish into
  // an activation log: the first failure is recorded and surfaced after the
  // wake. A failure that left the journal unmoved is a wiring defect and dies
  // — the drain would otherwise re-admit the same decision forever.
  let refused: SessionError | undefined;
  const runTurn: Core.SessionEntityPorts["runTurn"] = (input) =>
    Effect.suspend(() => {
      const before = input.kernel.row(input.authority.sessionId).revision;
      return plane.turnPort(
        resident.runnerFor(input.kernel.row(input.authority.sessionId)),
        resolved,
        scope,
      )({ ...input, detach: (body) => body }).pipe(
        Effect.catch((error) =>
          input.kernel.row(input.authority.sessionId).revision === before
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
  const entityPorts: Core.SessionEntityPorts = { runTurn, approvalPolicy: runtime.approvalPolicy, get inputRegistrations(): readonly string[] { return ["prompt", "signal", ...composed.current().generation.inputs]; },
    get capabilityKinds(): readonly string[] { return Object.keys(composed.current().generation.kinds); } };
  binding.bind(entityPorts);
  const entityClient = yield* SessionEntity.client;
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
    const watchPlane = createWatchPlane();
    const hooks = request.hooksPath === undefined ? undefined : readHooksJson(request.hooksPath);
    const manifest = appManifest({
      alarm: watchPlane.contract,
      wake: watchPlane.wake,
      alarms: alarmsSlot.current,
      ...(hooks === undefined ? {} : { hooks }),
      ...(request.off === undefined ? {} : { off: request.off }),
    });
    const composed = composedHolderOf({ manifest, generation: Bundle.composeSync(manifest) }, alarmsSlot);
    runtime = (io.gatewayRuntime ?? gatewayRuntime)({
      catalogPath: request.catalogPath,
      sessionsDir: request.sessionsDir,
      // Never the shared catalog: the parent's SingleRunner owns its cluster_* tables.
      clusterStoragePath: ":memory:",
      composed,
    });
    try {
      await acquireAppResource(runtime, serveProcessSession(
        request,
        (sessionIds) => io.log(JSON.stringify({ sessionIds })),
        replies.answer,
        runtime,
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
