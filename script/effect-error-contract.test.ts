import { expect, test } from "bun:test";
import { Effect, Result } from "effect";
import ts from "typescript";
import { runSyncEffect } from "../apps/openomni/test/helpers/effect";
import * as Agent from "../packages/agent/src/core/failure";
import * as Llm from "../packages/llm/src/errors";
import * as Store from "../packages/agent/src/core/store/errors";
import { sdkError } from "../packages/llm/test/helpers/retry";
import * as Channels from "../packages/channels/src/errors";
import * as Code from "../packages/codemode/src/errors";
import * as Machines from "../packages/machines/src/errors";
import * as Ipc from "../packages/machines/src/ipc/errors";
const diagnostic = { operation: "fixture", cause: "foreign diagnostic" };
const message = { message: "fixture" };
const usage = { inputTokens: 1, outputTokens: 2, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const agentFailure = new Agent.AgentFailure(diagnostic);
// #1352: the model-call layer is its own package; LlmOperationFailure is its carrier.
const llmCarrier = new Llm.LlmOperationFailure(diagnostic);
const llm = {
  LlmOperationFailure: llmCarrier,
  APIError: new Llm.APIError({ cause: sdkError({ ...message, isRetryable: true, statusCode: 429 }), provider: "provider", model: "model" }),
  LlmRunFailure: new Llm.LlmRunFailure({ ...message, usage, aborted: false, contextOverflow: false, visibleOutput: true }),
  ModelResolutionError: new Llm.ModelResolutionError({ ...message, provider: "provider", model: "model", reason: "model_not_found" }),
  AuthInvalidFileError: new Llm.AuthInvalidFileError({ ...message, path: "auth.json" }),
  AuthResolutionError: new Llm.AuthResolutionError({ ...message, provider: "provider", reason: "missing_auth" }),
  ModelCatalogError: new Llm.ModelCatalogError({ ...message, source: "cache", path: "models.json" }),
  ProxyModelsError: new Llm.ProxyModelsError({ ...message, url: "https://fixture.invalid" }),
  TransportFailure: new Llm.TransportFailure({ ...diagnostic, ...message }),
  InvalidProviderData: new Llm.InvalidProviderData({ ...diagnostic, ...message }),
} satisfies { [K in Llm.LlmError["_tag"]]: Extract<Llm.LlmError, { _tag: K }> };
// #1246: ipc folded into machines; MachinesFailure is the one carrier.
const ipc = {
  MachinesFailure: new Machines.MachinesFailure(diagnostic),
  IpcConnectionError: new Ipc.IpcConnectionError(message),
  IpcProtocolError: new Ipc.IpcProtocolError(message),
  IpcTimeoutError: new Ipc.IpcTimeoutError({ ...message, requestId: "request", method: "fixture" }),
  IpcRemoteError: new Ipc.IpcRemoteError({ ...message, requestId: "request", method: "fixture", code: 1000 }),
  IpcPeerKeyMismatchError: new Ipc.IpcPeerKeyMismatchError({ ...message, expected: "0".repeat(64), presented: "f".repeat(64) }),
  IpcQueueFullError: new Ipc.IpcQueueFullError({ ...message, bound: 8 }),
} satisfies { [K in Ipc.IpcError["_tag"]]: Extract<Ipc.IpcError, { _tag: K }> };
const machines = {
  MachinesFailure: new Machines.MachinesFailure(diagnostic),
  MachineCellError: new Machines.MachineCellError({ ...message, cellId: "cell", code: "unknown_cell_id" }),
  MachineRefusalError: new Machines.MachineRefusalError({ ...message, reason: "closed" }),
  SpawnFailure: new Machines.SpawnFailure({ ...diagnostic, ...message }),
  FilesystemFailure: new Machines.FilesystemFailure({ ...diagnostic, ...message }),
  TransportFailure: new Machines.TransportFailure({ ...diagnostic, ...message }),
} satisfies { [K in Machines.MachineError["_tag"]]: Extract<Machines.MachineError, { _tag: K }> };
const code = {
  MachinesFailure: new Machines.MachinesFailure(diagnostic),
  CodemodeError: new Code.CodemodeError({ ...message, reason: "closed" }),
  DriverFailure: new Code.DriverFailure({ ...diagnostic, ...message }),
} satisfies { [K in Code.CodeError["_tag"]]: Extract<Code.CodeError, { _tag: K }> };
// #1246: the ledger store plane folded into agent; AgentFailure is the one carrier.
const store = {
  AgentFailure: agentFailure,
  SessionNotFound: new Store.SessionNotFound({ sessionId: "session" }),
  MaterializeRefused: new Store.MaterializeRefused({ sessionId: "session", reason: "input" }),
  CreateRefused: new Store.CreateRefused({ sessionId: "session", reason: "duplicate" }),
  FenceRefused: new Store.FenceRefused({ sessionId: "session", reason: "held", holder: "holder", fence: 1, expiresAt: 1 }),
  CommitRefused: new Store.CommitRefused({ sessionId: "session", reason: "fence", fence: 1, currentFence: 2, expectedRevision: 0, currentRevision: 1 }),
  PolicyGenerationRefused: new Store.PolicyGenerationRefused({ generation: 1, reason: "conflict" }),
  StorageUnavailable: new Store.StorageUnavailable({ capability: "sessions" }),
  CorruptRecord: new Store.CorruptRecord({ operation: "decode", id: "record" }),
  SchemaRefused: new Store.SchemaRefused({ sessionId: "session", actionId: "action", kind: "prompt", reason: "fixture" }),
  CatalogVersionRefused: new Store.CatalogVersionRefused({ fileVersion: 99, codeVersion: 1, operation: "indexSession" }),
} satisfies { [K in Store.LedgerError["_tag"]]: Extract<Store.LedgerError, { _tag: K }> };
// Agent.SessionError absorbs Store.LedgerError and Model.LlmRunFailure, so those fixtures are members too.
const agent = {
  ...store,
  LlmRunFailure: model.LlmRunFailure,
  AgentFailure: agentFailure,
  PolicyDenied: new Agent.PolicyDenied({ phase: "pre", ruleIds: [] }),
  ToolBodyFailed: new Agent.ToolBodyFailed({ tool: "fixture", cause: "foreign" }),
  InvocationClosed: new Agent.InvocationClosed({ tool: "fixture", reason: "settled" }),
  Interrupted: new Agent.Interrupted(),
  ContextAdmissionError: new Agent.ContextAdmissionError(),
  CommitFailed: new Agent.CommitFailed({ error: store.CommitRefused }),
  OutcomeUnknown: new Agent.OutcomeUnknown({ reason: "unsettled" }),
  CompactionExecutionError: new Agent.CompactionExecutionError({ reason: "refused" }),
  ContextRestoreError: new Agent.ContextRestoreError({ reason: "unknown_compaction" }),
  SessionMissing: new Agent.SessionMissing({ sessionId: "session" }),
  LeaseLost: new Agent.LeaseLost({ sessionId: "session", fence: 1 }),
  GenerationUnavailable: new Agent.GenerationUnavailable({ generation: 1 }),
  GenerationUnsettled: new Agent.GenerationUnsettled({ sessionId: "session", generation: 1, owners: 1 }),
  BundleError: new Agent.BundleError({ code: "acquisition", bundle: "fixture", detail: "fixture" }),
  ExecutionApprovalError: new Agent.ExecutionApprovalError({ code: "stale_approval" }),
  AgentStopError: new Agent.AgentStopError({ reason: "budget" }),
  // #1344: the controller's bounded revision retry surfaces this typed failure.
  AdmissionFailure: new Agent.AdmissionFailure({ code: "revision" }),
} satisfies { [K in Agent.SessionError["_tag"]]: Extract<Agent.SessionError, { _tag: K }> };
const channels = {
  ChannelsFailure: new Channels.ChannelsFailure(diagnostic),
  DeliveryNotSent: new Channels.DeliveryNotSent(diagnostic),
  AutomationEnableRefused: new Channels.AutomationEnableRefused({ reason: "not_found", id: "automation" }),
  AutomationConfigurationError: new Channels.AutomationConfigurationError({ reason: "store_unconfigured" }),
  InvalidInbound: new Channels.InvalidInbound({ operation: "frame", reason: "invalid_json" }),
  DiscordGatewayFetchError: new Channels.DiscordGatewayFetchError(message),
  DiscordApiError: new Channels.DiscordApiError(message),
  DiscordHandlerMissingError: new Channels.DiscordHandlerMissingError(message),
  SlackApiError: new Channels.SlackApiError(message),
  SlackHandlerMissingError: new Channels.SlackHandlerMissingError(message),
  SlackEndpointKeyError: new Channels.SlackEndpointKeyError(message),
  TelegramApiError: new Channels.TelegramApiError(message),
  IngressRoutingError: new Channels.IngressRoutingError("route_blocked", "fixture", { traceId: "trace", time: 1, inboundId: "inbound", surface: "ws", mode: "direct", reason: "fixture", factsUsed: [], stage: "blacklist", outcome: "drop" }),
  SendAdmissionConflict: new Channels.SendAdmissionConflict(message),
  RateLimited: new Channels.RateLimited({ ...message, status: 429, attempts: 1, responseHeaders: {}, responseBody: "" }),
} satisfies { [K in Channels.ChannelError["_tag"]]: Extract<Channels.ChannelError, { _tag: K }> };
type Failure =
  | Agent.SessionError
  | Channels.ChannelError
  | Code.CodeError
  | Ipc.IpcError
  | Store.LedgerError
  | Llm.LlmError
  | Machines.MachineError;
type ErrorClass = abstract new (...args: never) => Error;
interface PackageEntry {
  readonly name: string;
  /** Module path of the union's errors file, relative to packages/. */
  readonly path: string;
  readonly module: Readonly<Record<string, object>>;
  readonly union: string;
  /** The package-owned carrier for a Cause without a typed error: `{ operation, cause: string | Error }`. */
  readonly carrier: Failure["_tag"];
  /** Where the fixture imports the carrier class from (the ipc/codemode planes do not re-export it). */
  readonly carrierPath: string;
  readonly failures: Readonly<Record<string, Failure>>;
  /** Exported error classes thrown from non-Effect paths by design: never union members, never yielded. */
  readonly thrown: readonly ErrorClass[];
}
const isErrorClass = (value: object): value is ErrorClass =>
  typeof value === "function" && Object.prototype.isPrototypeOf.call(Error, value);
/** The two post-#1246 carriers, keyed by tag for entries whose errors file does not re-export its carrier. */
const carrierOwners: Readonly<Record<string, object>> = {
  AgentFailure: Agent.AgentFailure,
  MachinesFailure: Machines.MachinesFailure,
  ChannelsFailure: Channels.ChannelsFailure,
};

const packages: readonly PackageEntry[] = [
  { name: "agent", path: "agent/src/core/failure", module: Agent, union: "SessionError", carrier: "AgentFailure", carrierPath: "agent/src/core/failure", failures: agent, thrown: [Agent.AgentInvariantViolation, Agent.SessionCommitError] },
  { name: "agent store", path: "agent/src/core/store/errors", module: Store, union: "LedgerError", carrier: "AgentFailure", carrierPath: "agent/src/core/store/errors", failures: store, thrown: [Store.LedgerInvariant] },
  { name: "llm", path: "llm/src/errors", module: Llm, union: "LlmError", carrier: "LlmOperationFailure", carrierPath: "llm/src/errors", failures: llm, thrown: [] },
  { name: "channels", path: "channels/src/errors", module: Channels, union: "ChannelError", carrier: "ChannelsFailure", carrierPath: "channels/src/errors", failures: channels, thrown: [] },
  { name: "machines", path: "machines/src/errors", module: Machines, union: "MachineError", carrier: "MachinesFailure", carrierPath: "machines/src/errors", failures: machines, thrown: [] },
  { name: "machines ipc", path: "machines/src/ipc/errors", module: Ipc, union: "IpcError", carrier: "MachinesFailure", carrierPath: "machines/src/errors", failures: ipc, thrown: [] },
  { name: "codemode", path: "codemode/src/errors", module: Code, union: "CodeError", carrier: "MachinesFailure", carrierPath: "machines/src/errors", failures: code, thrown: [] },
];
for (const entry of packages) {
  test(`${entry.name}: every failure export is tagged, yieldable and covered by the package union`, () => {
    const constructors: ErrorClass[] = Object.values(entry.module).filter(isErrorClass);
    const failures: Failure[] = Object.values(entry.failures);
    const owned = new Set<ErrorClass>(failures.map((failure) => failure.constructor as ErrorClass));
    for (const ctor of constructors) expect(owned.has(ctor) || entry.thrown.includes(ctor)).toBe(true);
    for (const ctor of entry.thrown) {
      expect(constructors.includes(ctor)).toBe(true);
      expect(owned.has(ctor)).toBe(false);
    }
    const foreign: object[] = packages.filter((other) => other !== entry).flatMap((other) => Object.values(other.module));
    for (const ctor of owned) expect(constructors.includes(ctor) || foreign.includes(ctor)).toBe(true);
    for (const failure of failures) {
      expect(Effect.isEffect(failure)).toBe(true);
      const caught = runSyncEffect(Effect.result(Effect.fail(failure)));
      expect(Result.isFailure(caught) && caught.failure === failure).toBe(true);
      expect("data" in failure).toBe(false);
    }
    const carrier = entry.failures[entry.carrier];
    expect(carrier).toBeDefined();
    expect(carrier?.constructor === (entry.module[entry.carrier] ?? carrierOwners[entry.carrier])).toBe(true);
    expect(carrier !== undefined && "cause" in carrier ? carrier.cause : undefined).toBe(diagnostic.cause);
    expect(JSON.parse(JSON.stringify(carrier))).toMatchObject({ _tag: entry.carrier, ...diagnostic });
  });
}

test("every package union has a compiling exhaustive tag switch and a structured carrier cause", () => {
  const fixturePath = new URL("./effect-error-exhaustiveness.fixture.ts", import.meta.url).pathname;
  const fixture = packages.map((entry, index) => `
    import type { ${entry.union} as Union${index} } from "../packages/${entry.path}";
    import type { ${entry.carrier} as Carrier${index} } from "../packages/${entry.carrierPath}";
    function exhaustive${index}(error: Union${index}): string {
      switch (error._tag) {
        ${Object.keys(entry.failures).map((tag) => `case ${JSON.stringify(tag)}: return error._tag;`).join("\n")}
        default: { const absent: never = error; return absent; }
      }
    }
    const cause${index} = (error: Carrier${index}): string | Error => error.cause;
  `).join("\n");
  const options: ts.CompilerOptions = { noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, types: ["bun"] };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => file === fixturePath
    ? ts.createSourceFile(file, fixture, languageVersion, true)
    : getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([fixturePath], options, host);
  const errors = ts.getPreEmitDiagnostics(program).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  expect(errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n"))).toEqual([]);
}, 15_000);
