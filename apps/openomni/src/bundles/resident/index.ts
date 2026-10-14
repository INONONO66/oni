import { AppInvariantError } from "../../invariant";
import { typingPulse, type ProviderTypingRoute } from "@openomni/channels";
import { Bundle, Core } from "@openomni/agent";
const ObservationSink = Core.ObservationSink;
type ObservationSink = Core.ObservationSink;
import { Effect, Exit, Fiber } from "effect";
const createSessionChatRunner = Core.createSessionChatRunner;
const createTurnDispatcher = Bundle.createTurnDispatcher;
const failureFacts = Core.failureFacts;
const projectTools = Core.projectTools;
const ToolRefused = Core.ToolRefused;
type ChatAgentConfig = Core.ChatAgentConfig;
type SessionRunner = Core.SessionRunner;
type SessionRuntime = Core.SessionRuntime;
import {
  traceIdFromUuid,
  type Gateway,
  type LedgerSession,
  type Model,
  type PlainValue,
  type Tool,
} from "@openomni/protocol";
import { z } from "zod";
import { chatProviderConfig } from "../../composition/chat-provider";
import type { ComposedContext } from "../../composition/composed";
import { pinnedModelSelection, restoreModelSelection } from "../../composition/model-selection";
import { messageMaterialization } from "../../composition/message-session";
import { classifyTurnFailure } from "../../observation/llm-failure";
import { observeComponent } from "../../observation/component";
import type { GenerationDefinitions } from "../../composition/generation-layers";

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

interface ReplyTarget {
  readonly actorId: string;
  readonly externalId: string;
  /** The channel the person wrote on: a person on several channels is answered where they asked (#1485). */
  readonly surface: string;
  /** The chat and thread they wrote in; a group message is answered there, not in a DM (#1490). */
  readonly conversation?: Gateway.Conversation;
  readonly reactionConversation?: Gateway.Conversation;
}

/**
 * The conversation to answer in, from the prompt origin's record of where the
 * message was written. A DM already is the direct channel, so it carries none.
 */
function originConversation(recorded: PlainValue | undefined): Gateway.Conversation | undefined {
  const parsed = OriginConversation.safeParse(recorded);
  if (!parsed.success || parsed.data.dm) return undefined;
  const { channelId, threadId, messageId } = parsed.data;
  return { channelId, ...(threadId === undefined ? {} : { threadId }), replyToMessageId: messageId };
}

const OriginConversation = z
  .object({ channelId: z.string().min(1), messageId: z.string().min(1), dm: z.boolean(), threadId: z.string().min(1).optional() })
  .strict();

/**
 * The external human the turn answers: the last delivered prompt whose
 * origin names an actor on a channel surface. WebSocket owners already read
 * the turn stream, so they are not written to twice.
 */
function externalReplyTarget(input: Parameters<SessionRunner>[0]): ReplyTarget | undefined {
  for (const message of [...input.messages].reverse()) {
    if (message.id === undefined) continue;
    const origin = input.kernel.actionById(message.id)?.intent.value;
    if (origin === null || typeof origin !== "object" || Array.isArray(origin)) continue;
    if (origin.kind !== "external" || typeof origin.surface !== "string" || origin.surface === "ws") continue;
    if (typeof origin.actorId !== "string" || typeof origin.externalId !== "string") continue;
    const rawConversation = OriginConversation.safeParse(origin.conversation);
    const conversation = originConversation(origin.conversation);
    return {
      actorId: origin.actorId,
      externalId: origin.externalId,
      surface: origin.surface,
      ...(conversation === undefined ? {} : { conversation }),
      ...(rawConversation.success
        ? {
            reactionConversation: {
              channelId: rawConversation.data.channelId,
              ...(rawConversation.data.threadId === undefined ? {} : { threadId: rawConversation.data.threadId }),
              replyToMessageId: rawConversation.data.messageId,
            },
          }
        : {}),
    };
  }
  return undefined;
}

interface AckReactionSettings {
  readonly pending: string;
  readonly ok: string;
  readonly failed: string;
}

/** The gateway's send door a reaction goes through; the composing app hands over its message port. */
interface ReactionPort {
  ingest(sender: Gateway.IngestSender, message: Gateway.SendMessage): Promise<Gateway.IngestResult>;
}

interface ReactionPlan {
  readonly port: ReactionPort;
  readonly sessionId: string;
  readonly actorId: string;
  readonly surface: string;
  readonly conversation: Gateway.Conversation;
  readonly messageId: string;
  readonly ack: AckReactionSettings;
}

/**
 * The acknowledgement reactions one channel turn owes (#1506): the person's
 * message, the surface it sits on and the three emoji. None when reactions
 * are off, the turn only observes (evidence-only input is never answered,
 * not even with an emoji), or the origin names no message to react to.
 */
function reactionPlan(options: ResidentOptions, input: Parameters<SessionRunner>[0]): ReactionPlan | undefined {
  const ack = options.ackReaction;
  const port = options.reactions;
  if (ack === undefined || port === undefined || input.authority === "evidence_only") return undefined;
  const target = externalReplyTarget(input);
  const conversation = target?.reactionConversation;
  const messageId = conversation?.replyToMessageId;
  if (target === undefined || conversation === undefined || messageId === undefined) return undefined;
  return { port, sessionId: input.sessionId, actorId: target.actorId, surface: target.surface, conversation, messageId, ack };
}

/**
 * One reaction through the gateway's send door, so grants, budget and the
 * sent audit apply as to any letter. A refusal or a failed send never fails
 * the turn: the person still gets the report.
 */
function react(plan: ReactionPlan, emoji: string, replaces?: string): Effect.Effect<void> {
  return Effect.promise(() =>
    plan.port
      .ingest(
        { kind: "session", id: plan.sessionId },
        {
          to: { kind: "actor", actorId: plan.actorId, surface: plan.surface, conversation: plan.conversation },
          type: "message",
          content: { kind: "react", messageId: plan.messageId, emoji, ...(replaces === undefined ? {} : { replaces }) },
        },
      )
      .then(
        () => undefined,
        () => undefined,
      ),
  );
}

/**
 * The pending emoji goes up while the model runs; once the turn settles the
 * surface swaps it for the terminal one. An interrupted or failed turn is a
 * failed one; a refused pending reaction still ends with the terminal emoji,
 * the swap tolerating an emoji that was never there.
 */
function acknowledged<A, E, R>(
  plan: ReactionPlan | undefined,
  turn: Effect.Effect<A, E, R>,
  succeeded: (value: A) => boolean,
): Effect.Effect<A, E, R> {
  if (plan === undefined) return turn;
  return Effect.scoped(
    Effect.gen(function* () {
      const pending = yield* Effect.forkScoped(react(plan, plan.ack.pending), { startImmediately: true });
      return yield* turn.pipe(
        Effect.onExit((exit) =>
          Fiber.await(pending).pipe(
            Effect.andThen(
              react(plan, Exit.isSuccess(exit) && succeeded(exit.value) ? plan.ack.ok : plan.ack.failed, plan.ack.pending),
            ),
          ),
        ),
      );
    }),
  );
}

/** The `send_message` contact a report is addressed to. */
function contactFor(target: ReplyTarget) {
  return {
    kind: "contact" as const,
    id: target.actorId,
    surface: target.surface,
    ...(target.conversation === undefined ? {} : { conversation: target.conversation }),
  };
}

function contactTarget(call: Tool.Call): string | undefined {
  // Membership test on purpose: lint:tools reads an equals sign before the
  // quoted tool name as a second definition site.
  if (!["send_message"].includes(call.tool)) return undefined;
  const to = call.input.to;
  if (to === null || typeof to !== "object" || Array.isArray(to)) return undefined;
  return to.kind === "contact" && typeof to.id === "string" ? to.id : undefined;
}

/** The contacts a tool wave actually reached: a refused send reaches nobody. */
function reachedContacts(
  calls: readonly Tool.Call[],
  results: readonly { readonly toolCallId: string; readonly isError?: boolean | undefined }[],
): readonly string[] {
  return calls.flatMap((call) => {
    const target = contactTarget(call);
    const result = results.find((item) => item.toolCallId === call.id);
    return target !== undefined && result !== undefined && result.isError !== true ? [target] : [];
  });
}

/**
 * The report an approved person is owed after a turn: its result text (or a
 * reported error) addressed to the external actor who wrote in, unless the
 * model already reached that contact itself or the turn could not act.
 */
/** The pulse a Resident turn with a channel origin keeps alive while its model runs; none otherwise. */
function typingFor(
  role: LedgerSession.Role,
  input: Parameters<SessionRunner>[0],
  typingRoute: ((surface: string) => ProviderTypingRoute | undefined) | undefined,
): Effect.Effect<void> | undefined {
  if (role !== "resident" || input.authority === "evidence_only") return undefined;
  const target = externalReplyTarget(input);
  const route = target === undefined ? undefined : typingRoute?.(target.surface);
  return route === undefined || target === undefined ? undefined : typingPulse(route, target.externalId, target.conversation);
}

function pendingReport(
  input: Parameters<SessionRunner>[0],
  result: Core.SessionRunnerResult,
  repliedTo: ReadonlySet<string>,
): { readonly target: ReplyTarget; readonly text: string } | undefined {
  if (input.authority === "evidence_only") return undefined;
  if (result.kind !== "result" && !(result.kind === "error" && result.reported === true)) return undefined;
  if (result.text.trim() === "") return undefined;
  const target = externalReplyTarget(input);
  if (target === undefined || repliedTo.has(target.actorId)) return undefined;
  return { target, text: result.text };
}

export interface ResidentOptions {
  /** Mounted channel pulse routes; absent for non-channel test compositions. */
  readonly typingRoute?: (surface: string) => ProviderTypingRoute | undefined;
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
  readonly tools: GenerationDefinitions;
  readonly presets: Readonly<Record<LedgerSession.Role, string>>;
  readonly id: () => string;
  readonly clock: () => number;
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
  /** Acknowledgement reactions on channel messages (#1506); absent means off. */
  readonly ackReaction?: AckReactionSettings;
  /** Where those reactions are sent; absent means no surface can carry them. */
  readonly reactions?: ReactionPort;
}

/** Resident and child use the same session-owned runner and dispatcher. */
export function createResident(options: ResidentOptions) {
  const definitions = options.tools;
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
      const traceId = traceIdFromUuid(options.id());
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
      // Contacts the model reached itself this turn; the post-turn report
      // never duplicates an accepted send_message to the same person, and a
      // refused one leaves the person still owed the report.
      const repliedTo = new Set<string>();
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
                  }).pipe(Effect.tap((results) => Effect.sync(() => {
                    for (const target of reachedContacts(calls, results)) repliedTo.add(target);
                  }))),
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
      const turn = Effect.gen(function* () {
        // The typing scope closes with the model run, before the report goes out,
        // so no pulse can land after the reply and show "composing" again.
        const result = yield* Effect.scoped(Effect.gen(function* () {
          const pulse = typingFor(row.role, input, options.typingRoute);
          if (pulse !== undefined) yield* pulse.pipe(Effect.forkScoped);
          return yield* runner(input).pipe(Effect.provideService(ObservationSink, { ...observations, publish: observation.events.publish }));
        }));
        // An approved person who wrote in on a channel is reported to directly;
        // sessions and other contacts are reached only by an explicit send_message.
        const report = pendingReport(input, result, repliedTo);
        if (report !== undefined) {
          yield* dispatcher.execute(
            {
              id: options.id(),
              tool: "send_message",
              input: {
                to: contactFor(report.target),
                message: report.text,
              },
            },
            { sessionId: input.sessionId, turnId: input.turnId, signal: input.signal },
          );
        }
        return result;
      });
      return yield* acknowledged(reactionPlan(options, input), turn, (result) => result.kind === "result");
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
      return messageMaterialization(options.policyGeneration, options.id)({
        id,
        parentId,
        role,
        runner,
        tools: composedFaces(role),
        bundles: composed?.generation.bundles ?? [],
        preset: options.presets[role],
        at: options.clock(),
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
