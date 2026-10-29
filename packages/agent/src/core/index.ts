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
  createExecutor, ExecutionApprovalError, ExecutorContext, executorContext, optionalExecutor, ExecutorContextError,
  currentInvocation, forkInvocation,
  type InvocationFrame, type ExecutionApprovalRequest, type Executor,
} from "./loop/executor";
export { compile, KERNEL_POLICY_REGISTRY, SEEDED_POLICY_ROWS, composePointTable, GateComposeError, PolicyCompileError, KERNEL_CAPABILITY_POINTS, assertPolicyRows, POINT_GENERATION_ROW } from "./gate/compile";
export { bind, filterLoadout, executionPoint, decisionFromEvaluation, evaluatePermission } from "./gate/bind";
export type { HandlerTable, NamedTransformer, NamedConsultant, ConsultInput, NamedGuard, PolicyEvaluationInput, CapabilityPointRegistration, GatePointTable } from "./gate/types";
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
export { Ledger, OpenRefused, openLedger, sessionClient, sessionTool, createSessionPortsSlot, sessionFilePath, type ClusterServices, type LedgerConfig, type LedgerHost, type LedgerPlane, type LedgerStoreConfig } from "./session/host";
export type { SessionHostRuntime, SessionRuntimeOptions } from "./session/runtime";
export { makeObservationBus, observationBusLayer, scopeObservation } from "./observation/bus";
export { forkSession, ForkRefused, isForkBoundary, DEFAULT_FORK_COPY_BYTE_CAP, type ForkInput, type ForkPorts, type ForkReceipt, type ForkRefusalReason } from "./session/fork";
export { createSession, CreateRefused, type CreateSessionInput, type SessionReceipt } from "./session/create";
export { sessionReadModel, type SessionReadModel } from "./read-model/session";
export { readCatalog } from "./read-model/catalog";
export { prepareSession } from "./session/create";
export { turnIntent } from "./store/session-reads";
export { ToolTurnRefused } from "./journal/messages";

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
