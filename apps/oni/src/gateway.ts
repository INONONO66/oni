import type { ComputerHandle, MachineHost } from "@oni/machines";
import { machineWire } from "./composition/machine-wire";
import { createStreamProbe } from "./composition/stream-probe";
import { channelHistoryWire, type ChannelHistoryLookup } from "./composition/channel-history";
import type { WsParts } from "./composition/ws-parts";
import type { ComposedCodemode } from "./composition/codemode";
import type { ToolPorts } from "./composition/catalog";
import type { createCompletionPort } from "./composition/completion";
import {
  type ChannelDeliveryRoute,
  type ChannelStores,
  createGatewayRouter,
  type GatewayRouter,
  webSocketSenderTier,
  type WebSocketHandler,
  type WsConnection,
} from "@oni/channels";
import { type ChannelError, decodeChannelFailure, type ChannelStoreSource } from "@oni/channels";
import { Core, type Bundle, Inspect } from "@oni/agent";
import type { ChannelGrantStore } from "@oni/channels";
import type { Actor, Gateway, Ingress, LedgerAction } from "@oni/protocol";
const Entropy = Core.Entropy;
const GenerationLayers = Core.GenerationLayers;
const ObservationSink = Core.ObservationSink;
const currentInvocation = Core.currentInvocation;
type SessionEntryServices = Core.SessionEntryServices;
const createSessionRequests = Core.createSessionRequests;
const AgentFailure = Core.AgentFailure;
const scopeObservation = Core.scopeObservation;
const attemptUsage = Inspect.attemptUsage;
const toolWallMs = Inspect.toolWallMs;
import { Gateway as GatewayProtocol, L0Observation, type Provisioning, SessionGeneration, type PlainValue, type SessionFork, SessionRead, toolOutputRefSchema } from "@oni/protocol";
import { messageDecisionRules } from "./composition/message-decision";
import { createIngressExecutor, GATEWAY_INGRESS_SESSION } from "./composition/ingress-executor";
import { SHIPPED_OWNER_POLICY } from "./composition/policy";
import { outboundMessage } from "./composition/terminal-message";
import { type Context, Effect, Result, Exit, ManagedRuntime, Scope } from "effect";
import { AppLedger, type AppLedgerPlane } from "./composition/cluster-runtime";
import type { ComposedGeneration } from "./composition/composed";
import { captureNow } from "./composition/platform";
import { createAlarmMonitorPorts } from "./bundles/alarms/index";
import { MonitorRefused, type MonitorPorts } from "./bundles/alarms/monitor/ports";
import {
  AppLifecycleFailure,
  AppLive,
  AppScope,
  type AppRuntime,
  type AppRuntimeOptions,
  type AppServices,
} from "./runtime";

let processRuntime: AppRuntime | undefined;

export function gatewayRuntime(options: AppRuntimeOptions): AppRuntime {
  if (processRuntime !== undefined) return processRuntime;
  const runtime = ManagedRuntime.make(AppLive(options));
  const dispose = runtime.dispose.bind(runtime);
  const disposeEffect = runtime.disposeEffect;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  Object.assign(runtime, {
    disposeEffect: disposeEffect.pipe(Effect.ensuring(Effect.sync(() => {
      disposed = true;
      if (processRuntime === runtime) processRuntime = undefined;
    }))),
    dispose: () => {
      if (disposed) {
        disposal ??= dispose();
        return disposal;
      }
      disposal ??= runAppEffect(runtime, Effect.flatMap(GenerationLayers, (generations) => generations.drain).pipe(
        Effect.mapError((error) => new AppLifecycleFailure({ operation: "shutdown.raw_unsettled", cause: String(error) })),
      )).catch((error: Error) => { disposal = undefined; throw error; }).then(() => dispose().finally(() => {
        if (processRuntime === runtime) processRuntime = undefined;
      }));
      return disposal;
    },
  });
  processRuntime = runtime;
  return runtime;
}

export function runAppEffect<A, E>(
  runtime: AppRuntime,
  effect: Effect.Effect<A, E, AppServices>,
  signal?: AbortSignal,
): Promise<A> {
  return runtime.runPromise(Effect.result(effect), { signal }).then((result) => {
    if (Result.isFailure(result)) throw result.failure;
    return result.success;
  });
}

export function acquireAppResource<A, E>(
  runtime: AppRuntime,
  effect: Effect.Effect<A, E, Scope.Scope | AppServices>,
): Promise<A> {
  return runAppEffect(
    runtime,
    Effect.flatMap(AppScope, (scope) => Scope.provide(effect, scope)),
  );
}

export async function runAppBoot<A, E>(
  runtime: AppRuntime,
  effect: Effect.Effect<A, E, AppServices>,
): Promise<A> {
  const exit = await runtime.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Core.fromCause(
    exit.cause,
    (cause) => new AppLifecycleFailure({ operation: "app.boot", cause }),
  );
  console.error("app boot incident", failure);
  await runtime.dispose().catch((disposal: Error) => {
    throw new AggregateError([failure, disposal], "app boot and disposal failed");
  });
  throw failure;
}

export function toolPorts(
  runtime: AppRuntime,
  ports: {
    readonly machines?: { readonly host: MachineHost; readonly defaultMachine: string };
    readonly cells?: ComposedCodemode;
    readonly completion: ReturnType<typeof createCompletionPort>;
    readonly messages: Pick<GatewayRouter, "ingest">;
    /** Injected clock + id entropy (#1245): required, no ambient Date/crypto. */
    readonly now: () => number;
    readonly id: () => string;
  },
): ToolPorts {
  const cells = ports.cells;
  const machines = ports.machines;
  return {
    provisioning: undefined,
    clock: ports.now,
    id: ports.id,
    machines:
      machines === undefined
        ? undefined
        : {
            defaultMachine: machines.defaultMachine,
            get: (id) => {
              const handle = machines.host.get(id);
              return {
                fs: {
                  read: (path, window) => runAppEffect(runtime, handle.fs.read(path, window)),
                  write: (path, data, options) => runAppEffect(runtime, handle.fs.write(path, data, options)),
                  list: (path) => runAppEffect(runtime, handle.fs.list(path)),
                  stat: (path) => runAppEffect(runtime, handle.fs.stat(path)),
                },
                exec: (cmd, cwd) => runAppEffect(runtime, handle.exec(cmd, cwd)),
                pty: {
                  open: (name, cwd) => runAppEffect(runtime, handle.pty.open(name, cwd)),
                  write: (name, data) => runAppEffect(runtime, handle.pty.write(name, data)),
                  read: (name, options) => runAppEffect(runtime, handle.pty.read(name, options)),
                },
              };
            },
          },
    cells:
      cells === undefined
        ? undefined
        : {
            cell: {
              run: (code, tenant, options) =>
                runAppEffect(runtime, cells.cell.run(code, tenant, options), options.signal),
              peek: (id, tenant) => runAppEffect(runtime, cells.cell.peek(id, tenant)),
              stop: (id, tenant) => runAppEffect(runtime, cells.cell.stop(id, tenant)),
            },
          },
    llm: (call) => runAppEffect(runtime, currentInvocation().generation.provide(ports.completion(call))),
    messages: { ingest: (...args) =>
      runAppEffect(runtime, ports.messages.ingest(...args).pipe(
        Effect.provideService(Core.ExecutorContext, Core.currentExecutor()),
      )),
    },
  };
}

/** Phase inputs captured from the kernel BEFORE the final consistency check. */
interface PhaseSources {
  readonly terminal: ReturnType<Core.SessionReadModel["latestTurnTerminal"]>;
  readonly latest: ReturnType<Core.SessionReadModel["latestAction"]>;
  readonly openTurnIntent: ReturnType<Core.SessionReadModel["actionById"]>;
  readonly genesis: ReturnType<Core.SessionReadModel["latestAction"]>;
}

/**
 * The emitted phase and when it began. phaseSince is the durable transition
 * that ESTABLISHED the phase: the current open turn's intent for running, the
 * terminal that recorded the interruption or sealed the turn for
 * terminal-derived phases, and genesis for a bare idle session. Never the
 * latest activity or a previous turn's terminal, which would move within one
 * phase or predate the current turn (review r1 finding 6). Pure over facts
 * captured before the final fence/revision consistency check: a fresh kernel
 * read here could pair an old page with a NEWER turn's phase timestamp
 * (review r2 finding 7), so this function reads no kernel at all.
 */
function phaseFacts(
  state: SessionRead.Page["state"],
  sources: PhaseSources,
): { phase: SessionRead.Page["phase"]; phaseSince: number } {
  if (state === "running")
    return { phase: state, phaseSince: sources.openTurnIntent?.ts ?? sources.latest?.ts ?? 0 };
  if (state === "interrupted") {
    const terminal = sources.terminal;
    const sealed = terminal?.effect.kind === "interrupted" ? terminal.action.ts : undefined;
    return { phase: state, phaseSince: sealed ?? sources.latest?.ts ?? 0 };
  }
  if (sources.terminal !== undefined) {
    const phase = sources.terminal.effect.kind === "result" ? "completed"
      : sources.terminal.effect.kind === "error" ? "failed"
      : sources.terminal.effect.kind === "waiting" ? "waiting_input" : "idle";
    return { phase, phaseSince: sources.terminal.action.ts };
  }
  return { phase: "idle", phaseSince: sources.genesis?.ts ?? 0 };
}

/** #1305: the one place a page row's stored-output ref is read off the chain. */
const PAGE_OUTPUT_REF = toolOutputRefSchema();
function outputRefOf(action: {
  readonly effect: { readonly value: PlainValue };
}): { outputRef: ReturnType<typeof PAGE_OUTPUT_REF.parse> } | undefined {
  const effect = action.effect.value;
  if (effect === null || typeof effect !== "object" || Array.isArray(effect)) return undefined;
  const toolResult = effect.toolResult;
  const details =
    toolResult !== null && typeof toolResult === "object" && !Array.isArray(toolResult)
      ? toolResult.details
      : undefined;
  for (const carrier of [effect.result, details]) {
    if (carrier === null || carrier === undefined || typeof carrier !== "object" || Array.isArray(carrier)) continue;
    const parsed = PAGE_OUTPUT_REF.safeParse(carrier.outputRef);
    if (parsed.success) return { outputRef: parsed.data };
  }
  return undefined;
}

/**
 * The history page is one transactional revision snapshot. Session action rows
 * are retained from genesis, so a valid old cursor is always repairable by
 * paging; an epoch change or a cursor ahead of the durable head is a typed gap.
 */
export function readSessionCursor(
  kernel: Core.SessionReadModel,
  input: SessionRead.Request,
  readSession?: (sessionId: string) => Core.SessionReadModel | undefined,
): SessionRead.Response {
  const frame = SessionRead.Request.parse(input);
  const before = kernel.row(frame.sessionId);
  const afterRevision = frame.cursor?.revision ?? 0;
  if (frame.cursor !== undefined &&
      (frame.cursor.epoch !== before.fence || afterRevision > before.revision)) {
    return {
      type: "session_gap" as const,
      sessionId: frame.sessionId,
      epoch: before.fence,
      headRevision: before.revision,
      oldestRevision: 0,
    };
  }
  const page = kernel.historyPage(frame.sessionId, { afterRevision, limit: frame.limit });
  const terminal = kernel.latestTurnTerminal(frame.sessionId);
  const latest = kernel.latestAction(frame.sessionId);
  // Review r2 finding 7: capture every phase fact BEFORE the final
  // consistency check below. A commit that lands during these reads moves the
  // after-row revision and surfaces as the typed gap; a commit that lands
  // after the check can no longer leak a newer turn's timestamp into this page.
  const openTurn = kernel.latestOpenTurn(frame.sessionId);
  const openTurnIntent = openTurn === undefined ? undefined : kernel.actionById(openTurn.turnId);
  const genesis = kernel.latestAction(frame.sessionId, 1);
  const after = kernel.row(frame.sessionId);
  if (before.fence !== after.fence || before.revision !== page.headRevision ||
      after.revision !== page.headRevision ||
      (page.actions[0] !== undefined && page.actions[0].ordinal !== afterRevision + 1)) {
    return {
      type: "session_gap" as const,
      sessionId: frame.sessionId,
      epoch: after.fence,
      headRevision: after.revision,
      oldestRevision: 0,
    };
  }
  const { phase, phaseSince } = phaseFacts(after.state, { terminal, latest, openTurnIntent, genesis });
  return SessionRead.Page.parse({
    type: frame.cursor === undefined ? "session_snapshot" as const : "session_page" as const,
    sessionId: frame.sessionId,
    state: after.state,
    phase,
    phaseSince,
    epoch: after.fence,
    afterRevision,
    headRevision: page.headRevision,
    nextRevision: page.nextRevision,
    actions: page.actions.map((action) => ({
      revision: action.ordinal,
      actionId: action.id,
      kind: action.kind,
      at: action.ts,
      // Fork boundary anchors: the action ids a session_fork.at may cite.
      ...(Core.isForkBoundary(action) ? { forkAnchor: action.id } : {}),
      // #1305: surface a projected row's stored-output reference to readers.
      ...(outputRefOf(action) ?? {}),
    })),
    usage: attemptUsage(page.actions),
    // Fork ancestry projection (#1257): read off the genesis configure this
    // page already captured; inspect surface only, never model context. A
    // session with no ancestry facts (no parent edge, no fork pin) omits the
    // key entirely, keeping pre-#1257 pages byte-identical on the wire.
    ...ancestryField(after.parentId, genesis),
    // Fork children projection (#1257): the inspect tree's direct children
    // (catalog parent edges + each child genesis pin); inspect surface only.
    ...childrenField(kernel, frame.sessionId, readSession),
    toolWallMs: toolWallMs(page.actions.flatMap((action) => {
      if (action.kind !== "tool" || action.parentId === null) return [];
      const effect = action.effect.value;
      if (effect === null || typeof effect !== "object" || Array.isArray(effect) ||
          effect.phase !== "result") return [];
      const intent = kernel.actionById(action.parentId);
      return intent?.kind === "tool" ? [{ start: intent.ts, end: action.ts }] : [];
    })),
  });
}

/**
 * Fork children projection for one page (#1257): the same parent->child edges
 * `Inspect.inspectTree` renders, flattened to one depth level. A child whose
 * kernel cannot open is skipped rather than failing the parent's read; a
 * commissioned (non-fork) child carries no anchor. Absent `readSession`
 * (direct reader callers) omits the key.
 */
function childrenField(
  kernel: Core.SessionReadModel,
  sessionId: string,
  readSession?: (childId: string) => Core.SessionReadModel | undefined,
): { children?: NonNullable<SessionRead.Page["children"]> } {
  if (readSession === undefined) return {};
  const children = kernel.childSessionsPage(sessionId, "", 64).flatMap((row) => {
    const child = readSession(row.id);
    if (child === undefined) return [];
    const forkedFrom = Inspect.forkAncestryOf(child, row.id);
    return [{ sessionId: row.id, ...(forkedFrom === null ? {} : { anchor: forkedFrom.anchor }) }];
  });
  return children.length === 0 ? {} : { children };
}

/** Fork ancestry projection for one page (#1257): genesis pin plus aside text. */
function ancestryField(
  parentId: string | null,
  genesis: LedgerAction.Node | undefined,
): { ancestry?: NonNullable<SessionRead.Page["ancestry"]> } {
  const value = genesis?.kind === "session.configure" ? genesis.intent.value : undefined;
  const holder = value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  const parsed = SessionGeneration.ForkAncestry.safeParse(holder?.forkedFrom);
  const forkedFrom = parsed.success ? parsed.data : null;
  if (parentId === null && forkedFrom === null) return {};
  return {
    ancestry: { parentId, forkedFrom, aside: forkedFrom === null ? null : Inspect.forkAside(forkedFrom) },
  };
}

export function webSocketCallbacks(
  runtime: AppRuntime,
  handler: WebSocketHandler,
  sink: Context.Service.Shape<typeof ObservationSink>,
  openSession?: (sessionId: string) => Core.SessionReadModel | undefined,
  fork?: (request: SessionFork.Request) => Effect.Effect<SessionFork.Response>,
  automation?: {
    readonly respond: (request: Ingress.AutomationRequest, caller: "owner" | `session:${string}`) =>
      Effect.Effect<Ingress.AutomationResponse>;
    readonly stores: ChannelStores;
  },
  machines?: Pick<MachineHost, "list"> & {
    readonly get: (machineId: string) => { readonly computer?: Pick<ComputerHandle, "stream"> };
  },
  /** #1569 lane 5b: the Owner's channel declaration (the login helper's seal) over the Owner's socket. */
  channels?: {
    readonly respond: (request: Provisioning.ChannelDeclareRequest, caller: "owner" | `session:${string}`) =>
      Effect.Effect<Provisioning.ChannelDeclareResponse>;
  },
  parts?: WsParts,
  history?: ChannelHistoryLookup,
  now?: () => number,
) {
  const inflight = new Set<Promise<void>>();
  const readers = new Map<WsConnection, Map<string, () => void>>();
  // Session-indexed re-send hooks (#1257 r4 H-1): a fork writes no parent
  // action, so no ActionCommittedEvent ever refreshes a subscribed parent.
  // A successful fork re-sends every parent subscriber's page instead; the
  // same-head page carries the new catalog child in `children`.
  const refreshers = new Map<string, Set<() => void>>();
  const probe = machines === undefined || now === undefined ? undefined : createStreamProbe({
    now,
    open: (machineId, display, listeners) => {
      const computer = machines.get(machineId).computer;
      if (computer === undefined) return Promise.resolve({ status: "refused" as const, reason: "stream_not_available" as const });
      return runAppEffect(runtime, computer.stream.open({
        source: { kind: "display", display },
        video: { maxFps: 30, keyframeIntervalMs: 500, maxBitrateBps: 2_000_000, maxDimension: 640, maxFrameBytes: 1_000_000 },
        dataChannel: true,
        lifetimeMs: 120_000,
      }, listeners)).then((opened) => "status" in opened ? opened : ({
        streamId: opened.streamId,
        capturedAt: opened.capturedAt,
        signal: (signal) => runAppEffect(runtime, opened.signal(signal)),
        close: () => runAppEffect(runtime, opened.close()),
      }));
    },
  });
  function read(ws: WsConnection, request: SessionRead.Request): void {
    const subscriptions = readers.get(ws) ?? new Map<string, () => void>();
    readers.set(ws, subscriptions);
    subscriptions.get(request.sessionId)?.();
    let cursor = request.cursor;
    let sentRevision = cursor?.revision ?? 0;
    const send = () => {
      try {
        const kernel = openSession?.(request.sessionId);
        if (kernel === undefined) {
          ws.send(JSON.stringify({ type: "error", reason: "session_not_found", sessionId: request.sessionId }));
          return;
        }
        const response = readSessionCursor(kernel, { ...request, cursor }, openSession);
        if (response.type !== "session_gap") {
          sentRevision = response.actions.at(-1)?.revision ?? response.afterRevision;
          cursor = { revision: sentRevision, epoch: response.epoch };
        }
        ws.send(JSON.stringify(response));
      } catch {
        ws.send(JSON.stringify({ type: "error", reason: "session_read_failed", sessionId: request.sessionId }));
      }
    };
    const pool = refreshers.get(request.sessionId) ?? new Set<() => void>();
    refreshers.set(request.sessionId, pool);
    pool.add(send);
    // Register before capture; notifications only hint at authoritative reads.
    const unsubscribe = sink.subscribe(L0Observation.ActionCommittedEvent, (event) => {
      if (event.revision > sentRevision) send();
    }, { match: { sessionId: request.sessionId } });
    subscriptions.set(request.sessionId, () => {
      unsubscribe();
      pool.delete(send);
      if (pool.size === 0) refreshers.delete(request.sessionId);
    });
    send();
  }
  // #1456: the same fact chat admits the Owner by (registered identity,
  // else the ws bootstrap grant), without registering one.
  const wsCaller = (externalId: string): "owner" | `session:${string}` =>
    automation !== undefined && webSocketSenderTier(automation.stores, externalId) === "owner"
      ? "owner"
      : `session:ws:${externalId}`;
  // #1569 lane 5b: the Owner's channel declaration is answered by the composed
  // wire; a perimeter refusal (malformed frame) goes back as it is.
  const channelWireResponse = (
    outcome: Provisioning.ChannelDeclareRequest | Provisioning.ChannelDeclareRefused,
    caller: "owner" | `session:${string}`,
  ): Effect.Effect<Provisioning.ChannelDeclareResponse> =>
    outcome.type === "channel_add_refused"
      ? Effect.succeed(outcome)
      : (channels?.respond(outcome, caller) ??
        Effect.succeed<Provisioning.ChannelDeclareResponse>({
          type: "channel_add_refused",
          requestId: outcome.requestId,
          reason: "store_unconfigured",
          detail: "provisioning is not composed",
        }));
  return {
    callbacks: {
      ...handler.ws,
      close(ws: WsConnection): void {
        for (const stop of readers.get(ws)?.values() ?? []) stop();
        readers.delete(ws);
        if (probe !== undefined) {
          const closing = probe.close(ws).catch((error) => {
            console.error("stream probe close failed", error);
          });
          inflight.add(closing);
          void closing.finally(() => inflight.delete(closing));
        }
        handler.ws.close(ws);
      },
      async message(ws: WsConnection, data: string | Buffer): Promise<void> {
        if (probe !== undefined && await probe.handle(ws, data, ws.data.authenticated)) return;
        const historyRead = channelHistoryWire(data, {
          authenticated: ws.data.authenticated === true,
          caller: wsCaller(ws.data.externalId),
        }, history ?? (() => ({ status: "refused", reason: "owner_not_ready" })));
        if (historyRead !== undefined) {
          return runtime.runPromise(historyRead).then((frame) => {
            ws.send(JSON.stringify(frame));
          });
        }
        const machine = machineWire(data, machines);
        if (machine !== undefined) {
          ws.send(JSON.stringify(machine));
          return Promise.resolve();
        }
        const captured = parts?.capture(ws.data.externalId, data);
        if (captured !== undefined && "type" in captured) {
          ws.send(JSON.stringify(captured));
          return Promise.resolve();
        }
        const settled = runtime.runPromise(
          handler.handleFrame(ws.data, data).pipe(
            Effect.matchEffect({
              onSuccess: (outcome) => {
                if ("type" in outcome && (outcome.type === "channel_add" || outcome.type === "channel_add_refused")) {
                  return Effect.map(channelWireResponse(outcome, wsCaller(ws.data.externalId)), (frame) =>
                    ws.send(JSON.stringify(frame)),
                  );
                }
                if ("type" in outcome &&
                    (outcome.type === "automation_add" || outcome.type === "automation_remove" ||
                     outcome.type === "automation_enable" || outcome.type === "automation_disable" ||
                     outcome.type === "automation_list" || outcome.type === "automation_ledger")) {
                  return Effect.map(
                    automation?.respond(outcome, wsCaller(ws.data.externalId)) ??
                      Effect.succeed<Ingress.AutomationResponse>({
                        type: `${outcome.type}_refused`, requestId: outcome.requestId,
                        reason: "store_unconfigured", detail: "Automation store is not configured",
                      }),
                    (frame) => ws.send(JSON.stringify(frame)),
                  );
                }
                // #1257: the fork program runs on this edge's app runtime (W5.3
                // effect boundary); unavailability is a typed refusal.
                if (!("admitted" in outcome) && outcome.type === "session_fork") {
                  const response =
                    fork?.(outcome) ??
                    Effect.succeed<SessionFork.Response>({
                      type: "session_fork_refused",
                      sessionId: outcome.sessionId,
                      reason: "storage",
                      detail: "fork is not available on this gateway",
                    } satisfies SessionFork.Refused);
                  return Effect.map(response, (frame) => {
                    ws.send(JSON.stringify(frame));
                    // #1257 r4 H-1: the parent chain did not grow, so push the
                    // refreshed parent page (new `children`) to its subscribers.
                    if (frame.type !== "session_forked") return;
                    for (const refresh of refreshers.get(frame.parentId) ?? []) refresh();
                  });
                }
                return Effect.sync(() => {
                  // A keyless frame is a perimeter refusal (#1245) — report it verbatim.
                  if ("admitted" in outcome) ws.send(JSON.stringify(outcome));
                  else if (outcome.type === "session_read") read(ws, outcome);
                  else ws.send(JSON.stringify(outcome));
                });
              },
              // #1600 lane R3: a refusal names its operation and cause on the wire, not only its tag.
              onFailure: (error) =>
                Effect.sync(
                  () =>
                    void ws.send(
                      JSON.stringify({
                        type: "error",
                        reason: error._tag,
                        ...(error._tag === "ChannelsFailure"
                          ? { operation: error.operation, cause: error.cause, message: error.message }
                          : {}),
                      }),
                    ),
                ),
            }),
          ),
        );
        const tracked: Promise<void> = settled
          .catch(() => undefined)
          .finally(() => {
            captured?.release();
            inflight.delete(tracked);
          });
        inflight.add(tracked);
        return settled;
      },
    },
    /**
     * Shutdown join (W5.2): an accepted frame's ingest captures the
     * gateway-ingress generation for the whole ingest, so the generation
     * drain must not start before every in-flight frame has unwound.
     */
    settled(): Promise<void> {
      return Promise.all([...inflight]).then(() => undefined);
    },
  };
}

/** The alarm plane's tool ports: capability verbs over chain facts (#1254). */
export async function createMonitorPorts(
  runtime: AppRuntime,
  capability: Bundle.AlarmCapabilityDefinition,
): Promise<MonitorPorts> {
  const { plane, clock, entropy } = await runAppBoot(
    runtime,
    Effect.gen(function* () {
      return {
        plane: yield* AppLedger,
        clock: yield* captureNow,
        entropy: yield* Entropy,
      };
    }),
  );
  return createAlarmMonitorPorts({
    capability,
    readSession: plane.read.session,
    clock,
    entropy: entropy.id,
    run: <A>(effect: Effect.Effect<A, Error>, signal: AbortSignal): Promise<A> =>
      runtime.runPromise(Effect.result(effect), { signal }).then((result) => {
        if (Result.isFailure(result)) throw new MonitorRefused(result.failure);
        return result.success;
      }),
  });
}

/**
 * The tier a named channel surface mounts with when no Owner decision
 * declares one (#931): the least authority the protocol tier vocabulary
 * carries. Mounting is not an authority decision — a surface that merely
 * exists grants the weakest standing there is, and every raise above it is
 * an explicit declaration (`ChannelInstance.grant.defaultTier`).
 */
export const MOUNTED_CHANNEL_DEFAULT_TIER: Actor.TrustTier = "assigned_worker";

/**
 * The one owner-tier decision this app makes (#931): the loopback `ws`
 * bootstrap surface (docs/provisioning-and-providers.md §6), token-gated off
 * loopback by `assertWsExposure`. It is named here so the single call site
 * that holds it is greppable and no other caller can inherit it.
 */
const LOOPBACK_BOOTSTRAP_TIER: Actor.TrustTier = "owner";

/** The authority one surface's trusted-channel grant materializes. */
export interface TrustedChannelGrant {
  readonly surface: string;
  /**
   * The tier senders on this surface resolve to when they carry no registered
   * identity. Always explicit: owner authority exists only where a call site
   * names it (the loopback `ws` bootstrap).
   */
  readonly defaultTier: Actor.TrustTier;
  readonly allowedSenders?: readonly string[];
  /** Channel messages route only when they address the Resident; DMs always do. */
  readonly mentionOnly?: boolean;
  /** An Owner instance reads this platform (#1569 lane 6): a mention of the Owner addresses the Resident. */
  readonly ownerIntake?: boolean;
}

/**
 * Registers the Resident's trusted-channel authority for one surface and
 * returns the revoker. A channel component holds this while mounted: the
 * grant exists exactly as long as the component serves the surface, so an
 * unmounted channel's inbound traffic loses `trusted_channel` treatment and
 * the perimeter refuses it fail-closed. Grants are current authority, not
 * history — revoking one erases no recorded fact.
 */
export function registerTrustedChannelGrant(
  grants: ChannelGrantStore,
  grant: TrustedChannelGrant,
): () => void {
  const id = `oni-resident-${grant.surface}`;
  grants.put({
    id,
    surface: grant.surface,
    kind: "trusted_channel",
    defaultTier: grant.defaultTier,
    // An allowlisted grant materializes this tier for the listed senders
    // alone — everyone else on the surface finds no grant and is blocked.
    ...(grant.allowedSenders === undefined ? {} : { allowedSenders: [...grant.allowedSenders] }),
    ...(grant.mentionOnly === undefined ? {} : { mentionOnly: grant.mentionOnly }),
    ...(grant.ownerIntake === undefined ? {} : { ownerIntake: grant.ownerIntake }),
    createdBy: "local-owner",
  });
  return () => {
    grants.remove(id);
  };
}

/**
 * THE grant seam the composition root hands the channel supervisor (#931):
 * the surface's tier is whatever its desired row declared, the configured
 * allowlist pins the grant to its listed senders (an unlisted surface keeps
 * the open posture), and a surface listed as mention-only routes channel
 * messages only when they address the Resident. Owner authority cannot enter
 * here — this function names no tier of its own, so no mounted named surface
 * can acquire one.
 */
export function createMountedChannelGrantRegistrar(
  grants: ChannelGrantStore,
  allowedSendersBySurface: Readonly<Record<string, readonly string[]>> | undefined,
  mentionOnlySurfaces: readonly string[] | undefined = undefined,
): (
  surfaceId: string,
  defaultTier: Actor.TrustTier,
  ownerIntake?: boolean,
  /** #1600: what the declarations themselves say; an env list stands only where no declaration speaks. */
  policy?: { readonly allowedSenders?: readonly string[]; readonly mentionOnly?: boolean },
) => () => void {
  return (surfaceId, defaultTier, ownerIntake, policy) => {
    const allowedSenders = policy?.allowedSenders ?? allowedSendersBySurface?.[surfaceId];
    const mentionOnly = policy?.mentionOnly ?? (mentionOnlySurfaces?.includes(surfaceId) === true ? true : undefined);
    return registerTrustedChannelGrant(grants, {
      surface: surfaceId,
      defaultTier,
      ...(allowedSenders === undefined ? {} : { allowedSenders }),
      ...(mentionOnly === true ? { mentionOnly: true } : {}),
      ...(ownerIntake === true ? { ownerIntake: true } : {}),
    });
  };
}

export interface OutboundMessaging {
  readonly deliveryRoutes: ReadonlyMap<string, ChannelDeliveryRoute>;
  readonly grants: () => readonly Gateway.SenderTargetGrant[];
  readonly budgets?: () => readonly Gateway.SocialBudget[];
  /** #1569 lane 7: the `<platform>:owner` surfaces whose declaration lets the reply door answer through the account. */
  readonly autoReplies?: () => ReadonlySet<string>;
}

/** One synchronous ledger unit on the ingress session file (decision facts live there), resolved per use. */
export function channelTransaction(
  plane: AppLedgerPlane,
): <A>(operation: Effect.Effect<A, ChannelError>) => Effect.Effect<A, ChannelError> {
  return (operation) =>
    Effect.try({
      try: () =>
        plane.session(GATEWAY_INGRESS_SESSION).transaction(() =>
          Result.getOrThrowWith(Effect.runSync(Effect.result(operation)), (error) => error),
        ),
      catch: decodeChannelFailure("message.transaction"),
    });
}

/** The perimeter's store source over the app plane (#1317): the channels-owned store plus the ingress session's decision facts. */
export function channelStoreSource(plane: AppLedgerPlane, now: () => number): ChannelStoreSource {
  const ingress = plane.session(GATEWAY_INGRESS_SESSION);
  return {
    now,
    actorRegistry: plane.channel.actorRegistry,
    automation: plane.channel.automation,
    blacklist: plane.channel.blacklist,
    channelGrant: plane.channel.channelGrant,
    egressBudget: plane.channel.egressBudget,
    surfaceKey: plane.channel.surfaceKey,
    get decisionFacts() {
      return ingress.decisions;
    },
    transaction: ingress.transaction,
  };
}

export function channelRequests(
  requests: Effect.Success<ReturnType<typeof createSessionRequests>>,
): Parameters<typeof createGatewayRouter>[0]["requests"] {
  return {
    list: requests.list,
    open: (input) =>
      requests.open(input).pipe(Effect.mapError(decodeChannelFailure("request.open"))),
    answer: (input) =>
      requests.answer(input).pipe(Effect.mapError(decodeChannelFailure("request.answer"))),
    receipt: (input) =>
      requests.receipt(input).pipe(Effect.mapError(decodeChannelFailure("request.receipt"))),
  };
}

export function createResidentGateway(
  // #1312: `requests`, `stores` and `messaging` are required composition
  // ports — omitting one is a compile error, never a silently filled default.
  // `messaging: undefined` stays expressible for gateways without outbound
  // delivery, but the caller must write it.
  ports: Omit<
    Parameters<typeof createGatewayRouter>[0],
    "sink" | "run" | "messaging" | "transaction" | "stores"
  > & {
    readonly stores: NonNullable<Parameters<typeof createGatewayRouter>[0]["stores"]>;
  },
  messaging: OutboundMessaging | undefined,
  approvalPolicy: Core.ApprovalPolicy = SHIPPED_OWNER_POLICY.approval,
): Effect.Effect<GatewayRouter, Core.ExecutionError, SessionEntryServices | ComposedGeneration | AppLedger> {
  return Effect.gen(function* () {
    const plane = yield* AppLedger;
    const observations = yield* ObservationSink;
    const stamp = { now: ports.now, id: ports.id };
    registerTrustedChannelGrant(plane.stores.channelGrants, {
      surface: "ws",
      defaultTier: LOOPBACK_BOOTSTRAP_TIER,
    });
    const externalRun = yield* createIngressExecutor(plane, approvalPolicy);
    return createGatewayRouter({
      ...ports,
      transaction: channelTransaction(plane),
      sink: scopeObservation(observations, { sessionId: "gateway-ingress" }, stamp).publish,
      run: (sender, request, body) =>
        Effect.gen(function* () {
          const execute = (intent: Parameters<typeof body>[0]) =>
            body(intent).pipe(
              Effect.mapError(
                (error) => new AgentFailure({ operation: "message.body", cause: String(error) }),
              ),
            );
          if (sender.kind === "external") return yield* externalRun(sender, request, execute);
          const outbound = yield* outboundMessage;
          const result = yield* (outbound?.executor ?? (yield* Core.executorContext)).run(request, execute);
          return {
            ...result,
            matchedRuleIds: messageDecisionRules(plane.read.session(sender.id), sender.id, request),
          };
        }).pipe(Effect.mapError(decodeChannelFailure("message.run"))),
      observe: (sender, observation) =>
        scopeObservation(observations, {
          sessionId: sender.kind === "session" ? sender.id : "gateway-ingress",
        }, stamp).publish(GatewayProtocol.MessageObserved, observation),
      ...(messaging === undefined
        ? {}
        : {
            messaging: {
              ...messaging,
              budgets: messaging.budgets ?? (() => []),
            },
          }),
    });
  });
}
