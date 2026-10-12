// The single import target for capability plugins (#1276): re-exports exactly
// the core ports and types the removable capability plugins consume. #1255
// grows this into the core context handed to loaded capabilities.
export type { ExecutionRequest, Executor } from "./gate/decide";
export {
  AgentFailure, AgentInvariantViolation, CompactionExecutionError, ContextRestoreError,
  type ExecutionError, pretty, renderBodyCause, thrownAsError,
} from "./failure";
export type { SessionKernel } from "./entity";
export { parsePlainJson, readPlainJson } from "./store/json";
export { Entropy } from "./ports";
export { RunEvents } from "./run-events";
// #1254 alarm seam: exactly what an alarm capability needs; frozen at S1 —
// later steps add, never rename.
export {
  ArmRefused, AlarmWakeError, RESERVED_PURPOSES,
  type AlarmCapability, type AlarmWakeContext, type ArmVerb, type AlarmFired, type AlarmWakeOutcome,
} from "./alarm";
// #1255 S1: the declaration contract a plugin consumes is `Capability.define`
// alone (`Bundle.define` / `Manifest.define` are product-side, surfaced by the
// root `Bundle` barrel); the alarm seam is what the alarm plugin publishes.
export { Capability, seam, type CapabilityDefinition, type SeamTag } from "./capability";
export { AlarmSeam } from "./alarm";
// #1256 consulted-gate seam: the types a hook-style capability needs to
// register an asynchronous gate consultant without touching core internals.
export type { ConsultantSeed } from "./compose";
export type { ConsultInput, NamedConsultant } from "./gate/registry";
export type { GateHandlerResult } from "./gate/compose";
// #1316 tool-dispatcher seam: exactly what `plugins/tool` needs to construct
// dispatchers through the core gate — executor construction, the ambient
// invocation store, the tool body boundary, the Dispatcher contract and the
// catalog/session/generation ports the per-turn composition consumes.
export {
  activeInvocation, createExecutor, immutableInput, requireExecutor,
  type DurableExecutor, type ExecutionApprovals, type ExecutionBatchResult,
  type ExecutionLedger, type ExecutorOptions, type InvocationFrame, type RawToolSlots,
} from "./gate/decide";
export { GenerationOwnership, SessionLayer, ToolCatalog, type ProcessServices } from "./ports";
export {
  DEFAULT_TOOL_OUTPUT_BUDGET_BYTES, projectToolOutput, type ToolOutputPorts,
} from "./tool-output";
export {
  executeToolBody, projectTools, ToolBodyOutcome, ToolRefused,
  type CellToolDispatchResult, type DispatchContext, type Dispatcher,
  type DispatcherOptions, type ToolDispatchDefinition, type ToolDispatchResult,
  type ToolErrorKind,
} from "./tool";
// #1307 compaction seam: the one contract the compaction plugin implements
// and the kernel consumes; the plugin imports its core types from here.
export {
  CompactionSeam,
  type CompactionCandidate, type CompactionExecutionInput, type CompactionExecutionOutcome,
  type CompactionGeometry, type CompactionGeometryInput, type CompactionOptions,
  type CompactionRestoreInput, type CompactionRestorePlan, type CompactionSeamService,
  type CompactionSessionConfig, type CompactionSessionPort, type CompactionYield,
  type ResolvedCompactionOptions, type SummarizationBudget, type ToolOutputElision,
} from "./compaction-ports";
