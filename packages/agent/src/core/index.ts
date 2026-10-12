// Core namespace surface (#1276): the former kernel/ + session/ + store/
// barrels merged — turn/gate/tool/ports/failure contracts, entity, admission,
// requests, run, bus, and the append-only store.
export type { ChatAgentConfig } from "./types";
export type { AgentBudget, ResolvedAgentBudget } from "./types";
// #1309: the approval-policy seam — product values behind one injected shape.
export { ApprovalPolicySeam, type ApprovalPolicy, type ApprovalRecentOpen } from "./approval-policy";
export { resolveAgentBudget } from "./budget";
export { createApprovalRequest } from "./request-binding";
export { failureFacts } from "./retry";
export * from "./failure";
export * from "./ports";
export * from "./alarm-ports";
export type { CompactionOptions, CompactionSeamService } from "./compaction-ports";
export {
  createExecutor, ExecutionApprovalError, ExecutorContext, executorContext, ExecutorContextError,
  currentInvocation, forkInvocation,
  type InvocationFrame, type ExecutionApprovalRequest, type Executor,
} from "./gate/decide";
export { compilePolicySnapshot, createPolicyCompiler, KERNEL_POLICY_REGISTRY, SEEDED_POLICY_ROWS, type HandlerTable, type NamedTransformer, type NamedConsultant, type ConsultInput, type NamedGuard, type PolicyEvaluationInput } from "./gate/compile";
export { decisionFromEvaluation, evaluatePermission } from "./gate/match";
export {
  composePointTable, executionPoint, GateComposeError, KERNEL_CAPABILITY_POINTS,
  type CapabilityPointRegistration, type GatePointTable,
} from "./points";
export { assertPointGenerationRows, POINT_GENERATION_ROW, translateLegacyPolicyRow } from "./gate/migrate";
export {
  currentExecutor, defineTool, eraseTool, projectTools,
  ToolRefused, toolInputSchema, type ToolProjections, type ProjectableTool,
} from "./tool";

export {
  adoptSessionAuthority, makeSessionGenerations, createSessionChatRunner, closeSessions, getSessionHandle,
  type GenerationBundle, type SessionHandle, type SessionRunner, type SessionRuntime,
  type SessionCreateOptions, type SessionRunnerInput, type SessionRunnerResult,
  type SessionEntityPorts, type SessionEntityTurnInput,
  type SessionSystem, type ResolvedSessionRuntime,
  composedManifest, type ComposedManifest,
} from "./run";
export { decideSessionAdmission } from "./admission";
export { requestAuthorityKernel, commitSessionRequest } from "./request";
export { createSessionRequests, decideRequestTransition, requestBindingDigest } from "./request";
export { receivedMessageAction, staleActionBacklog } from "./commit";
export { armAction, firedAction, alarmDisposition, composeAlarmPurposes, AlarmComposeError, AlarmSendRefused, ArmRefused, AlarmWakeError, type AlarmCapability, type AlarmArmNotice, type AlarmChainReads, type AlarmDisposition, type AlarmDrainConfig, type AlarmFired, type AlarmPurposeRegistry, type AlarmSweepConfig, type AlarmWakeContext, type AlarmWakeOutcome, type ArmVerb } from "./alarm";
export { SessionEntity, SessionEntityContext, type SessionKernel } from "./entity";
export { Ledger, OpenRefused, openLedger, openLedgerPlane, sessionFilePath, type ClusterServices, type LedgerConfig, type LedgerPlane, type LedgerStoreConfig } from "./host";
export { makeObservationBus, observationBusLayer, scopeObservation } from "./bus";
export { forkSession, ForkRefused, isForkBoundary, DEFAULT_FORK_COPY_BYTE_CAP, type ForkInput, type ForkPorts, type ForkReceipt, type ForkRefusalReason } from "./fork";

// ─── journal/store surface (formerly the Journal namespace, #1276) ───
export {
  CATALOG_SCHEMA, bootstrapStoreDatabase,
  readSessionFileSchemaVersion, SESSION_FILE_SCHEMA_VERSION,
  createDecisionFactPort, SessionHandleStore,
  CommitRefused, CorruptRecord, requireSubAdapter, withStoreTimestamps,
} from "./store";
export type {
  ObservationFailurePort, ObservationPublishFailure, LedgerError,
  AdoptReceipt, CommitReceipt, LedgerHandles,
} from "./store";
