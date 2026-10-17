import { type Cause, Effect, Result } from "effect";
import { ThrownError } from "./thrown";
import { AppInvariantError } from "./invariant";
import { retryableOnce } from "./retryable-once";
import { bootResource } from "./composition/boot";
import { automationClock } from "./composition/automation-clock";
import { automationWire } from "./composition/automation-wire";
import { channelWire } from "./composition/channel-wire";
import { a2aContacts } from "./composition/a2a-contacts";
import { ownerContactFor } from "./composition/owner-contact";
import { ownerAnswerAuthentication } from "./composition/answer-authentication";
import { typingRouteFor } from "./composition/typing-route";
import { webhookContacts } from "./composition/webhook-contacts";
import type { MachinePort } from "./bundles/provision/machines";
import { automationJudge } from "./composition/automation-judge";
import { createAutomationDelivery } from "./composition/automation-delivery";
import { automationAlarm, type AlarmIngress } from "./composition/automation-alarm";
import { foreignFailure } from "./composition/failure";
import { shutdownSessions } from "./shutdown";
import {
  AppScope,
  SessionEntityBinding,
  type AppRuntime,
  type AppServices,
  lifecycleFailure,
} from "./runtime";
import { timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { compactionOptions } from "./bundles/compaction/index";
import { readHooksJson } from "./bundles/hooks-json/index";
import { ownerPolicy } from "./composition/policy";
import { gateRowPolicySeeds } from "./bundles/core-policy/index";
import { seedKernelPolicyRows } from "./composition/policy";
import { AppPointTable } from "./composition/point-table";
import { Core, Bundle } from "@openomni/agent";
const Entropy = Core.Entropy;
const GenerationLayers = Core.GenerationLayers;
const ObservationSink = Core.ObservationSink;
const createSessionRequests = Core.createSessionRequests;
const SessionEntity = Core.SessionEntity;
type SessionHandle = Core.SessionHandle;
type SessionRuntime = Core.SessionRuntime;
const AgentFailure = Core.AgentFailure;
const ExecutionApprovalError = Core.ExecutionApprovalError;
import { canonicalJson, SessionGeneration, SessionTransition, type PlainValue } from "@openomni/protocol";
import {
  type ChannelDeliveryRoute,
  type ProviderTypingRoute,
  type GatewayRouter,
  createChannelStores,
  decodeChannelFailure,
  ChannelsFailure,
  inboundOnce,
  WebSocketHandler,
  createWebhookSender,
  A2AClient,
} from "@openomni/channels";

import {
  createMachineHost,
  MachinesFailure,
  type MachineError,
  type MachineHost,
} from "@openomni/machines";
import {
  Alarm,
  Operational,
  Outbound,
  traceIdFromUuid,
  type BusEvent,
  type Channel,
  type Machine,
} from "@openomni/protocol";
import {
  attachSelfMachine,
  selfAttachFailure,
  selfEnrollment,
  type SelfMachine,
} from "./composition/self-machine";
import { desiredChannels, materializePersons, ownerAccountBinder, vaultCredentialReader } from "./bundles/provision/declared";
import { type ChannelSupervisor, createChannelSupervisor } from "./bundles/provision/supervisor";
import type { ProvisionPort } from "./bundles/provision/channels";
import {
  assertWsExposure,
  ConfigurationError,
  loadConfig,
  modelTransport,
  resolveAlarmSweep,
  resolveClusterStorage,
  resolveSessionFork,
  resolveToolOutput,
  validateMachinePlane,
  type OpenOmniConfig,
} from "./config";
import { createCompletionPort } from "./composition/completion";
import { processEntryPath } from "./process-entry-path";
import { createProcessSessionTransport } from "./composition/process-session";
import { commitDeliverPayload, prepareMessage } from "./composition/message-session";
import { dispatchOutboundMessage } from "./composition/terminal-message";
import {
  DELEGATION_DEADLINE,
  settleChild,
  type DelegationDeadlineDeps,
} from "./bundles/delegation-policy/index";
import {
  AppLedger,
  createSessionLivePlane,
  interruptFailureCause,
  requestAuthorityKernel,
  rescanOccurrences,
  sessionFilePath,
} from "./composition/cluster-runtime";
import { GATEWAY_INGRESS_SESSION } from "./composition/ingress-executor";
import { captureNow, effectScheduler } from "./composition/platform";
import { createWatchSources, type PathWatchInstaller } from "./composition/watch-sources";
import { createMediaResolver } from "./composition/media";
import { createSessionForkExecutor } from "./composition/session-fork";
import { alarmCapabilityView, createWatchPlane } from "./composition/watch-plane";
import { ComposedGeneration, composedHolderOf, alarmPortsSlot, toolPortsSlot } from "./composition/composed";
import { appManifest } from "./manifest";
import { loadToolPacks } from "./bundles/tools/tool-packs/index";
import {
  acquireAppResource,
  channelRequests,
  channelStoreSource,
  createMonitorPorts,
  createMountedChannelGrantRegistrar,
  createResidentGateway,
  gatewayRuntime,
  runAppBoot,
  runAppEffect,
  toolPorts,
  webSocketCallbacks,
} from "./gateway";
import { configureAuthority, type GenerationDefinitions } from "./composition/generation-layers";
import { createResident } from "./composition/resident";
import { composeCodemode, sessionOutputsSource, type ComposedCodemode } from "./composition/codemode";
import { createRequestDomainRevisions } from "./composition/request-domain-revisions";
import { admit } from "./bundles/child-activity/admit";
import { ChildWatch } from "./bundles/child-activity/index";
import { type ChildRow, currentState, receivedChildRows, stateReceipts } from "./bundles/child-activity/reconcile";

/** A channel message the gateway refused pre-admission: the driver reports it to the sender. */
class MessageAdmissionRefused extends Error {
  constructor(reasonCode: string) {
    super(`message admission refused: ${reasonCode}`);
    this.name = "MessageAdmissionRefused";
  }
}

interface StartOptions {
  readonly runtime?: AppRuntime;
  /** Native watch boundary; tests can model a stream that drops a create. */
  readonly pathWatch?: PathWatchInstaller;
  readonly sessionRuntime?: Pick<
    SessionRuntime,
    "closeGraceMs" | "approvalTimeoutMs" | "retryAlarm" | "openIntent" | "onHibernate"
  >;
  readonly config?: OpenOmniConfig;
}

/**
 * The machine plane in the #1271 boot order: validate the Owner's plane,
 * start the listener set, attach the in-process self daemon over the unix
 * loopback, and complete `machine.attach` — each failure is the one typed
 * startup refusal `self_attach_failed`, and nothing here ever falls back to
 * local execution. Tool ports are published only after `self.ready` passes.
 */
async function composeMachinePlane(
  runtime: AppRuntime,
  machines: NonNullable<OpenOmniConfig["machines"]>,
  deps: {
    readonly enrollments: MachinePort["enrollments"];
    readonly events: BusEvent.Sink;
    readonly id: () => string;
    readonly now: () => number;
    readonly callTool: (
      call: Machine.ToolCall,
    ) => Effect.Effect<Machine.ToolCallResult, MachineError>;
  },
): Promise<{
  readonly host: MachineHost;
  readonly self: SelfMachine;
  readonly defaultMachine: string;
}> {
  const plane = Result.getOrThrowWith(
    Result.try({
      try: () => validateMachinePlane(machines),
      catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
    }),
    (cause) => selfAttachFailure(`machine configuration invalid: ${cause}`),
  );
  // r1 L1: the self enrollment is one record stamped at composition time,
  // not re-stamped on every lookup.
  const selfRecord = selfEnrollment(plane, deps.now());
  deps.enrollments.seed(machines.enrolled);
  for (const enrollment of machines.enrolled) {
    const stored = deps.enrollments.get(enrollment.machineId);
    if (stored?.removedAt === null && canonicalJson(stored.enrollment) !== canonicalJson(enrollment)) {
      deps.events.publish(Operational.Events.Warn, {
        traceId: traceIdFromUuid(deps.id()), time: deps.now(), component: "machines",
        msg: "Environment enrollment seed differs from stored authority; use provision machine_add to update it",
        context: { machineId: enrollment.machineId, reason: "enrollment_seed_ignored", op: "machine_add" },
      });
    }
  }
  const host = await acquireAppResource(
    runtime,
    Effect.gen(function* () {
      // Lease idle expiry sleeps on the app Clock; the scope finalizer
      // interrupts pending timers at shutdown.
      const scheduler = effectScheduler(yield* Effect.context());
      yield* Effect.addFinalizer(() => Effect.sync(() => scheduler.close()));
      return yield* createMachineHost({
        listen: machines.listen,
        ...(machines.tls === undefined ? {} : { tls: machines.tls }),
        enrollment: (machineId) => {
          if (machineId === plane.self.id) return selfRecord;
          const row = deps.enrollments.get(machineId);
          return row?.removedAt === null ? row.enrollment : undefined;
        },
        events: deps.events,
        id: deps.id,
        // #1312: injected IPC callback bound — queue depth and callback fan-out
        // per listener; chosen here, the machines package carries no default.
        dispatcherBound: 256,
        now: deps.now,
        capacity: machines.capacity,
        scheduler,
        callTool: deps.callTool,
        // r1 M3: the live self attachment is never superseded by a reattach.
        neverSupersede: [plane.self.id],
      });
    }).pipe(
      Effect.mapError((error) => selfAttachFailure(`host listener failed: ${String(error)}`)),
    ),
  );
  const self = await acquireAppResource(
    runtime,
    attachSelfMachine({
      host,
      plane,
      socketPath: machines.listen.unix,
      id: deps.id,
      now: deps.now,
      // Typed lifecycle surface (r1 M1): the host already publishes the typed
      // Detached event for the closed connection; this records the typed
      // self_attach_failed cause on the app log, never a bare console line.
      onClose: (error) => runAppEffect(runtime, Effect.logError("self machine detached", error)),
    }),
  );
  return { host, self, defaultMachine: plane.defaultMachine };
}

/** The path every declared webhook target is served under, by its slug (#1600 lane R3): `/webhook/<slug>`. */
const WEBHOOK_PREFIX = "/webhook/";
/** The public webhook paths and the provider whose handler answers each (#1569 lane 9b adds Linear, 9c the A2A door). */
const WEBHOOK_ROUTES: ReadonlyMap<string, string> = new Map([
  ["/github/webhook", "github"],
  ["/linear/webhook", "linear"],
  ["/a2a", "a2a"],
]);
/** The A2A card's well-known path, and the older one some peers still read. */
const CARD_PATHS: ReadonlySet<string> = new Set(["/.well-known/agent-card.json", "/.well-known/agent.json"]);

/**
 * The app's HTTP surface: the ws upgrade seam, unauthenticated liveness (no
 * clock, no version, no state), the platform webhook ingresses when their
 * channel is composed (GitHub, Linear, the A2A door) and every declared
 * webhook target under `/webhook/<slug>`. Everything else is 404. The
 * webhook handler is read live from the supervisor's table so a channel_add
 * landing an instance mid-run is reachable without rebinding the server.
 */
type WebhookHandler = (request: Request) => Promise<Response>;

/** A declared slug's grammar (`channel:webhook:<slug>`): what the path segment must be, byte for byte, to name a door. */
const WEBHOOK_SLUG = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The handler a POST path names: a platform's webhook ingress by its fixed
 * path, or a declared webhook target by its slug under `/webhook/` (#1600
 * lane R3); nothing for any other path — an empty slug, a percent-escape or
 * any byte outside the slug grammar is the same 404 as an undeclared slug,
 * never decoded, never thrown.
 */
function webhookFor(pathname: string, webhookHandler: (key: string) => WebhookHandler | undefined): WebhookHandler | undefined {
  const provider = WEBHOOK_ROUTES.get(pathname);
  if (provider !== undefined) return webhookHandler(provider);
  if (!pathname.startsWith(WEBHOOK_PREFIX)) return undefined;
  const slug = pathname.slice(WEBHOOK_PREFIX.length);
  return WEBHOOK_SLUG.test(slug) ? webhookHandler(`webhook:${slug}`) : undefined;
}

function createHttpRoutes(
  wsHandler: WebSocketHandler,
  webhookHandler: (provider: string) => WebhookHandler | undefined,
) {
  return (
    request: Request,
    bunServer: Parameters<WebSocketHandler["handleUpgrade"]>[1],
  ): Response | Promise<Response> | undefined => {
    const url = new URL(request.url);
    if (request.headers.get("upgrade") === "websocket" && url.pathname === "/ws") {
      // undefined = the upgrade succeeded; a Response = the upgrade was denied.
      return wsHandler.handleUpgrade(request, bunServer);
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }
    const webhook = request.method === "POST" ? webhookFor(url.pathname, webhookHandler) : undefined;
    if (webhook !== undefined) return webhook(request);
    if (request.method === "GET" && CARD_PATHS.has(url.pathname)) {
      const handler = webhookHandler("a2a");
      if (handler !== undefined) return handler(request);
    }
    return new Response("Not found", { status: 404 });
  };
}

function residentModelOptions(
  model: OpenOmniConfig["model"],
  transport: ReturnType<typeof modelTransport>,
) {
  return {
    model,
    ...(model.fallbacks === undefined ? {} : { modelFallbacks: model.fallbacks }),
    apiKey: model.apiKey,
    ...(transport === undefined ? {} : { transport }),
  };
}

export async function startOpenOmni(options: StartOptions = {}) {
  const config = options.config ?? loadConfig();
  assertWsExposure(config);
  // #1271: the brain host is itself a machine — a boot without a machine
  // plane would publish every tool with no self daemon behind it. Refuse
  // before any listener exists; there is no local-execution posture.
  const machinesConfig = config.machines;
  if (machinesConfig === undefined) {
    throw new ConfigurationError({
      code: "machines_required",
      message: "machines.self is required: the host boots only as an attached machine (#1271)",
    });
  }
  const authenticateOwner = (credential: string, requestId: string) => {
    const expected = Buffer.from(config.wsToken ?? "");
    const presented = Buffer.from(credential);
    if (
      expected.length === 0 ||
      presented.length !== expected.length ||
      !timingSafeEqual(presented, expected)
    ) {
      throw new ExecutionApprovalError({ code: "unauthenticated" });
    }
    return { kind: "owner" as const, principalId: "owner", evidenceId: `ws-owner:${requestId}` };
  };
  // One resolution of the operator's endpoint and headers, shared by every
  // model caller this composition builds.
  const transport = modelTransport(config.model);
  // The native-source alarm plane exists before the manifest: its purpose-free
  // capability CONTRACT is what the manifest lists, while the live wake router
  // below is rebuilt per composed on-set.
  // #1258: the deadline cancel door exists before the manifest but binds at
  // boot (it needs the entity client); unbound it fails the wake loudly.
  let cancelDoor: DelegationDeadlineDeps["cancel"] | undefined;
  const delegationDeadline: DelegationDeadlineDeps = {
    cancel: (input) =>
      cancelDoor === undefined
        ? Effect.fail({ reason: "outbound cancel door is not composed" })
        : cancelDoor(input),
  };
  let alarmIngress: AlarmIngress | undefined;
  const watchPlane = createWatchPlane({
    delegation: delegationDeadline,
    ingress: (fired, ctx, input) => alarmIngress === undefined
      ? Effect.fail(new Bundle.AlarmWakeError({ purpose: fired.purpose, reason: "automation ingress is not composed" }))
      : alarmIngress(fired, ctx, input),
  });
  // #1256: the hooks file is config compiled once per boot; a bad file is a
  // typed refusal thrown here, before any listener exists.
  const hooks = config.hooksPath === undefined ? undefined : readHooksJson(config.hooksPath);
  const policy = ownerPolicy(config.policyPath);
  // Boot is config -> manifest -> compose -> runtime (#1255): a ComposeRefused
  // here is the typed boot failure, thrown before any listener exists. An
  // injected runtime carries its own composed holder (tests).
  const composedRuntime = async (): Promise<AppRuntime> => {
    const alarmsSlot = alarmPortsSlot();
    const toolsSlot = toolPortsSlot();
    const manifest = appManifest({
      alarm: watchPlane.contract,
      wake: watchPlane.wake,
      alarms: alarmsSlot.current,
      tools: toolsSlot.current,
      toolPacks: loadToolPacks(config.toolPacksDir, new Set([machinesConfig.self.id ?? "self", ...machinesConfig.enrolled.map((machine) => machine.machineId)]), toolsSlot.current, (message, code): never => { throw new AppInvariantError(message, code); }),
      ...(hooks === undefined ? {} : { hooks }),
      policy,
      ...(config.off === undefined ? {} : { off: config.off }),
    });
    const generation = Bundle.composeSync(manifest);
    const holder = composedHolderOf({ manifest, generation }, alarmsSlot, toolsSlot);
    return gatewayRuntime({
      // Cluster storage rides only on configs that resolved it (loadConfig
      // always does); injected literal test configs stay on the in-memory
      // host so no path outside their fixture directory is ever touched.
      ...(config.catalogPath === undefined ? {} : resolveClusterStorage(config)),
      composed: holder,
    });
  };
  const runtime = options.runtime ?? (await composedRuntime());
  const boot = async () => {
    const services = await runAppBoot(
      runtime,
      Effect.gen(function* () {
        return {
          context: yield* Effect.context<AppServices>(),
          plane: yield* AppLedger,
          scope: yield* AppScope,
          now: yield* captureNow,
          entropy: yield* Entropy,
          observations: yield* ObservationSink,
          composed: yield* ComposedGeneration,
          generations: yield* GenerationLayers,
          pointTable: yield* AppPointTable,
          // Late-bound entity ports: the runtime mounts the entity layer over
          // this seam; the real turn/timer ports resolve below.
          entityPorts: yield* SessionEntityBinding,
        };
      }),
    );
    const acquire = <A, E, E2>(
      resource: Effect.Effect<A, E>,
      release: (value: A) => Effect.Effect<void, E2>,
    ) => runAppBoot(runtime, bootResource(resource, release));
    const plane = services.plane;
    const channelStores = createChannelStores(channelStoreSource(plane, services.now));
    const automations = { store: channelStores.automations, id: services.entropy.id };
    const enrollments = plane.stores.machineEnrollments;
    const incident = (msg: string, error: Error | Cause.Cause<Error>): void =>
      services.observations.publish(Operational.Events.Error, {
        traceId: traceIdFromUuid(services.entropy.id()),
        time: services.now(),
        component: "app",
        msg,
        error: String(error),
      });
    // #1255 P3: compose owns the generation row tables — the composed
    // generation's gate rows seed the live policy plane, bundle-neutrally.
    seedKernelPolicyRows(
      plane.catalog.policies,
      gateRowPolicySeeds(services.composed.current().generation),
      services.pointTable,
      policy.rows,
    );
    // The Session entity client: THE delivery path for message and timer
    // traffic (W5.2 plan §1) — the RPC ack means the receiver committed.
    const entityClient = await runAppBoot(runtime, SessionEntity.client);
    // #1258: bind the deadline cancel door — `signal{control: cancel}` through
    // the entity's one deliver door, keyed by the alarm occurrence.
    cancelDoor = ({ child, occurrenceId }) =>
      entityClient(child)
        .Deliver({
          kind: "signal",
          body: JSON.stringify({ content: "delegation deadline expired", control: "cancel" }),
          source: JSON.stringify({ kind: "alarm", purpose: DELEGATION_DEADLINE }),
          idempotencyKey: `${occurrenceId}:cancel`,
        })
        .pipe(
          Effect.asVoid,
          Effect.mapError((error) => ({ reason: String(error) })),
        );

    const domainRevisions = createRequestDomainRevisions({
      machineEnrollments: enrollments,
      automations,
      actors: plane.stores.actors,
      persons: plane.stores.persons,
      instances: plane.stores.instances,
    });
    // Live entity turns publish their approval gate + boundary drain here;
    // request readiness and the session facade reach running turns through it.
    const liveTurns = createSessionLivePlane();
    const notifyLiveApprovals = (id: string): void => {
      const approvals = liveTurns.get(id)?.approvals;
      if (approvals === undefined) return;
      for (const request of plane.openKernel(id).requestRows(id)) {
        if (request.mode === "approval") approvals.notify?.(request);
      }
    };
    const compactionVerbs = Bundle.compactionCapability().verbs;
    const sessionRuntime: SessionRuntime = {
      ...options.sessionRuntime,
      // #1309: the approval/budget product values come from the composed
      // approval-policy bundle; the core keeps no literal fallback.
      approvalPolicy: policy.approval,
      // #1307 (review M1): the kernel's commit pinning and restore paths get
      // the compaction verbs only while the CURRENT composed generation keeps
      // the capability on — off, the seam stays absent so a compaction append
      // dies typed and a restore refuses `compaction_seam_missing` instead of
      // running a disabled capability.
      get compaction() {
        return services.composed.current().generation.capabilities.includes("compaction")
          ? compactionVerbs
          : undefined;
      },
      openKernel: plane.openKernel,
      listSessions: plane.listSessions,
      dispatchOutbound: dispatchOutboundMessage(
        (...args) => messages.ingest(...args),
        plane.openKernel,
        policy.approval,
      ),
      requestDomainRevisions: domainRevisions,
      onRequestReady: (id) => {
        notifyLiveApprovals(id);
        sessionRuntime.onDeliveryCommitted?.([id]);
      },
      // Entity sessions drain inside the delivering RPC before it acks; only
      // process-runner sessions still need this doorbell.
      onDeliveryCommitted: (ids) => {
        for (const id of ids) void wake(id);
      },
      authorizeApproval: (credential, request) =>
        Effect.try({
          try: () => authenticateOwner(credential, request.id),
          catch: () => new ExecutionApprovalError({ code: "unauthenticated" }),
        }),
      authorizeConfigure: configureAuthority(services.generations, plane.openKernel),
      // #1255 S3: the product's composed manifest, adopted at each session's
      // next turn start. Late-bound: the resident below owns the tool faces.
      composed: { current: () => residentAdoption?.() },
      // #1311: the product settlement fold injected into the core seam.
      settleChild,
    };
    let residentAdoption: (() => Core.ComposedManifest | undefined) | undefined;
    // Request transitions never steal a live activation's fence: the borrowed
    // kernel view commits under the running turn's authority (idle sessions
    // keep the documented takeover adoption).
    const bootRequests = await runAppBoot(
      runtime,
      createSessionRequests({
        ...sessionRuntime,
        openKernel: (id) => requestAuthorityKernel(plane.openKernel(id), id),
      }),
    );
    // An out-of-turn answer on an entity session must land through the
    // entity's own Resolve RPC (#1253): the RPC handler commits AND drains, so
    // a suspended chain (including a crashed-"running" session whose acked
    // delivery will never redeliver) recovers its open turn before the ack.
    // Only a turn LIVE IN THIS PROCESS keeps the borrowed-authority direct
    // commit — its approval gate needs the app-side notify, and the entity
    // drain defers to the detached turn anyway (W5.2 S4: `row.state` no
    // longer implies a live runner, since the delivering RPC acks at the
    // durable boundary). Process runners keep direct commit + doorbell.
    const requests: typeof bootRequests = {
      ...bootRequests,
      answer: (answer) =>
        Effect.suspend(() => {
          if (
            liveTurns.get(answer.sessionId) !== undefined ||
            sessionRunner(answer.sessionId) === "process"
          )
            return bootRequests.answer(answer);
          return entityClient(answer.sessionId)
            .Resolve({
              requestId: answer.requestId,
              outcome: "resolved",
              payload: JSON.stringify({ kind: "request.answer", answer }),
              inputId: answer.inputId,
            })
            .pipe(
              Effect.map((receipt) => SessionTransition.Resolution.parse(receipt.resolution)),
              // A typed Resolve refusal (#1253: unknown or already-settled
              // request, zero new facts) is the caller's stale answer, not a
              // runtime failure: it surfaces as the `rejected` resolution the
              // channel receipt maps to `request_answer.rejected`.
              Effect.catchTag("ResolveRefused", () =>
                Effect.succeed("rejected" as SessionTransition.Resolution),
              ),
              Effect.mapError(
                foreignFailure((fields) => new AgentFailure(fields), "request.answer"),
              ),
            );
        }),
    };
    // Recovery is the cluster's: persisted undelivered entity messages redeliver
    // on activation; there is no boot sweep to await.
    const recovery: Promise<void> = Promise.resolve();
    await acquire(Effect.void, () => shutdownSessions(sessionRuntime, recovery));
    // Declared Person manifests are the people the Resident knows (#1569
    // lane 8: no env actors) — an idempotent identity upsert from the
    // provisioning store, the durable one.
    const materializeDeclaredPersons = () =>
      materializePersons({ persons: plane.stores.persons, actors: plane.stores.actors });
    materializeDeclaredPersons();

    let gateway: GatewayRouter | undefined;
    const messages = {
      ingest: (...args: Parameters<GatewayRouter["ingest"]>) => {
        if (gateway === undefined) return Effect.die(new Error("gateway is not composed"));
        return gateway.ingest(...args);
      },
    };
    // Provisioning administration port: the supervisor is created after the
    // Resident (it needs the routing handler), so the port reaches it through
    // a late binding — tools cannot run before composition finishes anyway.
    let channelSupervisor: ChannelSupervisor | undefined;
    const liveSupervisor = (): ChannelSupervisor => {
      if (channelSupervisor === undefined)
        throw new AppInvariantError("provisioning used before composition finished");
      return channelSupervisor;
    };
    // #1254 H3: ONE committing arm path — the watch plane's live-arm registry.
    // The LIVE capability registers exactly the composed on-set's purposes;
    // `bundles.set` rebuilds it on every successful recompose behind the
    // stable view the watch ports and the entity's capability port hold.
    const liveAlarm = {
      current: await runAppBoot(
        runtime,
        watchPlane.capabilityFor(services.composed.current().generation.bundles),
      ),
    };
    const alarmPlane = alarmCapabilityView(liveAlarm);
    const provisioningPort: ProvisionPort = {
      get machines() { return machineProvision; },
      automations,
      persons: plane.stores.persons,
      instances: plane.stores.instances,
      secrets: plane.stores.secrets,
      actors: plane.stores.actors,
      transaction: plane.catalog.transaction,
      kek: config.kek,
      supervisor: {
        reconcile: () => liveSupervisor().reconcile(),
        resume: (instanceId) => liveSupervisor().resume(instanceId),
        status: () => liveSupervisor().status(),
        source: () => liveSupervisor().source(),
      },
      materialize: materializeDeclaredPersons,
      removeIdentity: plane.stores.actors.removeIdentity,
      // #1255 P4: bundle_enable/bundle_disable edit the off-list and re-run
      // compose. The swap is atomic — a ComposeRefused leaves the previous
      // composition current (rollback = nothing happened). In-flight turns
      // keep their captured generation; sessions adopt at next turn start.
      bundles: {
        names: () => services.composed.current().manifest.bundles.map((bundle) => bundle.name),
        off: () => services.composed.current().manifest.off,
        set: async (off) => {
          // #1308: recompose edits ONLY the off-list of the manifest the boot
          // composed — the one root; a rebuilt declaration would silently drop
          // bundles an injected holder (tests) declared beyond the product set.
          const current = services.composed.current().manifest;
          const manifest = Bundle.Manifest.define({
            capabilities: [...current.capabilities],
            bundles: [...current.bundles],
            off,
          });
          const generation = await runAppEffect(runtime, Bundle.compose(manifest));
          // The live alarm capability is rebuilt from the new on-set BEFORE the
          // swap: a refusal leaves the composition AND the purpose registry on
          // the previous generation, so a disabled bundle's purposes stop
          // routing (its due fires fold `stale`) and an enabled one's resume.
          const alarm = await runAppEffect(runtime, watchPlane.capabilityFor(generation.bundles));
          services.composed.swap({ manifest, generation });
          liveAlarm.current = alarm;
          // The recomposed gate rows seed a fresh policy generation alongside
          // the swap, so adopted turns evaluate the matching row tables.
          seedKernelPolicyRows(
            plane.catalog.policies,
            gateRowPolicySeeds(generation),
            services.pointTable,
            policy.rows,
          );
        },
      },
    };
    // The cell door is bound per cell rather than globally, so a cell serves
    // exactly the tools its own dispatcher holds.
    let cells: ComposedCodemode | undefined;
    const machinery = await composeMachinePlane(runtime, machinesConfig, {
      enrollments,
      events: services.observations,
      id: services.entropy.id,
      now: services.now,
      callTool: (call) =>
        cells === undefined
          ? Effect.succeed({ status: "failed" as const, error: "codemode is not composed" })
          : cells
              .callTool(call)
              .pipe(
                Effect.mapError(
                  (error) =>
                    new MachinesFailure({ operation: "codemode.callTool", cause: String(error) }),
                ),
              ),
    });
    const host: MachineHost = machinery.host;
    const machineProvision: MachinePort = {
      enrollments,
      host,
      selfId: machinery.self.machineId,
      events: services.observations,
      now: services.now,
    };

    // A cell's catalog shares the dispatcher's tool.pre policy boundary.
    const llmPort = createCompletionPort(
      { ...config.model, ...(transport === undefined ? {} : { transport }) },
      { now: services.now, id: services.entropy.id },
    );
    cells = await acquireAppResource(
      runtime,
      // #1305: the prelude's tool_output resolves against the tenant session's own file.
      composeCodemode(host, {
        id: services.entropy.id, selfMachineId: machinery.self.machineId,
        outputs: sessionOutputsSource(plane.openKernel),
      }),
    ); machinery.self.bindRunner(cells.runner);

    // Boot order (#1271): the self machine must answer over its loopback
    // attachment BEFORE any tool port exists; a dead attachment fails boot.
    await runAppEffect(runtime, machinery.self.ready);
    const tools = toolPorts(runtime, {
      machines: { host: machinery.host, defaultMachine: machinery.defaultMachine },
      cells,
      completion: llmPort,
      messages,
      now: services.now,
      id: services.entropy.id,
    });
    // Watch plane (#1253/#1254): native sources resend the chain's ARMED
    // occurrence through the entity's one `alarm` door; the occurrence id is
    // the durable dedupe and the chain-guard identity (plan F2). A superseded
    // occurrence folds to a recorded stale fact on the chain, never a
    // rejection.
    const sendAlarm = (
      sessionId: string,
      occurrence: {
        readonly occurrenceId: string;
        readonly purpose: string;
        readonly alarmId: string;
        readonly armSeq: number;
        readonly sourceKey: string;
        readonly payload: string;
        readonly fireAt: number;
        readonly tick?: number;
      },
    ) => entityClient(sessionId).Alarm(occurrence).pipe(Effect.asVoid);
    // Scheduled occurrences persist without awaiting the reply: a DeliverAt
    // send only answers at `fireAt`, and the arming turn must not block on it.
    const scheduleAlarm = (sessionId: string, occurrence: Parameters<typeof sendAlarm>[1]) =>
      entityClient(sessionId).Alarm(occurrence, { discard: true });
    const childRows = (sessionId: string): ChildRow[] => {
      const kernel = plane.openKernel(sessionId);
      const rows: ChildRow[] = [];
      let afterRevision = 0;
      for (;;) {
        const page = kernel.historyPage(sessionId, { afterRevision });
        rows.push(...receivedChildRows(page.actions));
        if (page.nextRevision === null) return rows;
        afterRevision = page.nextRevision;
      }
    };
    // Terminal watches drain the same machines surface the bash door uses.
    const watchSources = createWatchSources(
      {
        deliver: ({ sessionId, ...occurrence }) =>
          runAppEffect(runtime, sendAlarm(sessionId, occurrence)),
        admit: (sessionId: string, rows: readonly ChildRow[]) => runAppEffect(runtime, admit(entityClient, sessionId, rows)),
      },
      {
        clock: services.now,
        failure: (watchId, error) => incident(`watch ${watchId} send failed`, error),
        pathWatch: options.pathWatch,
        retirePath: (sessionId, watchId) => runAppEffect(runtime, watchPlane.retirePath(sessionId, watchId)),
        ...(tools.machines === undefined ? {} : {
          machines: tools.machines,
          children: {
            machines: tools.machines,
            rows: childRows,
          },
        }),
      },
    );
    await acquire(Effect.succeed(watchSources), (resource) =>
      Effect.tryPromise({
        try: () => resource.closeAll(),
        catch: lifecycleFailure("watches.close"),
      }),
    );
    watchPlane.bind(watchSources);
    // #1308: bind the live alarm ports the wake bundle's ONE tool
    // declaration executes against — injected holders (tests) bind here too.
    services.composed.alarms.bind(await createMonitorPorts(runtime, alarmPlane));
    const typingRoutes = new Map<string, ProviderTypingRoute>();
    // Live table: channel components register and revoke their own outbound
    // routes (declared beside the typing routes; the resident's draft arm reads it).
    const deliveryRoutes = new Map<string, ChannelDeliveryRoute>();
    // The Owner instances whose declaration lets the reply door answer through
    // the account (#1569 lane 7); the supervisor keeps it with the routes, and
    // the resident's typing pulse reads it.
    const autoReplies = new Set<string>();
    const resident = createResident({
      // The turn's pulse rides the bot instance of the platform (#1569), an
      // identity-less surface its platform key, an auto-replying Owner account its own (#1600 lane R3).
      typingRoute: typingRouteFor(typingRoutes, autoReplies),
      // #1600 lane R2: a drafted answer goes to the Owner through the bot on a
      // platform the Owner Person has an endpoint on, ws last (it needs a live socket).
      ownerContact: () => ownerContactFor(plane.stores.persons.list(), deliveryRoutes),
      prompts: config.prompts,
      // #1257: the app's resolved cap is the input the composition writes
      // into every new session's genesis generation settings.
      forkCopyByteCap: resolveSessionFork(config).copyByteCap,
      // #1305: an env-resolved budget rides genesis settings; unset leaves
      // the core default so sessions fold it without a settings row.
      ...(resolveToolOutput(config).budgetBytes === undefined
        ? {}
        : { toolOutputBudgetBytes: resolveToolOutput(config).budgetBytes }),
      ...residentModelOptions(config.model, transport),
      ackReaction: config.ackReaction,
      compaction: (session) => compactionOptions(config, { now: services.now, id: services.entropy.id, ...session }),
      composed: { current: services.composed.current },
      // #1561: every tool bundle executes against these bound ports.
      tools: services.composed.tools.bind({
        ...tools,
        provisioning: provisioningPort,
        // #1258: a `to.new` send carrying `deadline_ms` arms the
        // delegation.deadline purpose through the live activation's arm verb.
        contacts: {
          // The one Effect boundary the bundle gets (#1248): the app runtime.
          run: (effect) => runAppEffect(runtime, effect),
          // #1569 lane 8: a reachable Person with no active budget is the Owner's to approve;
          // the tool reads the same budgets the gateway's gate does and the Person rows it grants from.
          budgets: () => config.socialBudgets ?? [],
          persons: plane.stores.persons,
          // #1569 lane 9: a declared webhook target, read from the vault at send time;
          // its textual answer rides the tool result.
          webhook: webhookContacts({
            instances: plane.stores.instances,
            readCredential: vaultCredentialReader(config.kek, (ref) => plane.stores.secrets.get(ref)),
            sender: createWebhookSender({
              fetch: (url, init) => fetch(url, init),
              publish: services.observations.publish,
              now: services.now,
              id: services.entropy.id,
            }),
            publish: services.observations.publish,
            now: services.now,
            id: services.entropy.id,
          }),
          // #1569 lane 9c: a declared A2A peer, written to with its own bearer; its answer rides the tool result.
          a2a: a2aContacts({
            instances: plane.stores.instances,
            readCredential: vaultCredentialReader(config.kek, (ref) => plane.stores.secrets.get(ref)),
            client: new A2AClient({
              fetch: (url, init) => fetch(url, init),
              publish: services.observations.publish,
              now: services.now,
              id: services.entropy.id,
            }),
            publish: services.observations.publish,
            now: services.now,
            id: services.entropy.id,
            run: (effect) => runAppEffect(runtime, effect),
          }),
          deadline: {
            arm: ({ sessionId, turnId, child, at }) =>
              watchPlane.arms
                .arm(sessionId, turnId)({
                  purpose: DELEGATION_DEADLINE,
                  at,
                  payload: { child, contact: `session:${child}` },
                  sourceKey: `delegation:${child}`,
                })
                .pipe(
                  Effect.asVoid,
                  Effect.mapError((refused) => ({ reason: refused.code })),
                ),
          },
        },
      }),
      sessionRuntime,
      policyGeneration: () => plane.openKernel(GATEWAY_INGRESS_SESSION).currentPolicyGeneration(),
    });

    residentAdoption = () => resident.adoption();
    // #1256 H-3: the late-result door. A hook payload that settled after its
    // call timed out re-enters the session through the entity's one `deliver`
    // path as an `action` row carrying its call-time `after` cursor; a stale
    // cursor (before the compaction head) folds to `turn.consumed.stale`.
    const deliverLate = (sessionId: string, payload: PlainValue, after: number | undefined): void => {
      runAppEffect(
        runtime,
        entityClient(sessionId).Deliver({
          kind: "action",
          body: JSON.stringify({
            content: canonicalJson(payload),
            ...(after === undefined ? {} : { after }),
          }),
          source: JSON.stringify({ kind: "hook.late" }),
          idempotencyKey: `hook-late:${services.entropy.id()}`,
        }),
      ).catch((error) => incident(`late hook result for ${sessionId} dropped`, error));
    };
    const generationDefinitions: GenerationDefinitions = { resident: [], child: [], deliverLate };
    await runAppBoot(runtime, services.generations.initialize(generationDefinitions));

    // One physical platform message reaches routing once (#1569 lane 6): a
    // mention of the Owner in a channel the bot is in is observed by both
    // instances, and the first observer's copy is the one admitted.
    const routingHandler: Channel.MessageHandler = inboundOnce(async ({ sender, facts }) => {
      const admission = await runAppEffect(runtime, messages.ingest(sender, facts));
      if (admission.status === "blocked_pre") {
        throw new MessageAdmissionRefused(admission.reasonCode);
      }
    });
    let wsHandler: WebSocketHandler | undefined;
    const wsRoute = async (externalId: string, payload: Outbound.Payload, idempotencyKey: string) => {
      if (wsHandler === undefined)
        throw new AppInvariantError("ws delivery used before composition finished");
      // The ws wire has no reaction vocabulary: refused, never posted as text.
      if (payload.kind === "react") return { value: "rejected" } as const;
      return wsHandler.push(externalId, Outbound.text(payload), idempotencyKey);
    };
    // Live table: channel components register and revoke their own outbound
    // routes while the gateway keeps reading it per delivery.
    deliveryRoutes.set("ws", wsRoute);
    // One runtime owner for external channels (provisioning §5): boot
    // reconcile and every tool-driven mutation run the SAME diff over
    // declared ChannelInstances, the only source of external channel config.
    const webhookHandlers = new Map<string, (request: Request) => Promise<Response>>();
    const supervisor = createChannelSupervisor({
      desired: () =>
        desiredChannels(
          { instances: plane.stores.instances, secrets: plane.stores.secrets },
          config.kek,
          {
            publish: services.observations.publish,
            now: services.now,
            id: services.entropy.id,
            random: services.entropy.random,
            run: (effect) => runAppEffect(runtime, effect),
            media: createMediaResolver(tools.machines === undefined ? {} : { machines: tools.machines }),
          },
        ),
      build: (component) => component.build(routingHandler),
      // The tier is the row's, never this call site's: mounting a named
      // surface materializes no owner authority (#931).
      grant: createMountedChannelGrantRegistrar(
        plane.stores.channelGrants,
        config.channelAllowedSenders,
        config.channelMentionOnly,
      ),
      deliveryRoutes,
      typingRoutes,
      webhookHandlers,
      autoReplies,
      // #1600: an Owner instance's account is the Owner — its platform id joins the
      // Owner Person's endpoints; what goes wrong is the Owner's to hear.
      bindAccount: ownerAccountBinder({
        persons: plane.stores.persons,
        now: services.now,
        rebuildActors: materializeDeclaredPersons,
        warn: (msg, context) =>
          services.observations.publish(Operational.Events.Warn, {
            traceId: traceIdFromUuid(services.entropy.id()),
            time: services.now(),
            component: "server",
            msg,
            context,
          }),
      }),
      traceId: () => traceIdFromUuid(services.entropy.id()),
    });
    channelSupervisor = supervisor;
    const processSessions = createProcessSessionTransport({
      answer: (answer) =>
        runAppEffect(runtime, requests.answer({ ...answer, receivedAt: services.now() })),
      // #1346: a process child's deliveries are admitted here, through the
      // destination's Session entity; the child never writes another chain.
      deliver: (input) => runAppEffect(runtime, commitProcessDelivery(input.commit, input.deliver)),
      command: [process.execPath, processEntryPath(import.meta.url)],
      child: {
        ...resolveClusterStorage(config),
        model: config.model,
        apiKey: config.model.apiKey,
        ...(transport === undefined ? {} : { transport }),
        ...processSessionPromptOptions(config),
      },
      committed: (ids) => {
        for (const id of ids) void wake(id);
      },
    });
    await acquire(Effect.succeed(processSessions), (resource) =>
      Effect.tryPromise({
        try: () => resource.close(),
        catch: lifecycleFailure("processes.close"),
      }),
    );
    /** The runner block a session's current generation pins ("process" | "resident" | ...). */
    const sessionRunner = (id: string): string | undefined => {
      try {
        return plane
          .openKernel(id)
          .latestGenerationFor(id)
          .systemBlocks.find((block) => block.id === "runner" && block.source === "app:runner")
          ?.content;
      } catch {
        return undefined;
      }
    };
    // Entity sessions drain inside the delivering RPC; only process-runner
    // sessions (external child transport) still take an app-side wake.
    const wake = (id: string): Promise<void> => {
      if (sessionRunner(id) !== "process") return Promise.resolve();
      return processSessions.wake(id).catch((error: Error) => incident("process session wake failed", error));
    };
    const deliveryDeps = { plane, client: entityClient, clock: services.now };
    const commitDelivery = createAutomationDelivery(
      deliveryDeps, channelStores.automations,
    );
    const commitProcessDelivery = commitDeliverPayload(deliveryDeps);
    // Deadline-carrying requests arm one persisted DeliverAt alarm occurrence
    // on the owning session; the chain fold decides applied-versus-stale at
    // delivery (#1253).
    // The arm is forked, never awaited: requests open inside the owning
    // entity's own turn RPC, and awaiting a second RPC on that same entity
    // from within its handler would deadlock the mailbox. The fork joins the
    // app runtime's lifetime scope (never detached), so shutdown interrupts
    // or awaits it; a lost arm is a logged incident, not a refused request.
    const appScope = await runAppBoot(runtime, AppScope);
    const requestPorts = channelRequests(requests);
    const requestsWithDeadlines: typeof requestPorts = {
      ...requestPorts,
      open: (input) =>
        requestPorts.open(input).pipe(
          Effect.tap((request) =>
            request.deadline === undefined
              ? Effect.void
              : sendAlarm(request.sessionId, {
                  // #1254 S4: the request authority commits the deadline arm
                  // (alarmId `<requestId>:deadline`, armSeq 1) in the open
                  // decision batch; this send forwards that SAME minted
                  // occurrence, so the chain guard recognizes it as fresh.
                  occurrenceId: Alarm.occurrenceId(
                    request.sessionId,
                    `${request.requestId}:deadline`,
                    1,
                    "deadline",
                  ),
                  purpose: "deadline",
                  alarmId: `${request.requestId}:deadline`,
                  armSeq: 1,
                  sourceKey: "deadline",
                  payload: JSON.stringify({ requestId: request.requestId }),
                  fireAt: request.deadline,
                }).pipe(
                  Effect.catch((error) => Effect.sync(() => incident(`deadline arm failed: ${request.requestId}`, error))),
                  Effect.forkIn(appScope),
                  Effect.asVoid,
                ),
          ),
        ),
    };
    const judge = await runAppBoot(runtime, automationJudge(config.model, {
      now: services.now, id: services.entropy.id,
    }));
    gateway = await runAppBoot(
      runtime,
      createResidentGateway(
        {
          delivery: {
            commit: (input) =>
              commitDelivery(input).pipe(Effect.mapError(decodeChannelFailure("message.commit"))),
          },
          prepare: prepareMessage(plane, resident.genesis),
          judge,
          requests: requestsWithDeadlines,
          stores: channelStores,
          // #1600 lane R3: on a tokenless loopback boot the Owner's own socket is the
          // evidence; with a token configured the token is required, as before.
          authenticateAnswer: ownerAnswerAuthentication({ wsToken: config.wsToken, stores: channelStores, byToken: authenticateOwner }),
          committed: (row) => {
            void wake(row.sessionId);
          },
          now: services.now,
          id: services.entropy.id,
        },
        {
          deliveryRoutes,
          autoReplies: () => autoReplies,
          // #1569 lane 8: the standing grant is the Owner's `reach` on a Person
          // (`contact_add`), read from the store at each send so a contact named
          // mid-run is reachable at once; a Person without it is inbound-only.
          // #1600 lane R2: the Owner is always reachable by the Resident — a
          // drafted answer, a report, a question are the Owner's own mail.
          grants: () =>
            plane
              .listSessions()
              .filter((row) => row.role === "resident")
              .flatMap((row) =>
                plane.stores.persons
                  .list()
                  .filter((person) => person.reach === true || person.trustTier === "owner")
                  .map((person) => ({
                    id: `${row.id}->${person.id}`,
                    senderId: row.id,
                    targetActorId: person.id,
                    operations: ["awaited" as const, "fire_and_forget" as const],
                  })),
              ),
          budgets: () => config.socialBudgets ?? [],
          // #1569: the reply to the conversation that prompted a turn needs no
          // grant — the router's own conversation binding authorizes it.
        },
        policy.approval,
      ),
    );
    alarmIngress = automationAlarm(gateway, channelStores);
    await runAppBoot(runtime, automationClock(gateway, services.now,
      (error) => incident("automation window close failed", error)).pipe(
      Effect.forkIn(appScope), Effect.asVoid,
    ));
    // Bind the entity's composition-owned ports: turns run the Resident's
    // runner over the activation's kernel + fence; process-runner sessions
    // delegate to the child transport without committing under this fence.
    const resolvedRuntime: Core.ResolvedSessionRuntime = {
      ...sessionRuntime,
      clock: services.now,
      entropy: services.entropy.id,
      observations: services.observations,
      generations: services.generations,
      services: services.context,
    };
    services.entityPorts.bind({
      approvalPolicy: sessionRuntime.approvalPolicy, dispatchOutbound: Core.outboundRedrivePort(resolvedRuntime),
      runTurn: (input) =>
        sessionRunner(input.authority.sessionId) === "process"
          ? Effect.tryPromise({
              try: () => processSessions.wake(input.authority.sessionId),
              catch: foreignFailure((fields) => new AgentFailure(fields), "process.wake"),
            }).pipe(Effect.asVoid)
          : plane.turnPort(
              liveTurns.wrapRunner(
                input.authority.sessionId,
                resident.runnerFor(input.kernel.row(input.authority.sessionId)),
              ),
              resolvedRuntime,
              services.scope,
            )(input),
      requestDomainRevisions: domainRevisions,
      // An entity-path Resolve (the answer found no live turn) may land after
      // the activation it triggered recovered the open turn, which then parked
      // on the still-open request: the entity rings the live approval gate
      // after its commit, the same doorbell the direct answer path rings.
      onRequestReady: notifyLiveApprovals,
      // #1254 S4: the composed alarm capability the entity dispatches a
      // delivered non-reserved occurrence to; unbound it would fold every
      // native hit and timer tick to a recorded stale fact with zero execution.
      alarmCapability: alarmPlane,
      // #1254 H3: each activation registers its budgeted arm verb here — the
      // app-side capability path above delegates to it (one committing door).
      onLive: watchPlane.arms.onLive,
      // #1255 P3: the composed generation's deliver registrations and journal
      // kinds, read per call so a recompose (#1255 P4) propagates live.
      get inputRegistrations(): readonly string[] {
        return ["prompt", "signal", ...services.composed.current().generation.inputs];
      },
      get capabilityKinds(): readonly string[] {
        return Object.keys(services.composed.current().generation.kinds);
      },
      // #1254 H1: native handles follow committed arm rows — the watch plane
      // moves or closes the live source on each post-commit arm notice.
      onArmed: watchPlane.onArmed,
      // #1254 S3: an activation resends its armed occurrences through the
      // entity's own persisted Alarm door (occurrence id = cluster dedupe).
      // Persist-and-return (M3): a DeliverAt envelope only replies at
      // `fireAt`, so the resend walk must complete at the durable insert —
      // a reply-awaiting send would park the walk on the first future row.
      // Native-source chains are never time-delivered: their
      // send is the source (re)install (#1254 H2), whose permanent failures
      // are the typed refusal the entity retires on. Everything else is a
      // defect — the entity logs it and the armed row stands for the next
      // activation (recovery of last resort).
      sendAlarm: watchPlane.sendOccurrence((sessionId, occurrence) =>
        scheduleAlarm(sessionId, occurrence).pipe(Effect.orDie, Effect.asVoid),
      ),
    });

    // Boot alarm rescan (#1254 S3): wake every session that may hold armed
    // alarms with an entity-internal `rescan` occurrence. Idleness is the
    // session file's mtime; an in-memory plane has no idle sessions.
    {
      const sweep = resolveAlarmSweep(config);
      const bootNow = services.now();
      const lastActivityAt = (id: string): number => {
        if (config.sessionsDir === undefined) return bootNow;
        // Idleness is the session file's mtime; a missing file counts as
        // activity-now. Any other fs failure still fails the boot closed.
        return (
          statSync(sessionFilePath(config.sessionsDir, id), { throwIfNoEntry: false })?.mtimeMs ??
          bootNow
        );
      };
      const rescans = rescanOccurrences({
        armedSessionIds: plane.catalog.armedSessionIds(),
        sessions: plane.listSessions().map((row) => ({
          id: row.id,
          lastActivityAt: lastActivityAt(row.id),
        })),
        sweep,
        bootId: services.entropy.id(),
        now: bootNow,
      });
      for (const rescan of rescans) {
        await runAppBoot(
          runtime,
          sendAlarm(rescan.sessionId, rescan.occurrence).pipe(
            Effect.catchCause((cause) => Effect.sync(() => incident(`boot alarm rescan failed: ${rescan.sessionId}`, cause))),
            Effect.forkIn(appScope),
            Effect.asVoid,
          ),
        );
      }
    }

    await acquire(Effect.succeed(supervisor), (resource) =>
      Effect.tryPromise({
        try: () => resource.stopAll(),
        catch: lifecycleFailure("channels.close"),
      }),
    );
    await supervisor.reconcile();

    wsHandler = new WebSocketHandler(
      ({ sender, facts }) =>
        messages.ingest(sender, facts).pipe(
          Effect.flatMap((admission) =>
            admission.status === "blocked_pre"
              ? Effect.fail(
                  new ChannelsFailure({
                    operation: "message.admission",
                    cause: admission.reasonCode,
                  }),
                )
              : Effect.succeed(admission),
          ),
        ),
      services.observations.publish,
      {
        now: services.now,
        id: services.entropy.id,
        ...(config.wsToken === undefined ? {} : { token: config.wsToken }),
        onRequestAnswer: (sender, answer) => messages.ingest(sender, answer),
      },
    );

    const wsCallbacks = webSocketCallbacks(runtime, wsHandler, services.observations, (id) =>
      plane.catalog.sessionIndex(id) === undefined ? undefined : plane.openKernel(id),
      createSessionForkExecutor(plane, {
        sessionsDir: config.sessionsDir,
        now: services.now,
        id: services.entropy.id,
      }), { respond: automationWire(provisioningPort.automations), stores: channelStores }, host,
      { respond: channelWire(provisioningPort, services.now) });
    const server = Bun.serve({
      hostname: config.host,
      port: config.wsPort,
      websocket: wsCallbacks.callbacks,
      fetch: createHttpRoutes(wsHandler, (provider) => webhookHandlers.get(provider)),
    });

    if (server.port === undefined)
      throw new AppInvariantError("OpenOmni ws server did not bind a TCP port");
    const boundServer = server;
    const boundPort: number = server.port;
    await acquire(Effect.succeed(boundServer), (resource) =>
      Effect.tryPromise({
        try: () => resource.stop(true),
        catch: lifecycleFailure("websocket.close"),
      }),
    );
    /**
     * The live-turn facade (replaces the deleted registry handle): approvals
     * reach the turn running inside the entity's delivering RPC through the
     * composition's live plane and interrupts ride the entity's `Deliver`
     * door (#1346); only the `tools.add` configure commit still rides the
     * activation's borrowed authority (the one allow-listed app commit). Only
     * live turns have a handle - a hibernated entity session answers through
     * the entity client instead.
     */
    const borrowedAuthority = (id: string) => {
      const kernel = plane.openKernel(id);
      const row = kernel.row(id);
      if (row.fenceOwner === null)
        throw new AppInvariantError(`session has no activation authority: ${id}`);
      return { kernel, row, owner: row.fenceOwner, fence: row.fence };
    };
    const sessionFacade = (id: string): AppSessionHandle | undefined => {
      if (liveTurns.get(id) === undefined) return undefined;
      return {
        id,
        approvals: {
          pending: () => liveTurns.get(id)?.approvals?.pending() ?? [],
          answer: (answer) =>
            Effect.suspend(() => {
              const approvals = liveTurns.get(id)?.approvals;
              return approvals === undefined
                ? Effect.fail(new ExecutionApprovalError({ code: "stale_approval" }))
                : approvals.answer(answer);
            }),
        },
        // The mid-turn deadline seam (W5.2): a durable DeliverAt Deadline
        // serializes behind the running turn's own entity RPC, so a live
        // turn's request timeout rides the turn's own transition port (the
        // deleted controller handle's `requests.transition` path) and then
        // notifies the turn's live approval gate.
        requests: {
          timeout: (requestId, at) =>
            Effect.gen(function* () {
              const entry = liveTurns.get(id);
              if (entry?.ledger.transition === undefined)
                return yield* Effect.fail(
                  new ExecutionApprovalError({ code: "approval_authority_unavailable" }),
                );
              const decision = yield* entry.ledger.transition(
                { kind: "request.timeout", requestId },
                `${requestId}:deadline`,
                at,
              );
              if (decision.request !== undefined) entry.approvals?.notify?.(decision.request);
            }),
        },
        interrupt: () =>
          Effect.gen(function* () {
            const entry = liveTurns.get(id);
            if (entry === undefined) return;
            // The durable interrupt row first (cancellation is chain evidence),
            // then the turn's own boundary drain consumes it and aborts the wave.
            // #1346: the row lands through the session's one `Deliver` door as
            // a control `signal`; the entity's single writer owns the revision
            // CAS and the `running -> interrupted` transition, so the app
            // neither borrows the fence nor retries a commit. The RPC ack IS
            // the durable commit; the live turn holds its seal until this
            // interrupt has landed and drained, so an interrupt issued while
            // the turn is live always aborts it.
            const release = entry.hold();
            yield* entityClient(id)
              .Deliver({
                kind: "signal",
                body: JSON.stringify({ content: "", control: "interrupt" }),
                source: JSON.stringify({ kind: "session", id }),
                idempotencyKey: services.entropy.id(),
              })
              .pipe(
                Effect.flatMap(() => entry.boundary("before_llm")),
                Effect.mapError(
                  (error) => new AgentFailure({ operation: "session.interrupt", cause: interruptFailureCause(error) }),
                ),
                Effect.ensuring(Effect.sync(release)),
              );
          }),
        tools: {
          add: (additions) =>
            Effect.gen(function* () {
              const { kernel, row, owner, fence } = borrowedAuthority(id);
              const before = kernel.latestGenerationFor(id);
              const generation = before.generation + 1;
              const accepted = yield* sessionRuntime.authorizeConfigure({
                sessionId: id,
                role: row.role,
                operation: "tools.add",
                generation,
              });
              if (!accepted)
                return yield* Effect.fail(
                  new AgentFailure({ operation: "session.configure", cause: "denied" }),
                );
              const snapshot = Core.SessionHandleStore.generationSnapshot({
                generation,
                revertTo: before.generation,
                tools: [
                  ...before.tools,
                  ...additions.map((tool) => SessionGeneration.Tool.parse(tool)),
                ],
                system: { preset: before.systemPreset, blocks: before.systemBlocks },
                policyGeneration: before.policyGeneration,
                bundles: before.bundles,
                // #1255: configure keeps the adopted manifest hash — dropping it
                // would force a spurious compose adoption at next turn start.
                ...(before.manifestHash === undefined ? {} : { manifestHash: before.manifestHash }),
              });
              const configured = Core.SessionHandleStore.configureAction({
                id: services.entropy.id(),
                sessionId: id,
                parentId: kernel.latestAction(id)?.id ?? null,
                operation: "tools.add",
                snapshot,
                at: services.now(),
              });
              const commit = kernel
                .commit({
                  sessionId: id,
                  owner,
                  fence,
                  now: services.now(),
                  expectedRevision: row.revision,
                  actions: [configured],
                  state: row.state,
                  generation: {
                    toolsGeneration: snapshot.generation,
                    systemHash: snapshot.systemHash,
                    policyGeneration: snapshot.policyGeneration,
                  },
                })
                .pipe(
                  Effect.mapError(
                    foreignFailure((fields) => new AgentFailure(fields), "session.configure"),
                  ),
                );
              yield* services.generations.configure(
                { sessionId: id, generation },
                snapshot,
                commit,
              );
              return { generation: snapshot.generation, revertTo: snapshot.revertTo };
            }),
        },
      };
    };
    const stop = async () => {
      await boundServer.stop(true);
      await watchSources.closeAll();
      await supervisor.stopAll();
      await runAppEffect(runtime, shutdownSessions(sessionRuntime, recovery));
      if (cells !== undefined)
        await runAppEffect(
          runtime,
          cells.close().pipe(Effect.mapError(lifecycleFailure("shutdown.cell_unsettled"))),
        );
      // Shutdown join contract (W5.2 S4): the delivering entity RPC acks at
      // the durable turn boundary and the turn's remainder runs detached
      // under the activation, so a turn suspended in a protected tool wave
      // (open request, no answer) holds its captured generations — not its
      // frame — until interrupted. Interrupt every live turn through the
      // facade: the interrupt row, the wave's request.cancel and the
      // interrupted turn terminal are all durable chain commits (fail-closed
      // — a refused commit fails stop loud), after which each detached turn
      // unwinds and releases its generation before the drain below.
      await Promise.all(
        liveTurns.ids().map((id) => {
          const facade = sessionFacade(id);
          return facade === undefined
            ? Promise.resolve()
            : runAppEffect(runtime, facade.interrupt());
        }),
      );
      // Every accepted ws frame's ingest holds a captured ingress generation
      // until it unwinds; join them before the generation drain.
      await wsCallbacks.settled();
      // Join the interrupted detached turns: await every live generation
      // owner so dispose's fail-fast drain observes zero owners.
      await runAppEffect(
        runtime,
        Effect.flatMap(GenerationLayers, (generations) => generations.settle),
      );
      await runtime.dispose();
    };
    return {
      port: boundPort,
      gateway,
      sessions: { get: sessionFacade },
      childActivity: {
        install: (spec: ChildWatch) => runAppEffect(runtime, watchPlane.installChild(
          ChildWatch.parse(spec), services.composed.current().generation.bundles.includes("child-activity"),
        )),
        close: (id: string) => watchSources.close(id),
        observe: (sessionId: string, id: string) => watchSources.observe(sessionId, id),
        state: (sessionId: string, child: string, turn: string) =>
          currentState(stateReceipts(childRows(sessionId), child, turn)),
      },
      // The boot's honest channel record: where config came from and why each
      // declared row did or did not mount (provision_status reads this later).
      channels: { source: liveSupervisor().source(), statuses: liveSupervisor().status() },
      runtime,
      stop: retryableOnce(stop),
    };
  };
  const outcome = await boot().then(
    Result.succeed,
    ThrownError.transform((cause) => Result.fail(cause)).parse,
  );
  if (Result.isFailure(outcome)) {
    await runtime.dispose().catch((disposal: Error) => {
      throw new AggregateError([outcome.failure, disposal], "app boot and disposal failed");
    });
    throw outcome.failure;
  }
  return outcome.success;
}

/**
 * Entry-point shutdown wiring, extracted behind seams so tests can drive it
 * deterministically. The handler awaits the full async stop before any exit.
 */
export function installShutdownHandlers(deps: {
  readonly stop: () => Promise<void>;
  readonly exit: (code: number) => void;
  readonly on: (signal: "SIGINT" | "SIGTERM", handler: () => void) => void;
}): void {
  let stopping = false;
  const handler = () => {
    if (stopping) return;
    stopping = true;
    void deps.stop().then(
      () => deps.exit(0),
      (error: Error) => {
        console.error("app shutdown incident", error);
        deps.exit(1);
      },
    );
  };
  deps.on("SIGINT", handler);
  deps.on("SIGTERM", handler);
}

/**
 * The composition-owned live session handle (W5.2): the subset of the deleted
 * registry `SessionHandle` a live entity turn can honestly serve. `get`
 * returns one only while a turn is running - a hibernated entity session has
 * no live surface, its interaction is the entity client's mailbox.
 */
export interface AppSessionHandle {
  readonly id: string;
  readonly approvals: SessionHandle["approvals"];
  readonly requests: {
    timeout(requestId: string, at: number): Effect.Effect<void, Core.ExecutionError>;
  };
  interrupt(): Effect.Effect<void, Core.SessionError>;
  readonly tools: {
    add: SessionHandle["tools"]["add"];
  };
}

function processSessionPromptOptions(
  config: Pick<OpenOmniConfig, "hooksPath" | "policyPath" | "promptsDir" | "skillsDir" | "off">,
) {
  return {
    ...(config.hooksPath === undefined ? {} : { hooksPath: config.hooksPath }),
    ...(config.policyPath === undefined ? {} : { policyPath: config.policyPath }),
    ...(config.promptsDir === undefined ? {} : { promptsDir: config.promptsDir }),
    ...(config.skillsDir === undefined ? {} : { skillsDir: config.skillsDir }),
    ...(config.off === undefined ? {} : { off: [...config.off] }),
  };
}
