import { Effect } from "effect";
import { Core } from "@openomni/agent";
const AgentFailure = Core.AgentFailure;
type AgentFailure = Core.AgentFailure;
const SessionEntity = Core.SessionEntity;
import { Delivery, Gateway, SessionGeneration, type ConsumptionSettings, type LedgerSession } from "@openomni/protocol";
import { type ConversationBinding, SendAdmissionConflict, type createGatewayRouter } from "@openomni/channels";
import { z } from "zod";
import type { AppLedgerPlane } from "./cluster-runtime";
import { outboundMessage } from "./terminal-message";

type Ports = Parameters<typeof createGatewayRouter>[0];

/** The origin a channel prompt was recorded with (`message-execution.ts`); other origins bind no conversation. */
const ExternalOrigin = z
  .object({
    kind: z.literal("external"),
    surface: z.string().min(1),
    externalId: z.string().min(1),
    actorId: z.string(),
    conversation: z
      .object({
        channelId: z.string().min(1),
        messageId: z.string().min(1),
        dm: z.boolean(),
        workspaceId: z.string().min(1).optional(),
        threadId: z.string().min(1).optional(),
      })
      .strict(),
  })
  .loose();

/**
 * The reply door's binding (#1569): the conversation the named prompt came
 * from, read off this session's own ledger — a message id another session
 * received, or one that never was a channel prompt, binds nothing and the
 * gateway refuses the send as unbound. WebSocket owners read the turn stream.
 */
function originBinding(
  kernel: ReturnType<AppLedgerPlane["openKernel"]>,
  send: Parameters<Ports["prepare"]>[1],
): ConversationBinding | undefined {
  if (send.to.kind !== "origin") return undefined;
  const origin = ExternalOrigin.safeParse(kernel.actionById(send.to.inReplyTo)?.intent.value);
  if (!origin.success || origin.data.surface === "ws") return undefined;
  const { surface, externalId, actorId, conversation } = origin.data;
  return {
    surface,
    externalId,
    actorId,
    channelId: conversation.channelId,
    messageId: conversation.messageId,
    dm: conversation.dm,
    ...(conversation.workspaceId === undefined ? {} : { workspaceId: conversation.workspaceId }),
    ...(conversation.threadId === undefined ? {} : { threadId: conversation.threadId }),
  };
}

/** The Session entity client resolved once at boot (host-scoped). */
type SessionEntityClient = Effect.Success<typeof SessionEntity.client>;

export interface MessageDeliveryDeps {
  readonly plane: AppLedgerPlane;
  readonly client: SessionEntityClient;
  readonly clock: () => number;
}

/** Pending delivery projection shared by entity and process delivery receipts. */
export function pendingDeliveryRow(input: Delivery.Commit, ordinal: number): Delivery.Row {
  return {
    id: input.id,
    sessionId: input.sessionId,
    kind: input.kind,
    content: input.content,
    origin: input.origin,
    status: "pending",
    consumedBy: null,
    consumedAt: null,
    createdAt: input.createdAt,
    ordinal,
  };
}

/**
 * Message delivery through the Session entity (W5.2 plan §1): the receiver's
 * activation commits the received-message chain action and drains its backlog
 * before the RPC acks, so "committed" here means the turn work is durable.
 * Materialization and child admission limits are composition-side facts the
 * gateway prepared; both are applied before the persisted send.
 */
/**
 * Creates the destination a prepared send declared (fanout-guarded) through
 * the core creation door (#1346): genesis row and catalog index land in one
 * write, and an existing session is left untouched.
 */
export function materializeDeliveryTarget(
  plane: AppLedgerPlane,
  input: Delivery.Commit,
  clock: () => number,
): Effect.Effect<void, AgentFailure> {
  return Effect.gen(function* () {
    const create = input.createSession;
    if (create === undefined) return;
    if (plane.listSessions().some((row) => row.id === create.row.id)) return;
    const limits = input.limits;
    if (limits !== undefined && create.row.parentId !== null) {
      const children = plane
        .listSessions()
        .filter((row) => row.parentId === create.row.parentId);
      if (children.length >= limits.fanout)
        return yield* new AgentFailure({
          operation: "message.commit",
          cause: "child fanout limit exhausted",
        });
    }
    const snapshot = SessionGeneration.ConfigureEffect.parse(
      create.initialAction.effect.value,
    ).snapshot;
    // The prepared genesis settings (#1257 fork copy cap, #1253 widths)
    // survive into the written configure row.
    const prepared = SessionGeneration.ConfigureIntent.safeParse(create.initialAction.intent.value);
    const settings = prepared.success ? prepared.data.settings : undefined;
    yield* Core.createSession(plane, {
      id: create.row.id,
      parentId: create.row.parentId,
      role: create.row.role,
      genesis: {
        tools: [...snapshot.tools],
        bundles: snapshot.bundles,
        system: { preset: snapshot.systemPreset, blocks: snapshot.systemBlocks },
        policyGeneration: snapshot.policyGeneration,
        ...(snapshot.manifestHash === undefined ? {} : { manifestHash: snapshot.manifestHash }),
        ...(settings === undefined ? {} : { settings }),
        actionId: create.initialAction.id,
        at: clock(),
      },
    }).pipe(
      // A concurrent creator winning the same id is the idempotent outcome;
      // an orphan index row (no genesis file) fails typed below (#1346 M3).
      Effect.catchIf((error) => error.reason === "duplicate", () => Effect.void),
      Effect.mapError(
        (error) => new AgentFailure({ operation: "message.create", cause: error._tag }),
      ),
    );
  });
}

/** The entity `Deliver` RPC payload one prepared commit maps to. */
export interface DeliverPayload {
  readonly kind: string;
  readonly body: string;
  readonly source: string;
  readonly idempotencyKey: string;
}

/**
 * Maps one prepared delivery commit to its entity `Deliver` payload (#1346):
 * the outbound binding is checked against the dispatching turn's letter and
 * the consumption boundary rides the body explicitly. Pure apart from the
 * outbound context read; the commit that follows may run in another process.
 */
export function deliverPayload(input: Delivery.Commit): Effect.Effect<DeliverPayload, AgentFailure> {
  return Effect.gen(function* () {
    const outbound = yield* outboundMessage;
    const message = outbound?.input.message;
    if (
      message !== undefined &&
      (input.id !== message.messageId ||
        input.sessionId !== message.destinationSessionId ||
        input.content !== message.content)
    ) {
      return yield* new AgentFailure({
        operation: "message.commit",
        cause: "outbound delivery binding mismatch",
      });
    }
    // #1253: every input lands through the entity's one `deliver` door. An
    // interrupt/resume rides the `signal` kind with its control op in the
    // body; the message id is the caller-chosen idempotency key, so a
    // redelivered commit resolves to the original seq. A typed refusal
    // (`unknown_kind | missing_key | closed | denied`) appends nothing.
    const control = input.kind === "interrupt" || input.kind === "resume" ? input.kind : undefined;
    // #1311: the outbound message declares its consumption boundary (a child
    // settlement rides `followUp`); the deliver body carries it explicitly.
    const delivery = message?.delivery;
    return {
      kind: control === undefined ? input.kind : "signal",
      body: JSON.stringify({
        content: input.content,
        ...(control === undefined ? {} : { control }),
        ...(delivery === undefined ? {} : { delivery }),
      }),
      source: JSON.stringify(input.origin.value),
      idempotencyKey: input.id,
    };
  });
}

/**
 * Commits one mapped payload through the destination's Session entity:
 * the declared destination is created first (one core write), then the
 * receiver's activation admits the input and drains before the RPC acks.
 */
export function commitDeliverPayload(deps: MessageDeliveryDeps) {
  return (input: Delivery.Commit, payload: DeliverPayload): Effect.Effect<Delivery.Row, AgentFailure> =>
    Effect.gen(function* () {
      yield* materializeDeliveryTarget(deps.plane, input, deps.clock);
      const receipt = yield* deps
        .client(input.sessionId)
        .Deliver(payload)
        .pipe(
          Effect.mapError(
            (error) => new AgentFailure({ operation: "message.deliver", cause: String(error) }),
          ),
        );
      return pendingDeliveryRow(input, receipt.seq);
    });
}

export function createMessageDeliveryCommit(deps: MessageDeliveryDeps) {
  const commit = commitDeliverPayload(deps);
  return function commitMessageDelivery(
    input: Delivery.Commit,
  ): Effect.Effect<Delivery.Row, AgentFailure> {
    return deliverPayload(input).pipe(Effect.flatMap((payload) => commit(input, payload)));
  };
}

export function messageMaterialization(
  currentPolicyGeneration: () => number,
  id: () => string,
): (input: {
  readonly id: string;
  readonly parentId: string | null;
  readonly role: LedgerSession.Role;
  readonly tools: readonly SessionGeneration.Tool[];
  readonly bundles?: readonly string[];
  /** The composed generation's hash (#1255 P3): stamped so an unchanged manifest appends no adoption row. */
  readonly manifestHash?: string;
  readonly preset: string;
  readonly runner: string;
  readonly at: number;
  /** Generation settings pinned at genesis (#1253/#1257): widths and fork copy cap. */
  readonly settings?: ConsumptionSettings;
}) => LedgerSession.Materialize {
  return (input) => {
    const snapshot = Core.SessionHandleStore.generationSnapshot({
      generation: 1,
      revertTo: 0,
      tools: input.tools,
      bundles: input.bundles ?? [],
      ...(input.manifestHash === undefined ? {} : { manifestHash: input.manifestHash }),
      system: {
        preset: input.preset,
        blocks: [{ id: "runner", source: "app:runner", content: input.runner }],
      },
      policyGeneration: currentPolicyGeneration(),
    });
    return Core.SessionHandleStore.materializationSeed(
      {
        id: input.id,
        parentId: input.parentId,
        role: input.role,
        actionId: id(),
        at: input.at,
        ...(input.settings === undefined ? {} : { settings: input.settings }),
      },
      snapshot,
    );
  };
}

function sessionDepth(parentId: string | null, rows: readonly LedgerSession.Row[]) {
  let depth = 1;
  let parent = parentId;
  while (parent !== null) {
    depth += 1;
    parent = rows.find((row) => row.id === parent)?.parentId ?? null;
  }
  return depth;
}

function recipientRelation(
  source: LedgerSession.Row,
  recipient: LedgerSession.Row | undefined,
  send: Parameters<Ports["prepare"]>[1],
) {
  return {
    ...(recipient === undefined
      ? send.to.kind === "new_session"
        ? { targetRole: send.to.role }
        : {}
      : { targetRole: recipient.role }),
    parentChild:
      recipient === undefined ||
      recipient.id === source.id ||
      recipient.parentId === source.id ||
      source.parentId === recipient.id,
  };
}

function prepareExternal(
  plane: AppLedgerPlane,
  genesis: (
    id: string,
    parentId: string | null,
    role: LedgerSession.Role,
    runner: string,
  ) => LedgerSession.Materialize,
  send: Parameters<Ports["prepare"]>[1],
  target: string,
  messageId: string,
): Effect.Success<ReturnType<Ports["prepare"]>> {
  const exists = plane.listSessions().some((row) => row.id === target);
  const kernel = exists ? plane.openKernel(target) : undefined;
  const source =
    kernel !== undefined && send.replyTo !== undefined
      ? kernel.messageActionByPlatformId(target, send.replyTo)
      : undefined;
  return {
    target,
    ...(source === undefined || send.replyTo === undefined
      ? {}
      : {
          origin: Delivery.ReplyOrigin.parse({
            kind: "external_reply",
            messageId: send.replyTo,
            sourceActionId: source.id,
            replyTo: send.replyTo,
          }),
        }),
    ...(!exists ? { createSession: genesis(target, null, "resident", "resident") } : {}),
    message: {
      sender: "external",
      eventIdUnique: kernel === undefined || kernel.actionById(messageId) === undefined,
    },
  };
}

function admissionBounds(
  kernel: ReturnType<AppLedgerPlane["openKernel"]>,
  source: LedgerSession.Row,
  send: Parameters<Ports["prepare"]>[1],
) {
  return kernel.policyRows(source.policyGeneration).flatMap((row) => {
    const match = row.match.value;
    if (
      row.kind !== "message" ||
      row.phase !== "pre" ||
      match === null ||
      typeof match !== "object" ||
      Array.isArray(match)
    )
      return [];
    const parsed = Gateway.RuleTableB.safeParse(match.message);
    if (!parsed.success) return [];
    const rule = parsed.data;
    return rule.senderRole === source.role &&
      rule.effect === "deny" &&
      (rule.targetKind === undefined || rule.targetKind === send.to.kind) &&
      (rule.type === undefined || rule.type === send.type) &&
      (rule.targetRole === undefined ||
        (send.to.kind === "new_session" && rule.targetRole === send.to.role))
      ? [rule.check]
      : [];
  });
}

function withinDeadline(
  outbound: boolean,
  parentDeadline: number | undefined,
  sendDeadline: number | undefined,
): boolean {
  return (
    outbound ||
    parentDeadline === undefined ||
    (sendDeadline !== undefined && sendDeadline <= parentDeadline)
  );
}

/** A new child's genesis and the fanout/depth limits the pinned policy declares for it; nothing for other targets. */
function childCreation(
  kernel: ReturnType<AppLedgerPlane["openKernel"]>,
  source: LedgerSession.Row,
  send: Parameters<Ports["prepare"]>[1],
  genesis: (
    id: string,
    parentId: string | null,
    role: LedgerSession.Role,
    runner: string,
  ) => LedgerSession.Materialize,
  target: string,
): Effect.Effect<
  { readonly createSession?: LedgerSession.Materialize; readonly limits?: { readonly fanout: number; readonly depth: number } },
  SendAdmissionConflict
> {
  if (send.to.kind !== "new_session") return Effect.succeed({});
  const bounds = admissionBounds(kernel, source, send);
  const fanout = bounds.flatMap((check) => (check.kind === "fanout" ? [check.max] : []));
  const depths = bounds.flatMap((check) => (check.kind === "depth" ? [check.max] : []));
  if (fanout.length === 0 || depths.length === 0)
    return Effect.fail(new SendAdmissionConflict({ message: "child admission bounds missing from pinned policy" }));
  return Effect.succeed({
    createSession: genesis(target, source.id, send.to.role, send.to.runner),
    limits: { fanout: Math.min(...fanout), depth: Math.min(...depths) },
  });
}

export function prepareMessage(
  plane: AppLedgerPlane,
  genesis: (
    id: string,
    parentId: string | null,
    role: LedgerSession.Role,
    runner: string,
  ) => LedgerSession.Materialize,
): Ports["prepare"] {
  return (sender, send, target, messageId) =>
    Effect.gen(function* () {
      if (sender.kind === "external") {
        return prepareExternal(plane, genesis, send, target, messageId);
      }
      const kernel = plane.openKernel(sender.id);
      const source = kernel.row(sender.id);
      if (source.fenceOwner === null)
        return yield* new SendAdmissionConflict({ message: "session sender has no active lease" });
      const rows = plane.listSessions();
      const recipient =
        send.to.kind === "session" ? plane.openKernel(target).row(target) : undefined;
      const origins = kernel.pendingMessages(sender.id).flatMap((row) => {
        const parsed = Delivery.MessageOrigin.safeParse(row.origin.value);
        return parsed.success ? [parsed.data] : [];
      });
      const parentDeadline = origins.at(-1)?.deadline;
      const outbound = yield* outboundMessage;
      const child = yield* childCreation(kernel, source, send, genesis, target);
      const depth = sessionDepth(source.parentId, rows);
      const openChildren = rows.filter((row) => row.parentId === sender.id).length;
      const binding = originBinding(kernel, send);
      return {
        target,
        ...(binding === undefined ? {} : { binding }),
        ...(outbound === undefined
          ? {}
          : {
              messageId: outbound.input.message.messageId,
              origin: outbound.input.message,
            }),
        sender: { sessionId: sender.id, owner: source.fenceOwner, fence: source.fence },
        ...child,
        message: {
          sender: "session",
          senderRole: source.role,
          targetKind: send.to.kind,
          ...recipientRelation(source, recipient, send),
          type: send.type,
          fanout: openChildren,
          depth,
          // Mandatory terminal mail answers the original request. Its existing
          // deadline/answer CAS owns the bound; a reply must not arm another.
          withinParentDeadline: withinDeadline(
            outbound !== undefined,
            parentDeadline,
            send.deadline,
          ),
        },
      };
    });
}
