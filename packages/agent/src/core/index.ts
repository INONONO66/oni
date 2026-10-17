export type { ChatAgentConfig } from "./ports/types";
export type { AgentBudget, ResolvedAgentBudget } from "./ports/types";
// The approval-policy port: product values behind one injected shape.
export { ApprovalPolicyPort, type ApprovalPolicy, type ApprovalRecentOpen } from "./composition/approval-policy";
export { resolveAgentBudget } from "./loop/budget";
export { createApprovalRequest } from "./journal/request-binding";
export { failureFacts, MAX_ATTEMPTS } from "./loop/retry";
export {
  Llm, LlmRunFailure, isLlmRunFailure, accumulateUsage,
  type LlmPort, type LlmSink, type RunInput, type RunResult, type ResolvedModel, type LlmCredential, type LlmTransport,
  type AttemptEvidence, type AttemptUsage, type UsageProvenance, type FailureFacts, type FailureClass, type LlmFailure,
  type ProviderReason, type RetryableProviderReason,
} from "./ports/llm";
export * from "./ports/failure";
export * from "./ports/ports";
export type { RetryAlarmPort, RetryAlarmDeps } from "./ports/alarm";
export type { CompactionOptions, CompactionPortService } from "./ports/compaction-ports";
export {
  createExecutor, ExecutionApprovalError, ExecutorContext, executorContext, ExecutorContextError,
  currentInvocation, forkInvocation,
  type InvocationFrame, type ExecutionApprovalRequest, type Executor,
} from "./loop/executor";
export { compilePolicySnapshot, KERNEL_POLICY_REGISTRY, SEEDED_POLICY_ROWS, type HandlerTable, type NamedTransformer, type NamedConsultant, type ConsultInput, type NamedGuard, type PolicyEvaluationInput } from "./gate/compile";
export { decisionFromEvaluation, evaluatePermission } from "./gate/match";
export {
  composePointTable, executionPoint, GateComposeError, KERNEL_CAPABILITY_POINTS,
  type CapabilityPointRegistration, type GatePointTable,
} from "./gate/points";
export { assertPointGenerationRows, POINT_GENERATION_ROW, translateLegacyPolicyRow } from "./gate/migrate";
export {
  currentExecutor, defineTool, eraseTool, projectTools,
  ToolRefused, type ToolProjections, type ProjectableTool,
} from "./loop/tool";
export { toolInputSchema } from "./ports/capability";
// The app runs its reply door and reactions under the turn's executor, as a tool body would.
export { withExecutor } from "./loop/invocation";

export {
  adoptedExecutor, makeSessionGenerations, createSessionChatRunner, closeSessions, getSessionHandle,
  outboundRedrivePort,
  type GenerationBundle, type SessionHandle, type SessionRunner, type SessionRuntime,
  type SessionCreateOptions, type SessionRunnerInput, type SessionRunnerResult,
  type SessionEntityPorts, type SessionEntityTurnInput,
  type SessionSystem, type ResolvedSessionRuntime,
  composedManifest, type ComposedManifest,
} from "./session/run";
export { decideSessionAdmission } from "./session/admission";
export { requestAuthorityKernel } from "./session/request";
export { createSessionRequests, decideRequestTransition, requestBindingDigest } from "./session/request";
export { receivedMessageAction, staleActionBacklog } from "./journal/delivery";
export { armAction, firedAction, alarmDisposition, AlarmSendRefused, ArmRefused, AlarmWakeError, type AlarmCapability, type AlarmArmNotice, type AlarmChainReads, type AlarmDisposition, type AlarmDrainConfig, type AlarmFired, type AlarmPurposeRegistry, type AlarmSweepConfig, type AlarmWakeContext, type AlarmWakeOutcome, type ArmVerb } from "./ports/alarm";
export { foldAlarmChains, openAlarmIds, type AlarmArmRow, type AlarmChainView } from "./session/alarm-read";
export { SessionEntity, SessionEntityContext, type SessionKernel } from "./session/entity";
export { Ledger, OpenRefused, openLedger, sessionFilePath, type ClusterServices, type LedgerConfig, type LedgerPlane, type LedgerStoreConfig } from "./session/host";
export { makeObservationBus, observationBusLayer, scopeObservation } from "./observation/bus";
export { forkSession, ForkRefused, isForkBoundary, DEFAULT_FORK_COPY_BYTE_CAP, type ForkInput, type ForkPorts, type ForkReceipt, type ForkRefusalReason } from "./session/fork";
export { createSession, CreateRefused, type CreateSessionInput, type SessionReceipt } from "./session/create";

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
