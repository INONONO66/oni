import { Clock, Effect, type Context, type Fiber } from "effect";
import { type SessionError, type ExecutionError, type RunnerOutputMissing, CommitFailed, type InboundAuthorityViolation } from "../ports/failure";
import { type ExecutionLedger, type ExecutionApprovals, type ExecutionResult, type ExecutorOptions, type createRawSlots, createExecutor } from "../loop/executor";
import type { SessionPolicyRefusal } from "../journal/messages";
import type * as SessionHandleStore from "../store/fence";
import type { SessionKernel } from "./entity";
import type { InspectRequest, InspectionPage } from "../../inspect";
import type { Delivery, LedgerAction, LedgerSession, ObservationSink, SessionGeneration, ConfigureDisabled, SessionHistory, SessionTurn, SessionTransition } from "@openomni/protocol";
import type { ChatAgentConfig } from "../ports/types";
import type { decideSessionAdmission } from "./admission";
import type { Generation } from "../composition/compose";
import { projectTools } from "../loop/tool";
import { Entropy, ObservationSink as ObservationService, GenerationLayers, type SessionEntryServices, type RunnerServices } from "../ports/ports";
import type { CompactionSeamService } from "../ports/compaction-ports";
import type { ApprovalPolicy } from "../composition/approval-policy";
import { CorruptRecord, type LedgerError } from "../store/errors";

export interface SessionTool {
  readonly name: string;
  readonly inputSchema: SessionGeneration.Tool["inputSchema"];
  readonly category: SessionGeneration.ToolCategory;
  readonly sequential?: true;
}

export interface SessionSystem {
  readonly preset: string;
  readonly blocks: readonly SessionGeneration.SystemBlock[];
}

export interface SessionCreateOptions {
  readonly id?: string;
  readonly parentId?: string | null;
  readonly role: LedgerSession.Role;
  readonly runner: SessionRunner;
  readonly tools?: readonly SessionTool[];
  readonly system?: Partial<SessionSystem>;
  readonly policyGeneration?: number;
  readonly bundles?: readonly string[];
}

interface SessionGetOptions {
  readonly turns?: number;
}

export interface SessionRunnerInput {
  /** Authenticated delivery treatment, independent of model-visible message text. */
  readonly authority?: "act" | "evidence_only";
  readonly sessionId: string;
  readonly kernel: SessionKernel;
  readonly role: LedgerSession.Role;
  readonly turnId: string;
  readonly actionId: string;
  readonly ledger: ExecutionLedger;
  readonly retainEffect?: (effect: Promise<void>) => void;
  readonly bindApprovals?: (approvals: ExecutionApprovals) => void;
  readonly stopEvidence: ChatAgentConfig["stopEvidence"];
  readonly resultId: string;
  readonly parentActionId: string | null;
  readonly boundaryActionId: string | null;
  readonly messages: readonly (SessionTurn.Message & {
    readonly id?: string;
    readonly time?: number;
  })[];
  readonly history?: readonly import("@openomni/protocol").Message.WithParts[];
  readonly tools: readonly SessionGeneration.Tool[];
  readonly toolsGeneration: number;
  readonly toolsHash: string;
  readonly system: string;
  readonly systemHash: string;
  readonly policyGeneration: number;
  readonly resumeCount: number;
  readonly signal: AbortSignal;
  readonly boundary: (boundary: SessionTurn.Boundary) => Effect.Effect<SessionBoundaryResult, ExecutionError>;
}

export interface SessionBoundaryResult {
  readonly messages: readonly (SessionTurn.Message & { readonly id?: string })[];
  readonly interrupted: boolean;
}

export type SessionRunnerResult =
  | {
      readonly kind: "result";
      readonly text: string;
      readonly finishReason?: "stop" | "max-steps" | "stalled";
      readonly usage?: {
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly totalTokens: number;
        readonly reasoningTokens?: number;
        readonly cacheReadTokens?: number;
        readonly cacheWriteTokens?: number;
      };
    }
  | {
      readonly kind: "waiting";
      readonly reason: "live_wait";
      readonly alarmIds: readonly string[];
      readonly text: string;
    }
  | { readonly kind: "interrupted"; readonly text?: string }
  | {
      readonly kind: "error";
      readonly text: string;
      readonly cause?: Error | SessionPolicyRefusal | RunnerOutputMissing | InboundAuthorityViolation;
      readonly reported?: true;
    };

export type SessionRunner = (input: SessionRunnerInput) => Effect.Effect<SessionRunnerResult, ExecutionError, RunnerServices>;

export interface SessionRuntime {
  /** Absent = compaction is off: a compaction append is a defect and a restore refuses typed. */
  readonly compaction?: CompactionSeamService;
  /** Dispatches a committed source obligation through gateway admission; `ledger` is the source turn's fenced door. */
  readonly dispatchOutbound?: (input: {
    readonly message: SessionTransition.OutboundMessage;
    readonly ledger: Pick<ExecutionLedger, "commit">;
  }) => Effect.Effect<LedgerAction.Receipt, ExecutionError, RunnerServices>;
  /** Direct post-commit doorbells, independent of the lossy observation bus. */
  readonly onDeliveryCommitted?: (sessionIds: readonly string[]) => void;
  /** App-injected child settlement at turn seal; absent = a child never writes to its parent. */
  readonly settleChild?: (
    kernel: SessionKernel,
    row: LedgerSession.Row,
    terminal: LedgerAction.Append,
    result: SessionRunnerResult,
  ) => SessionTransition.OutboundMessage | undefined;
  readonly openIntent?: (input: {
    sessionId: string;
    turnId: string;
    revision: number;
  }) => Effect.Effect<readonly { actionId: string; kind: "message" | "approval" }[], ExecutionError>;
  readonly retryAlarm?: ExecutorOptions["retryAlarm"];
  readonly approvalTimeoutMs?: ExecutorOptions["approvalTimeoutMs"];
  /** The request authority reads its recent-open quota here; required — no in-core literal. */
  readonly approvalPolicy: ApprovalPolicy;
  readonly processId?: string;
  /** Required pinned pre-policy authority for `session.configure`; there is no allow fallback. */
  readonly authorizeConfigure: (input: Parameters<SessionHandleStore.ConfigureAuthority>[0]) => Effect.Effect<boolean, SessionError>;
  readonly authorizeApproval?: ExecutorOptions["authorizeApproval"];
  readonly requestDomainRevisions?: (
    request: SessionTransition.Request,
  ) => Readonly<Record<string, number>>;
  readonly onRequestReady?: (sessionId: string) => void;
  /**
     * Fenced single-writer contract: every commit carries the fence adopted at
     * activation, and the fence CAS (no heartbeat) is the takeover authority. A
     * runner MUST honour aborts promptly: its late result is discarded.
     */
  readonly openKernel: (sessionId: string) => SessionKernel;
  /** Catalog-backed enumeration of durable sessions this process can open. */
  readonly listSessions: () => LedgerSession.Row[];
  readonly onHibernate?: (sessionId: string) => Effect.Effect<void, ExecutionError>;
  /**
   * Bounds only the caller-facing `close()` wait on an abort-ignoring runner; the turn continuation
   * still settles durably. `0` detaches immediately.
   */
  readonly closeGraceMs?: number;
  /**
   * Read at every turn start: a `hash` differing from the adopted `manifestHash` appends one
   * compose configure before the turn captures its generation. Absent = static manifest.
   */
  readonly composed?: { readonly current: () => ComposedManifest | undefined };
}

/** Journal-facing face of one composed `Generation`: recomputed from empty, never patched. */
export interface ComposedManifest {
  readonly hash: string;
  readonly tools: readonly SessionGeneration.Tool[];
  readonly bundles: readonly string[];
  readonly disabled: ConfigureDisabled;
}

export function composedManifest(generation: Generation): ComposedManifest {
  return {
    hash: generation.hash,
    tools: projectTools(generation.tools).session,
    bundles: generation.bundles,
    disabled: generation.disabled,
  };
}

/** Captured once by registry/request acquisition, never an alternate public service API. */
export interface ResolvedSessionRuntime extends SessionRuntime {
  readonly clock: () => number;
  readonly entropy: () => string;
  readonly observations: ObservationSink;
  readonly generations: Context.Service.Shape<typeof GenerationLayers>;
  readonly services: Context.Context<SessionEntryServices>;
}

export function resolveSessionRuntime(runtime: SessionRuntime): Effect.Effect<ResolvedSessionRuntime, never, SessionEntryServices> {
  return Effect.gen(function* () {
    const services = yield* Effect.context<SessionEntryServices>();
    const clock = yield* Clock.clockWith(Effect.succeed);
    const entropy = yield* Entropy;
    const observations = yield* ObservationService;
    const generations = yield* GenerationLayers;
    return { ...runtime, clock: () => clock.currentTimeMillisUnsafe(), entropy: entropy.id, observations, generations, services };
  });
}

interface SessionToolsHandle {
  add(tools: readonly SessionTool[]): Effect.Effect<SessionGeneration.ConfigureReceipt, SessionError>;
  remove(names: readonly string[]): Effect.Effect<SessionGeneration.ConfigureReceipt, SessionError>;
}

interface SessionSystemBlocksHandle {
  set(
    blocks: readonly SessionGeneration.SystemBlock[],
  ): Effect.Effect<SessionGeneration.ConfigureReceipt, SessionError>;
}

export interface SessionHandle {
  readonly id: string;
  readonly approvals: ExecutionApprovals;
  readonly requests: {
    transition(
      payload: SessionTransition.Payload,
      inputId: string,
      at: number,
      admission?: Delivery.Commit,
    ): Effect.Effect<import("./request").RequestDecision, ExecutionError>;
  };
  readonly tools: SessionToolsHandle;
  readonly system: { readonly blocks: SessionSystemBlocksHandle };
  prompt(content: string, origin?: Delivery.Origin): Effect.Effect<SessionRunnerResult | undefined, SessionError>;
  interrupt(origin?: Delivery.Origin): Effect.Effect<void, SessionError>;
  resume(origin?: Delivery.Origin): Effect.Effect<void, SessionError>;
  /** History is never erased: compensation is a typed `restore_context_projection` record. */
  restoreContext(compactionId: string): Effect.Effect<ExecutionResult, SessionError>;
  get(options?: SessionGetOptions): SessionTurn.Snapshot;
  watch(options?: SessionGetOptions): SessionTurn.Watch;
  /** Bounded revision page of committed actions; the resynchronization read after a `watch` gap. */
  history(request?: SessionHistory.PageRequest): SessionHistory.Page;
  /** Redacted causal projection over this session and the sessions it commissioned. */
  inspect(request?: InspectRequest): InspectionPage;
  close(): Effect.Effect<void, SessionError>;
}

export interface SessionController {
  readonly handle: SessionHandle;
  readonly owner: string;
  reconcile(): Effect.Effect<SessionRunnerResult | undefined, SessionError>;
}

export interface RegistryEntry {
  readonly runner: SessionRunner;
  readonly controller: SessionController;
}

export interface SessionControllerLifecycle {
  reactivate(): Effect.Effect<SessionHandle, SessionError>;
  release(): void;
}

/** The entity owns receipt, dedupe, fence and backlog admission; turn machinery stays behind. */

export type SessionAdmissionSnapshot = Parameters<typeof decideSessionAdmission>[0];

type SessionAdmissionDecision = ReturnType<typeof decideSessionAdmission>;

/** The fence identity one activation writes with; rotated once at activation. */
export interface SessionEntityAuthority {
  readonly sessionId: string;
  readonly owner: string;
  readonly fence: number;
}

export interface SessionEntityTurnInput {
  readonly authority: SessionEntityAuthority;
  readonly kernel: SessionKernel;
  readonly decision:
    | { readonly kind: "start" }
    | Extract<SessionAdmissionDecision, { kind: "recover" } | { kind: "resume" }>;
  readonly snapshot: SessionAdmissionSnapshot;
  /**
     * Called only after the durable turn boundary is committed; the entity forks
     * the body so the delivering RPC acks at the boundary (a parent awaiting its
     * child's Prompt RPC inside its own turn would otherwise deadlock). Fixtures may run inline.
     */
  readonly detach: (body: Effect.Effect<void, SessionError>) => Effect.Effect<void, SessionError>;
}

export interface SessionEntityPorts {
  /** The product bundle owns the approval values; required — the core has no fallback. */
  readonly approvalPolicy: ApprovalPolicy;
  /** Redelivery can activate before boot bound the ports; the gate holds it. Absent = ready. */
  readonly ready?: Effect.Effect<void>;
  /** Runs one admitted decision to a durable boundary; the ack follows its commits. */
  readonly runTurn: (input: SessionEntityTurnInput) => Effect.Effect<void, SessionError>;
  /**
   * A turn recovered in this activation and parked on a still-open request re-reads it through this
   * doorbell: the app-side answer path never saw that turn.
   */
  readonly onRequestReady?: (sessionId: string) => void;
  /**
   * A delivered occurrence whose purpose is neither loop-reserved nor declared here folds to a
   * recorded `fired{stale}` fact with zero execution.
   */
  readonly alarmCapability?: import("../ports/alarm").AlarmCapability;
  /** Test seam for keep-alive toggles around a detached turn; real one is `Entity.keepAlive`. */
  readonly onKeepAlive?: (enabled: boolean) => void;
  /** Absent is the typed `seam_missing` refusal at `deliver` — never a core fallback. */
  readonly inputRegistrations?: readonly string[];
  /** Absent refuses every admission with a typed `missing_capability_kinds` decision. */
  readonly capabilityKinds?: readonly string[];
  /** Optional domain-revision capture for request bindings, as on `SessionRuntime`. */
  readonly requestDomainRevisions?: (
    request: SessionTransition.Request,
  ) => Readonly<Record<string, number>>;
  /**
     * Persist-and-return: completes when the envelope is durable, never awaiting
     * the reply (a future occurrence replies at `fireAt`). `AlarmSendRefused` is
     * PERMANENT (the entity retires the chain); transient failures stay defects.
     */
  readonly sendAlarm?: (
    sessionId: string,
    occurrence: import("../ports/alarm").AlarmFired,
  ) => Effect.Effect<void, import("../ports/alarm").AlarmSendRefused>;
  /**
   * The ONE committing arm path app-side verbs delegate to (`not_live` when no activation is
   * registered); the release runs at passivation.
   */
  readonly onLive?: (
    sessionId: string,
    verbs: {
      readonly arm: import("../ports/alarm").ArmVerb;
      /** True iff this activation owns the turn: an effect never commits via a successor. */
      readonly ownsTurn: (turnId: string) => boolean;
    },
  ) => () => void;
  /** Fired synchronously after every committed arm so native handles follow the chain. */
  readonly onArmed?: (notice: import("../ports/alarm").AlarmArmNotice) => void;
}

export interface SessionControllerState {
  active: Fiber.Fiber<SessionRunnerResult | undefined, SessionError> | undefined;
  controller: AbortController | undefined;
  fence: number;
  closed: boolean;
  terminalFrozen: boolean;
  released: boolean;
  successor: SessionHandle | undefined;
  retainedRunner: Fiber.Fiber<void, SessionError> | undefined;
  rawSlots: ReturnType<typeof createRawSlots>;
  activeApprovals: ExecutionApprovals | undefined;
}

export function fencedExecutionLedger(
  kernel: SessionKernel,
  sessionId: string,
  owner: string,
  fence: number,
  clock: () => number,
): Pick<ExecutionLedger, "commit"> {
  return {
    commit: (action) => Effect.suspend(() => {
      const row = kernel.row(sessionId);
      return kernel.commit({
        sessionId, owner, fence, now: clock(), expectedRevision: row.revision,
        actions: [action], state: row.state,
      }).pipe(Effect.flatMap((result) => {
        const receipt = result.receipts[0];
        return receipt === undefined
          ? Effect.fail(new CorruptRecord({ operation: "ledger.commit", id: action.id }))
          : Effect.succeed(receipt);
      }));
    }),
  };
}

/** The core adopts the fence for `owner` and builds the executor over its own fenced door. */
export function adoptedExecutor(
  kernel: SessionKernel,
  sessionId: string,
  owner: string,
  clock: () => number,
  options: Omit<ExecutorOptions, "ledger">,
): ReturnType<typeof createExecutor> {
  return adoptSessionAuthority(kernel, sessionId, owner).pipe(
    Effect.mapError((error) => new CommitFailed({ error })),
    Effect.flatMap((fence) =>
      createExecutor({ ...options, ledger: fencedExecutionLedger(kernel, sessionId, owner, fence, clock) }),
    ),
  );
}

/** No lease TTL, no heartbeat: the fence CAS is the takeover authority; a lost race re-decides. */
export function adoptSessionAuthority(
  kernel: SessionKernel,
  sessionId: string,
  owner: string,
): Effect.Effect<number, LedgerError> {
  const attempt: Effect.Effect<number, LedgerError> = Effect.suspend(() => {
    const current = kernel.row(sessionId);
    if (current.fenceOwner === owner) return Effect.succeed(current.fence);
    return kernel
      .adoptFence({ sessionId, owner, fence: current.fence + 1 })
      .pipe(
        Effect.map((receipt) => receipt.fence),
        Effect.catchTag("FenceRefused", () => attempt),
      );
  });
  return attempt;
}

/** Only the testing registry installs an in-process handle plane. */
export interface SessionHandlePlane {
  get(id: string): SessionHandle | undefined;
  close(): Effect.Effect<void, SessionError>;
}

const handlePlanes = new WeakMap<SessionRuntime, SessionHandlePlane>();

export function installSessionHandlePlane(runtime: SessionRuntime, plane: SessionHandlePlane): void {
  handlePlanes.set(runtime, plane);
}

export function getSessionHandle(id: string, runtime: SessionRuntime): SessionHandle | undefined {
  return handlePlanes.get(runtime)?.get(id);
}

export function closeSessions(runtime: SessionRuntime): Effect.Effect<void, SessionError> {
  return Effect.suspend(() => {
    const plane = handlePlanes.get(runtime);
    handlePlanes.delete(runtime);
    return plane === undefined ? Effect.void : plane.close();
  });
}
