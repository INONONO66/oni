import { AppInvariantError } from "../../invariant";
import { typingPulse, type ProviderTypingRoute } from "@oni/channels";
import { Bundle, Core } from "@oni/agent";
const ObservationSink = Core.ObservationSink;
type ObservationSink = Core.ObservationSink;
import { Effect, Exit, Fiber } from "effect";
const createSessionChatRunner = Core.createSessionChatRunner;
const createTurnDispatcher = Bundle.createTurnDispatcher;
const failureFacts = Core.failureFacts;
const projectTools = Core.projectTools;
const ToolRefused = Core.ToolRefused;
const withExecutor = Core.withExecutor;
type ChatAgentConfig = Core.ChatAgentConfig;
type Executor = Core.Executor;
type SessionRunner = Core.SessionRunner;
type SessionRuntimeOptions = Core.SessionRuntimeOptions;
import {
  Operational,
  traceIdFromUuid,
  type Gateway,
  type LedgerSession,
  type Model,
  type PlainValue,
  type Tool,
} from "@oni/protocol";
import { z } from "zod";
import { chatProviderConfig } from "../../composition/chat-provider";
import type { ComposedContext } from "../../composition/composed";
import { pinnedModelSelection, restoreModelSelection } from "../../composition/model-selection";
import { messageMaterialization } from "../../composition/message-session";
import { classifyTurnFailure } from "../../observation/llm-failure";
import { observeComponent } from "../../observation/component";

function refused(call: Tool.Call, reason: string): Tool.Result & { readonly errorKind: "precondition_failed" } {
  const refusal = new ToolRefused(call.tool, reason);
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

export function refuseEvidenceOnly(call: Tool.Call): Tool.Result & { readonly errorKind: "precondition_failed" } {
  return refused(call, "evidence-only message");
}

interface ReplyTarget {
  readonly actorId: string;
  readonly externalId: string;
  /** The channel the person wrote on: a person on several channels is answered where they asked (#1485). */
  readonly surface: string;
  /** The delivered prompt the reply door answers (#1569): the gateway folds the conversation from its recorded origin. */
  readonly messageId: string;
  /** The chat and thread they wrote in; a group message is answered there, not in a DM (#1490). */
  readonly conversation?: Gateway.Conversation;
  /** The chat they wrote in as recorded, DM included: what a reaction names and what a same-conversation letter is matched against. */
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

/** The origin conversation the perimeter records (`router/message-execution.ts`); the workspace is the gateway's key, not the reply's. */
const OriginConversation = z
  .object({
    channelId: z.string().min(1),
    messageId: z.string().min(1),
    dm: z.boolean(),
    workspaceId: z.string().min(1).optional(),
    threadId: z.string().min(1).optional(),
  })
  .strict();

/**
 * The external human the turn answers: the last delivered prompt whose
 * origin names an actor on a channel surface. WebSocket owners already read
 * the turn stream, so they are not written to twice.
 */
function externalReplyTarget(input: Parameters<SessionRunner>[0]): ReplyTarget | undefined {
  for (const message of [...input.messages].reverse()) {
    if (message.id === undefined) continue;
    const origin = Core.sessionReadModel(input.kernel).actionById(message.id)?.intent.value;
    if (origin === null || typeof origin !== "object" || Array.isArray(origin)) continue;
    if (origin.kind !== "external" || typeof origin.surface !== "string" || origin.surface === "ws") continue;
    if (typeof origin.actorId !== "string" || typeof origin.externalId !== "string") continue;
    const rawConversation = OriginConversation.safeParse(origin.conversation);
    const conversation = originConversation(origin.conversation);
    return {
      actorId: origin.actorId,
      externalId: origin.externalId,
      surface: origin.surface,
      messageId: message.id,
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

/** The gateway's send door (#1569): the reply and the reactions go through it; the composing app hands over its message port. */
interface GatewayDoor {
  ingest(sender: Gateway.IngestSender, message: Gateway.SendMessage): Promise<Gateway.IngestResult>;
}

/**
 * One send through the gateway door under the turn's executor: the gateway's
 * `run` port records the message action with the executor a tool body would
 * carry (`currentExecutor()`), so a door send from the turn itself — the
 * reply, a reaction — must enter the same invocation scope. A refusal or a
 * failed send never fails the turn; the gateway's own observation names it.
 */
function throughDoor(
  door: GatewayDoor,
  executor: Executor,
  sessionId: string,
  message: Gateway.SendMessage,
): Effect.Effect<Gateway.IngestResult | undefined> {
  return Effect.promise(() =>
    withExecutor(executor, () => door.ingest({ kind: "session", id: sessionId }, message)).then(
      (result) => result,
      () => undefined,
    ),
  );
}

/** The reply door's draft refusal (#1569 lane 7): the surface is reachable only through an Owner account that does not auto-reply. */
const REPLY_DRAFT = "message.resident.reply_draft";

/** Where a drafted answer goes (#1600 lane R2): the Owner Person on a platform the bot can write to (resolved by `composition/owner-contact.ts`). */
interface OwnerContact {
  readonly actorId: string;
  readonly surface: string;
}

/**
 * The draft arm (#1569 P4, #1600 lane R2): an answer the reply door would
 * only draft — the conversation is reachable through the Owner's account
 * alone and the declaration does not auto-reply — is delivered to the Owner
 * as a draft to send, through the bot on a platform the Owner has. The
 * letter is the Owner's own mail: the gateway asks no budget and no consent
 * for a letter to the owner-tier Person. With no such platform the draft is
 * the Owner's to read in the session; the gateway's draft observation
 * already names it. A draft the door did not carry is reported, never lost
 * in silence.
 */
function draftToOwner(
  door: GatewayDoor,
  executor: Executor,
  sessionId: string,
  owed: { readonly target: ReplyTarget; readonly text: string },
  contact: OwnerContact,
  warn: (msg: string, context: Readonly<Record<string, string>>) => void,
): Effect.Effect<void> {
  const where = owed.target.conversation?.channelId ?? owed.target.externalId;
  return throughDoor(door, executor, sessionId, {
    to: { kind: "actor", actorId: contact.actorId, surface: contact.surface },
    type: "message",
    content: `Draft reply to ${owed.target.externalId} on ${owed.target.surface} (${where}) — your account alone reaches them; say "send it from my account" to answer there as you, or answer yourself:\n\n${owed.text}`,
  }).pipe(
    Effect.flatMap((sent) => {
      if (sent?.status === "executed") return Effect.void;
      warn("draft reply not delivered to the Owner", {
        sessionId,
        surface: owed.target.surface,
        externalId: owed.target.externalId,
        contact: `${contact.actorId}@${contact.surface}`,
        outcome: sent === undefined ? "door failed" : `${sent.status}:${sent.reasonCode}`,
      });
      return Effect.void;
    }),
  );
}

interface ReactionPlan {
  readonly door: GatewayDoor;
  readonly executor: Executor;
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
function reactionPlan(
  options: ResidentOptions,
  input: Parameters<SessionRunner>[0],
  target: ReplyTarget | undefined,
  executor: Executor,
): ReactionPlan | undefined {
  const ack = options.ackReaction;
  const door = options.gateway;
  if (ack === undefined || door === undefined || input.authority === "evidence_only") return undefined;
  const conversation = target?.reactionConversation;
  const messageId = conversation?.replyToMessageId;
  if (target === undefined || conversation === undefined || messageId === undefined) return undefined;
  return { door, executor, sessionId: input.sessionId, actorId: target.actorId, surface: target.surface, conversation, messageId, ack };
}

/** One reaction through the gateway's send door, so grants, budget and the sent audit apply as to any letter. */
function react(plan: ReactionPlan, emoji: string, replaces?: string): Effect.Effect<void> {
  return throughDoor(plan.door, plan.executor, plan.sessionId, {
    to: { kind: "actor", actorId: plan.actorId, surface: plan.surface, conversation: plan.conversation },
    type: "message",
    content: { kind: "react", messageId: plan.messageId, emoji, ...(replaces === undefined ? {} : { replaces }) },
  });
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

/** The `send_message` contact target of a call, when it names one. */
function contactOf(call: Tool.Call): { readonly id: string; readonly surface?: string; readonly conversation?: PlainValue } | undefined {
  // Membership test on purpose: lint:tools reads an equals sign before the
  // quoted tool name as a second definition site.
  if (!["send_message"].includes(call.tool)) return undefined;
  const to = call.input.to;
  if (to === null || typeof to !== "object" || Array.isArray(to)) return undefined;
  if (to.kind !== "contact" || typeof to.id !== "string") return undefined;
  return {
    id: to.id,
    ...(typeof to.surface === "string" ? { surface: to.surface } : {}),
    ...(to.conversation === undefined ? {} : { conversation: to.conversation }),
  };
}

/**
 * The conversation that prompted the turn is answered by the plain reply,
 * never by `send_message` (#1569): a letter to that same person, on that
 * surface (or on none, which resolves to it), into that same chat and thread
 * — a DM prompt matches a letter naming no conversation or the DM chat
 * itself — is refused before the gateway. Reactions, and letters to another
 * conversation, channel or person, pass.
 */
function sameConversation(call: Tool.Call, target: ReplyTarget | undefined): boolean {
  const contact = contactOf(call);
  if (target === undefined || contact === undefined || call.input.react !== undefined) return false;
  if (contact.id !== target.actorId) return false;
  if (contact.surface !== undefined && contact.surface !== target.surface) return false;
  const recorded = target.reactionConversation;
  const conversation = contact.conversation;
  if (conversation === undefined) return true;
  if (recorded === undefined) return false;
  if (conversation === null || typeof conversation !== "object" || Array.isArray(conversation)) return false;
  const dm = target.conversation === undefined;
  return (
    conversation.channelId === recorded.channelId &&
    (dm || (conversation.threadId ?? undefined) === recorded.threadId)
  );
}

const SAME_CONVERSATION =
  "same_conversation: the conversation that prompted this turn is answered by your plain reply, not by send_message";

/**
 * The reply door (#1569): the turn's result text (or a reported error) goes
 * back to the conversation that prompted it, named by the delivered prompt's
 * message id. The gateway folds the conversation from that prompt's recorded
 * origin and verifies that this session is the one it routed the prompt to;
 * no grant, budget or tool row applies.
 */
function reply(
  door: GatewayDoor,
  executor: Executor,
  sessionId: string,
  owed: { readonly target: ReplyTarget; readonly text: string },
  ownerContact: ResidentOptions["ownerContact"],
  warn: (msg: string, context: Readonly<Record<string, string>>) => void,
): Effect.Effect<void> {
  return throughDoor(door, executor, sessionId, {
    to: { kind: "origin", inReplyTo: owed.target.messageId },
    type: "message",
    content: owed.text,
  }).pipe(
    Effect.flatMap((result) => {
      if (result?.status !== "blocked_pre" || result.reasonCode !== REPLY_DRAFT) return Effect.void;
      const contact = ownerContact?.(owed.target.surface);
      return contact === undefined ? Effect.void : draftToOwner(door, executor, sessionId, owed, contact, warn);
    }),
  );
}

/** The pulse a Resident turn with a channel origin keeps alive while its model runs; none otherwise. */
function typingFor(
  role: LedgerSession.Role,
  input: Parameters<SessionRunner>[0],
  target: ReplyTarget | undefined,
  typingRoute: ((surface: string) => ProviderTypingRoute | undefined) | undefined,
): Effect.Effect<void> | undefined {
  if (role !== "resident" || input.authority === "evidence_only") return undefined;
  const route = target === undefined ? undefined : typingRoute?.(target.surface);
  return route === undefined || target === undefined ? undefined : typingPulse(route, target.externalId, target.conversation);
}

/**
 * The reply an approved person is owed after a turn: its result text (or a
 * reported error) back into the conversation they wrote in, unless the turn
 * only observed or produced nothing to say.
 */
function pendingReply(
  input: Parameters<SessionRunner>[0],
  result: Core.SessionRunnerResult,
  target: ReplyTarget | undefined,
): { readonly target: ReplyTarget; readonly text: string } | undefined {
  if (input.authority === "evidence_only" || target === undefined) return undefined;
  if (result.kind !== "result" && !(result.kind === "error" && result.reported === true)) return undefined;
  if (result.text.trim() === "") return undefined;
  return { target, text: result.text };
}

export interface ResidentOptions {
  /** Mounted channel pulse routes; absent for non-channel test compositions. */
  readonly typingRoute?: (surface: string) => ProviderTypingRoute | undefined;
  readonly model: Model.Ref;
  readonly modelFallbacks?: readonly Model.Ref[];
  readonly apiKey: string;
  readonly transport?: ChatAgentConfig["transport"];
  /** The composed-generation holder (#1255 P3); absent = no tool faces (tests). */
  readonly composed?: { readonly current: () => ComposedContext };
  readonly compaction?: (session: {
    readonly sessionId: string;
    readonly system: string;
  }) => Effect.Effect<NonNullable<ChatAgentConfig["compaction"]>, never, Core.Llm | ObservationSink>;
  readonly presets: Readonly<Record<LedgerSession.Role, string>>;
  readonly id: () => string;
  readonly clock: () => number;
  readonly sessionRuntime: SessionRuntimeOptions;
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
  /** The gateway's send door the reply (#1569) and the reactions go through; absent means no surface can carry them. */
  readonly gateway?: GatewayDoor;
  /** #1600 lane R2: the Owner Person on a platform the bot can write to, for a drafted answer; absent, a draft stays in the session. */
  readonly ownerContact?: (draftedSurface: string) => OwnerContact | undefined;
}

/** Resident and child use the same session-owned runner and dispatcher. */
export function createResident(options: ResidentOptions) {
  /**
   * The journaled tool faces of one role under the current composition: every
   * tool is bundle-owned (#1561), so an off bundle's face is simply absent
   * from the next generation.
   */
  const composedFaces = (role: LedgerSession.Role) => {
    const composed = options.composed?.current();
    if (composed === undefined) return [];
    // #1306: the tool capability owns the model's tool door. Composed off,
    // no face reaches any role: a session under this generation journals
    // zero tools and the model runs with `toolChoice: "none"`.
    if (composed.generation.disabled.some((entry) => entry.name === "tool")) return [];
    return projectTools(composed.generation.tools.filter(
      (tool) => tool.visibility.model.includes(role) || tool.visibility.cell.includes(role),
    )).session;
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
      // The conversation this turn answers through the reply door; a letter
      // the model addresses to that same conversation is refused in the wave.
      const replyTarget = externalReplyTarget(input);
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
            toolWave: (calls, signal) => {
              if (evidenceOnly) return Effect.succeed(calls.map(refuseEvidenceOnly));
              const refusals = calls.filter((call) => sameConversation(call, replyTarget));
              const passed = calls.filter((call) => !refusals.includes(call));
              const wave = passed.length === 0
                ? Effect.succeed([])
                : dispatcher.executeWave(passed, { sessionId: input.sessionId, turnId: input.turnId, signal });
              return wave.pipe(Effect.map((results) => [...results, ...refusals.map((call) => refused(call, SAME_CONVERSATION))]));
            },
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
        // The typing scope closes with the model run, before the reply goes out,
        // so no pulse can land after the reply and show "composing" again.
        const result = yield* Effect.scoped(Effect.gen(function* () {
          const pulse = typingFor(row.role, input, replyTarget, options.typingRoute);
          if (pulse !== undefined) yield* pulse.pipe(Effect.forkScoped);
          return yield* runner(input).pipe(Effect.provideService(ObservationSink, { ...observations, publish: observation.events.publish }));
        }));
        // An approved person who wrote in on a channel is answered there through
        // the reply door; sessions and other contacts are reached only by an
        // explicit send_message.
        const owed = pendingReply(input, result, replyTarget);
        if (owed !== undefined && options.gateway !== undefined)
          yield* reply(options.gateway, dispatcher.executor, input.sessionId, owed, options.ownerContact, (msg, context) =>
            observation.events.publish(Operational.Events.Warn, { traceId, time: options.clock(), component: "resident", msg, context }));
        return result;
      });
      return yield* acknowledged(
        reactionPlan(options, input, replyTarget, dispatcher.executor),
        turn,
        (result) => result.kind === "result",
      );
    });
  return {
    runnerFor,
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
     * The rotation adoption face (#1255 S3): `SessionRuntimeOptions.composed.current()`.
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
