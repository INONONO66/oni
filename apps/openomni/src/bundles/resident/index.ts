import { AppInvariantError } from "../../invariant";
import { Bundle, Core } from "@openomni/agent";
const ObservationSink = Core.ObservationSink;
type ObservationSink = Core.ObservationSink;
import { Effect } from "effect";
const createSessionChatRunner = Core.createSessionChatRunner;
const createTurnDispatcher = Bundle.createTurnDispatcher;
const failureFacts = Core.failureFacts;
const projectTools = Core.projectTools;
const ToolRefused = Core.ToolRefused;
type ChatAgentConfig = Core.ChatAgentConfig;
type SessionRunner = Core.SessionRunner;
type SessionRuntime = Core.SessionRuntime;
import { traceIdFromUuid, type LedgerSession, type Model, type Tool } from "@openomni/protocol";
import { chatProviderConfig } from "../../composition/chat-provider";
import type { ComposedContext } from "../../composition/composed";
import { pinnedModelSelection, restoreModelSelection } from "../../composition/model-selection";
import { messageMaterialization } from "../../composition/message-session";
import { classifyTurnFailure } from "../../observation/llm-failure";
import { observeComponent } from "../../observation/component";
import { buildAgentPrompt } from "../prompt/build";
import { CHILD_PRESET, RESIDENT_PRESET } from "../prompt/roles";
import { toolCatalogLayer, type GenerationDefinitions } from "../../composition/generation-layers";
import { catalogDefinitions, type ToolPorts } from "../tools/core/catalog";

export function refuseEvidenceOnly(call: Tool.Call): Tool.Result & { readonly errorKind: "precondition_failed" } {
  const refusal = new ToolRefused(call.tool, "evidence-only message");
  return {
    id: call.id,
    toolCallId: call.id,
    toolName: call.tool,
    content: refusal.message,
    details: { errorKind: refusal.errorKind },
    errorKind: refusal.errorKind,
    isError: true,
    settlement: "settled",
  };
}

export interface ResidentOptions {
  readonly model: Model.Ref;
  readonly modelFallbacks?: readonly Model.Ref[];
  readonly apiKey: string;
  readonly transport?: ChatAgentConfig["transport"];
  /** The composed-generation holder (#1255 P3); absent = legacy static faces (tests). */
  readonly composed?: { readonly current: () => ComposedContext };
  readonly compaction?: (session: {
    readonly sessionId: string;
    readonly system: string;
  }) => Effect.Effect<NonNullable<ChatAgentConfig["compaction"]>, never, Core.Llm | ObservationSink>;
  readonly tools: ToolPorts;
  readonly sessionRuntime: SessionRuntime;
  /** The catalog's current policy generation; new sessions pin it at creation. */
  readonly policyGeneration: () => number;
  /**
   * Copied-bytes cap written into each new session's genesis
   * `session.configure{settings.forkCopyByteCap}` (#1257); absent (tests)
   * leaves the core default.
   */
  readonly forkCopyByteCap?: number;
  /**
   * Tool output budget written into each new session's genesis
   * `session.configure{settings.toolOutputBudgetBytes}` (#1305); absent
   * (tests, unset env) leaves the core default.
   */
  readonly toolOutputBudgetBytes?: number;
}

/** Resident and child use the same session-owned runner and dispatcher. */
export function createResident(options: ResidentOptions) {
  const ports = options.tools;
  const catalog = catalogDefinitions(ports);
  const definitionsFor = (role: LedgerSession.Role) =>
    catalog.filter((tool) => tool.visibility.model.includes(role) || tool.visibility.cell.includes(role));
  const definitions: GenerationDefinitions = {
    resident: definitionsFor("resident"),
    child: definitionsFor("child"),
    catalogLayer: (select) => toolCatalogLayer(ports, select),
  };
  /**
   * The journaled tool faces of one role under the current composition
   * (#1255 P3): bundle-owned names come ONLY from the composed generation —
   * an off bundle's face disappears even though its ported catalog definition
   * still exists — while everything else keeps its catalog face.
   */
  const composedFaces = (role: LedgerSession.Role) => {
    const composed = options.composed?.current();
    if (composed === undefined) return projectTools(definitions[role]).session;
    // #1306: the tool capability owns the model's tool door. Composed off,
    // no face reaches any role — the catalog definitions still exist, but a
    // session under this generation journals zero tools and the model runs
    // with `toolChoice: "none"`.
    if (composed.generation.disabled.some((entry) => entry.name === "tool")) return [];
    const bundleOwned = new Set(
      composed.manifest.bundles.flatMap((bundle) => bundle.tools.map((tool) => tool.name)),
    );
    const base = definitions[role].filter((tool) => !bundleOwned.has(tool.name));
    const bundleTools = composed.generation.tools.filter(
      (tool) => tool.visibility.model.includes(role) || tool.visibility.cell.includes(role),
    );
    return projectTools([...base, ...bundleTools]).session;
  };
  const runnerFor =
    (row: LedgerSession.Row): SessionRunner =>
    (input) => Effect.gen(function* () {
      const dispatcher = yield* createTurnDispatcher(input, options.sessionRuntime);
      const observations = yield* ObservationSink;
      // #1307: compaction runs only while the composed generation keeps the
      // capability on. Off = the typed disabled entry is already journaled by
      // compose; the loop gets neither options nor seam and skips the paths.
      const compactionOff =
        options.composed?.current().generation.disabled.some((entry) => entry.name === "compaction") === true;
      const compactionPort = compactionOff ? undefined : options.sessionRuntime.compaction;
      const compaction =
        compactionOff || options.compaction === undefined
          ? undefined
          : yield* options.compaction({ sessionId: input.sessionId, system: input.system });
      const traceId = traceIdFromUuid(ports.id());
      const observation = observeComponent({
        traceId,
        sessionId: input.sessionId,
        runId: input.resultId,
        actorId: row.role,
        agentName: row.role,
        componentId: `${row.role}.agent`,
        componentGeneration: input.resumeCount + 1,
        pluginName: `builtin.${row.role}`,
      }, observations);
      const evidenceOnly = input.authority === "evidence_only";
      const offered = new Set(input.tools.map((tool) => tool.name));
      const tools = evidenceOnly ? [] : dispatcher.specs.filter((tool) => offered.has(tool.name));
      const runner = createSessionChatRunner({
        prepare: () => Effect.succeed({
          config: {
            executor: dispatcher.executor,
            // #1309: a run with no explicit budget resolves against the
            // composed approval policy's default budget.
            defaultBudget: options.sessionRuntime.approvalPolicy.defaultBudget,
            systemPrompt: input.system,
            tools,
            toolChoice: tools.length === 0 ? "none" : "auto",
            toolWave: (calls, signal) =>
              evidenceOnly
                ? Effect.succeed(calls.map(refuseEvidenceOnly))
                : dispatcher.executeWave(calls, {
                    sessionId: input.sessionId,
                    turnId: input.turnId,
                    signal,
                  }),
            model: options.model,
            ...(options.modelFallbacks === undefined
              ? {}
              : { modelFallbacks: [...options.modelFallbacks] }),
            ...(compaction === undefined ? {} : { compaction }),
            ...(compactionPort === undefined ? {} : { compactionPort }),
            // #1276: product choice injected into the core seam.
            restoreModelSelection,
            ...chatProviderConfig(options),
          },
          traceContext: {
            traceId,
            sessionId: input.sessionId,
            runId: input.resultId,
            agentName: row.role,
          },
          around: (operation) => observation.run(operation),
        }),
        reportError: (error) =>
          failureFacts(error)?.llm === true ? classifyTurnFailure(error).text : undefined,
        // #1276: product choice injected into the core seam.
        pinnedModel: pinnedModelSelection,
      });
      return yield* runner(input).pipe(Effect.provideService(ObservationSink, { ...observations, publish: observation.events.publish }));
    });
  return {
    runnerFor,
    definitions,
    /**
     * The genesis description one declared session is created from (#1346):
     * the composed generation, preset and runner the core's one creation
     * door (`Core.createSession`) writes. A description only - it never
     * touches a store.
     */
    genesis(id: string, parentId: string | null, role: LedgerSession.Role, runner: string) {
      if (!["resident", "child", "native", "process"].includes(runner)) {
        throw new AppInvariantError(`runner is not registered: ${runner}`);
      }
      const composed = options.composed?.current();
      return messageMaterialization(options.policyGeneration, ports.id)({
        id,
        parentId,
        role,
        runner,
        tools: composedFaces(role),
        bundles: composed?.generation.bundles ?? [],
        preset: buildAgentPrompt(role === "resident" ? RESIDENT_PRESET : CHILD_PRESET),
        at: ports.clock(),
        // #1306: an off cascade leaves genesis unstamped so the first turn's
        // adoption appends the `session.configure{operation: "compose"}` row
        // carrying the typed `disabled` entries; an empty cascade keeps the
        // stamp and the session journals no adoption row.
        ...(composed === undefined || composed.generation.disabled.length > 0
          ? {}
          : { manifestHash: composed.generation.hash }),
        ...(options.forkCopyByteCap === undefined && options.toolOutputBudgetBytes === undefined
          ? {}
          : {
              // Default widths plus the app-resolved caps: fork copy (#1257)
              // and tool output budget (#1305) are generation configuration
              // from genesis on.
              settings: {
                steering: "all" as const,
                followUp: "all" as const,
                ...(options.forkCopyByteCap === undefined ? {} : { forkCopyByteCap: options.forkCopyByteCap }),
                ...(options.toolOutputBudgetBytes === undefined
                  ? {}
                  : { toolOutputBudgetBytes: options.toolOutputBudgetBytes }),
              },
            }),
      });
    },
    /**
     * The rotation adoption face (#1255 S3): `SessionRuntime.composed.current()`.
     * Tools are the role union — the dispatcher still filters per role at
     * capture, and `manifestHash` equality keeps unchanged sessions append-free.
     */
    adoption(): Core.ComposedManifest | undefined {
      const composed = options.composed?.current();
      if (composed === undefined) return undefined;
      const union = [...composedFaces("resident")];
      for (const face of composedFaces("child"))
        if (!union.some((existing) => existing.name === face.name)) union.push(face);
      return {
        hash: composed.generation.hash,
        tools: union,
        bundles: composed.generation.bundles,
        disabled: composed.generation.disabled,
      };
    },
  };
}
