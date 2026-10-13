// The single import target for capability plugins: exactly the core ports
// and types the removable plugins consume.
export type { ExecutionRequest, Executor } from "./gate/decide";
export {
  AgentFailure, AgentInvariantViolation, CompactionExecutionError, ContextRestoreError,
  type ExecutionError, pretty, renderBodyCause, thrownAsError,
} from "./failure";
export type { SessionKernel } from "./entity";
export { parsePlainJson, readPlainJson } from "./store/json";
export { Entropy } from "./ports";
export { RunEvents } from "./run-events";
// Alarm seam: exactly what an alarm capability needs.
export {
  ArmRefused, AlarmWakeError, RESERVED_PURPOSES,
  type AlarmCapability, type AlarmWakeContext, type ArmVerb, type AlarmFired, type AlarmWakeOutcome,
} from "./alarm";
// A plugin consumes `Capability.define` alone; `Bundle.define` / `Manifest.define`
// are product-side, surfaced by the root `Bundle` barrel.
export { Capability, seam, type CapabilityDefinition, type SeamTag } from "./capability";
export { AlarmSeam } from "./alarm";
// Consulted-gate seam: what a hook-style capability needs to register an
// asynchronous gate consultant without touching core internals.
export type { ConsultantSeed } from "./compose";
export type { ConsultInput, NamedConsultant } from "./gate/registry";
export type { GateHandlerResult } from "./gate/compose";
// Tool-dispatcher seam: what `plugins/tool` needs to construct dispatchers
// through the core gate.
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
// Compaction seam: the one contract the compaction plugin implements.
export {
  CompactionSeam,
  type CompactionCandidate, type CompactionExecutionInput, type CompactionExecutionOutcome,
  type CompactionGeometry, type CompactionGeometryInput, type CompactionOptions,
  type CompactionRestoreInput, type CompactionRestorePlan, type CompactionSeamService,
  type CompactionSessionConfig, type CompactionSessionPort, type CompactionYield,
  type ResolvedCompactionOptions, type SummarizationBudget, type ToolOutputElision,
} from "./compaction-ports";
