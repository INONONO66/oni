// The single import target for capability plugins: exactly the core ports
// and types the removable plugins consume.
export type { ExecutionRequest, Executor } from "./loop/executor";
export {
  AgentFailure, AgentInvariantViolation, CompactionExecutionError, ContextRestoreError,
  type ExecutionError, pretty, renderBodyCause, thrownAsError,
} from "./ports/failure";
export type { SessionKernel } from "./session/entity";
export { parsePlainJson, readPlainJson } from "./store/storage/sqlite-l0-rows";
export { Entropy } from "./ports/ports";
export { RunEvents } from "./observation/run-events";
// Alarm port: exactly what an alarm capability needs.
export {
  ArmRefused, AlarmWakeError, RESERVED_PURPOSES,
  type AlarmCapability, type AlarmWakeContext, type ArmVerb, type AlarmFired, type AlarmWakeOutcome, type AlarmPurposeRegistry,
} from "./ports/alarm";
// A plugin consumes `Capability.define` alone; `Bundle.define` / `Manifest.define`
// are product-side, surfaced by the root `Bundle` barrel.
export { Capability, port, type CapabilityDefinition, type PortTag } from "./ports/capability";
export { AlarmPort } from "./ports/alarm";
// Consulted-gate port: what a hook-style capability needs to register an
// asynchronous gate consultant without touching core internals.
export type { ConsultantSeed } from "./composition/compose";
export type { ConsultInput, NamedConsultant } from "./gate/types";
export type { GateHandlerResult } from "./gate/types";
// Tool-dispatcher port: what `plugins/tool` needs to construct dispatchers
// through the core gate.
export {
  activeInvocation, createExecutor, immutableInput, requireExecutor,
  type DurableExecutor, type ExecutionApprovals, type ExecutionBatchResult,
  type ExecutionLedger, type ExecutorOptions, type InvocationFrame, type RawToolSlots,
} from "./loop/executor";
export { GenerationOwnership, SessionLayer, ToolCatalog, type ProcessServices } from "./ports/ports";
export {
  DEFAULT_TOOL_OUTPUT_BUDGET_BYTES, projectToolOutput, type ToolOutputPorts,
} from "./ports/tool-output";
export {
  executeToolBody, projectTools, ToolBodyOutcome, ToolRefused,
  type CellToolDispatchResult, type DispatchContext, type Dispatcher,
  type DispatcherOptions, type ToolDispatchDefinition, type ToolDispatchResult,
  type ToolErrorKind,
} from "./loop/tool";
// Compaction port: the four operations the core consumes and the binding that yields them.
export {
  CompactionPort,
  type CompactionOptions, type CompactionOutcome, type CompactionReason,
  type CompactionRestoreInput, type CompactionRestorePlan, type CompactionRunBinding,
  type CompactionPortService, type CompactionWindow, type CompactionYield,
  type PinCompactionAction, type PrepareCompactionRestore, type SummarizationBudget,
  type ToolOutputElision,
} from "./ports/compaction-ports";
export type { RunState } from "./loop/turn";
