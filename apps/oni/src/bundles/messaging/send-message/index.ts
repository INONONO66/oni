import { Bundle, Core } from "@oni/agent";
import { activeBudgetFor, type PersonStore } from "@oni/channels";
import { Gateway, Outbound } from "@oni/protocol";
import { Effect } from "effect";
import { z } from "zod";
import { boundTool, ToolCapabilityPort } from "../../seams";

const defineTool = Core.defineTool;
const ToolRefused = Core.ToolRefused;

/**
 * The `send-message` bundle (#1258): the one `send_message` tool face, the
 * contact registry, and one connector per contact kind. The agent owns
 * exactly one session; every other party — another session, a new child
 * session, a person on a channel, an external CLI agent — is a contact
 * reached through this single tool. Sessions and channel contacts ride the
 * gateway's ingest door (the cluster runtime owns session creation; the
 * channels perimeter owns grants, egress and the per-platform translation of
 * one `Outbound.Payload`, #1497); CLI contacts route through the connector below.
 */

/** The tool needs exactly the router's ingest door; composition supplies the router itself. */
export interface MessagePort {
  ingest(sender: Gateway.IngestSender, message: Gateway.SendMessage | Gateway.IngressFacts | Gateway.RequestAnswer): Promise<Gateway.IngestResult>;
}

const Id = z.string().min(1);

/** Model vocabulary (§3.5): one `contact` noun; the protocol keeps `Actor` internally. */
const Target = z.discriminatedUnion("kind", [
  Gateway.SessionTarget,
  Gateway.NewSessionTarget,
  z
    .object({
      kind: z.literal("contact"),
      id: Id,
      surface: Id.optional().describe(
        "Channel to reach the contact on (telegram, slack, …) when they are reachable on several; omit when they have one.",
      ),
      conversation: Gateway.Conversation.optional().describe(
        "Where on that channel to answer: the chat and thread the contact wrote in (needs surface). Omit to reach them directly.",
      ),
      as: Gateway.SendIdentity.optional().describe(
        "Which account the letter goes out under: bot (default) or owner — the Owner's own account, only when the Owner asked you to send from it in this conversation and their account is connected for sending.",
      ),
    })
    .strict(),
]);

const SendMessageInput = z
  .object({
    to: Target,
    message: z
      .union([z.string(), Outbound.Spec])
      .optional()
      .describe(
        "Plain markdown, or a structured message spec — see the Structured messages section of your instructions.",
      ),
    react: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Instead of a letter, put this emoji on the message the contact wrote (to.conversation.replyToMessageId names it). Channel contacts only.",
      ),
    kind: z
      .enum(["prompt", "interrupt", "resume", "call"])
      .default("prompt")
      .describe("prompt is the default letter; interrupt and resume steer a running session."),
    reply_to: Id.optional().describe(
      "The message this answers; for a webhook or a2a contact, the thread a previous result named, to continue that exchange.",
    ),
    deadline_ms: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Milliseconds from now after which no reply counts as unknown."),
    spend_cap: z
      .number()
      .positive()
      .optional()
      .describe(
        "Spending cap granted to a new child session; creation without one is refused by policy.",
      ),
  })
  .strict()
  .refine((input) => input.kind === "call"
    ? input.react === undefined
    : (input.message === undefined) !== (input.react === undefined), {
    message: "exactly one of message or react",
  });
type SendMessageInput = z.output<typeof SendMessageInput>;

/** The one outbound value the gateway carries: a letter of parts, or one reaction on the contact's message. */
function outboundPayload(input: SendMessageInput): Outbound.Payload {
  if (input.react === undefined) {
    if (input.message === undefined)
      throw new ToolRefused("send_message", "exactly one of message or react");
    return typeof input.message === "string"
      ? Outbound.payload(input.message)
      : { kind: "message", spec: input.message };
  }
  const messageId = input.to.kind === "contact" ? input.to.conversation?.replyToMessageId : undefined;
  if (messageId === undefined)
    throw new ToolRefused("send_message", "react needs a channel contact with conversation.replyToMessageId");
  return { kind: "react", messageId, emoji: input.react };
}

/** The tool's vocabulary folded onto the gateway's consumer surface. */
function toGatewaySend(input: SendMessageInput, now: number, consented = false): Gateway.SendMessage {
  if (input.kind === "call") throw new ToolRefused("send_message", "call_target: calls have no gateway send");
  return {
    // #1569 lane 8: the Owner approved this invocation — the fact the gate admits a budget-less send on.
    ...(consented ? { consented: true as const } : {}),
    to:
      input.to.kind === "contact"
        ? {
            kind: "actor",
            actorId: input.to.id,
            ...(input.to.surface === undefined ? {} : { surface: input.to.surface }),
            ...(input.to.conversation === undefined ? {} : { conversation: input.to.conversation }),
            ...(input.to.as === undefined ? {} : { as: input.to.as }),
          }
        : input.to,
    type: input.kind === "prompt" ? "message" : input.kind,
    content: outboundPayload(input),
    ...(input.reply_to === undefined ? {} : { replyTo: input.reply_to }),
    ...(input.deadline_ms === undefined ? {} : { deadline: now + input.deadline_ms }),
  };
}

// ─── contact registry ───

/** The connector-routed contact kinds; sessions and channel contacts stay on the gateway ingest door. */
const CONTACT_KINDS = ["cli", "webhook", "a2a"] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

export interface ContactAddress {
  readonly kind: ContactKind;
  readonly id: string;
}

/**
 * `cli:<declared contact>`, `webhook:<declared target>` and `a2a:<declared
 * peer>`; any other id is a registered contact reached through the gateway.
 * No kind carries a literal list: a `cli:` id resolves to a row the Owner
 * declared (#1512), never to a vendor name (#1527).
 */
export function parseContactAddress(contact: string): ContactAddress | undefined {
  const split = contact.indexOf(":");
  if (split <= 0 || split === contact.length - 1) return undefined;
  const kind = contact.slice(0, split);
  const id = contact.slice(split + 1);
  if (!CONTACT_KINDS.some((known) => known === kind)) return undefined;
  return { kind: kind as ContactKind, id };
}

/** One outbound letter as a connector sees it. */
interface OutboundSend {
  readonly sender: string;
  /** The sender's turn: what a deadline armed for this send binds to. */
  readonly turnId: string;
  readonly address: ContactAddress;
  /** The tool call's own id: one physical attempt per call, however the call is replayed. */
  readonly idempotencyKey: string;
  readonly message: string;
  readonly replyTo?: string;
  readonly deadlineMs?: number;
}

/**
 * The tool result for a connector-routed send: the issue's `{contact,
 * delivered|not_sent}` fact, plus `unknown` for a letter that may have
 * landed and is never re-sent, the contact's own textual answer when the
 * exchange is one request and one response (a webhook target, an A2A
 * peer), and the thread a later `reply_to` continues.
 */
const ContactOutcome = z
  .object({
    contact: Id,
    status: z.enum(["delivered", "not_sent", "unknown"]),
    reason: z.string().optional(),
    response: z.string().optional(),
    thread: z.string().optional().describe("Pass as reply_to to continue this exchange with the contact."),
  })
  .strict();
type ContactOutcome = z.infer<typeof ContactOutcome>;

/** A connector never throws: failure is the journaled `not_sent` fact. */
export type Connector = (send: OutboundSend) => Effect.Effect<ContactOutcome>;

/**
 * The declared CLI contact's runner over the attached machine's pty (#1512):
 * one send is one turn of the child; the port resolves when the reconciler
 * has admitted the turn's terminal fact, with the child and turn the rows
 * carry. A refusal with `landed` means the letter reached the pane and is
 * never re-sent. Injected, never ambient.
 */
export interface CliRunnerPort {
  run(input: {
    readonly agent: string;
    readonly message: string;
    readonly sender: string;
    readonly turnId: string;
    /** The send's key: the child turn id. */
    readonly key: string;
    readonly deadlineMs?: number;
  }): Effect.Effect<
    { readonly child: string; readonly turn: string; readonly facts: number },
    { readonly reason: string; readonly landed?: boolean }
  >;
}

/** A connector's answer delivered back as the sender's prompt (one reply path for every kind). */
export interface ContactReplyPort {
  prompt(input: {
    readonly sessionId: string;
    readonly contact: string;
    readonly content: string;
    /** The send this prompt answers (its key). */
    readonly replyTo?: string;
  }): Effect.Effect<void, { readonly reason: string }>;
}

/**
 * The reply a cli turn leaves in the sender's inbox (#1512): a pointer to
 * the admitted rows, never a copy of them — the child's tool rows, text and
 * terminal are already in the ledger through the reconciler.
 */
export const CliTurnPointer = z
  .object({
    kind: z.literal("cli_turn"),
    contact: Id,
    child: Id,
    turn: Id,
    phase: z.literal("terminal"),
    facts: z.number().int().nonnegative(),
  })
  .strict();
export type CliTurnPointer = z.infer<typeof CliTurnPointer>;

/** Arms the `delegation.deadline` purpose for a freshly created child (#1258). */
interface DelegationDeadlinePort {
  arm(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly child: string;
    readonly at: number;
  }): Effect.Effect<void, { readonly reason: string }>;
}

/** The injected Effect boundary (#1248 pattern): composition binds `runAppEffect`; bundle code never runs effects itself. */
type RunContactEffect = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;

export interface ContactPorts {
  readonly call?: CallPort;
  readonly run?: RunContactEffect;
  readonly cli?: CliRunnerPort;
  readonly webhook?: WebhookContactPort;
  readonly a2a?: A2AContactPort;
  readonly reply?: ContactReplyPort;
  readonly deadline?: DelegationDeadlinePort;
  /** #1569 lane 8: the Owner-declared social budgets the gateway's gate reads; a reachable contact without an active one is the Owner's to approve. */
  readonly budgets?: () => readonly Gateway.SocialBudget[];
  /** #1569 lane 8: the Person rows — the grant fact (`reach`) the consent hook reads, and the revision the Owner's answer binds to. */
  readonly persons?: Pick<PersonStore, "get">;
}

export interface CallPort {
  start(input: {
    readonly contact: string;
    readonly surface: string;
    readonly channelId: string;
    readonly opening?: string;
    readonly sessionId: string;
    readonly turnId: string;
  }): Promise<{
    readonly contact: string;
    readonly status: "joined";
    readonly call: string;
    readonly surface: string;
    readonly channelId: string;
  }>;
}

/**
 * #1569 lane 8: a letter to a Person the Owner made reachable, for whom no
 * active social budget is declared, suspends for the Owner's consent;
 * connector contacts (cli, webhook, a2a), sessions, new children, budgeted
 * Persons and Persons the Owner never made reachable (the gate refuses those
 * on its own) never do. The returned revisions bind the Owner's answer to
 * the Person row as it stood: an edit of the row in between is stale consent.
 * Without the budgets and persons ports nothing is gated here — the gateway's
 * own gate still rules.
 */
function ownerConsent(
  input: SendMessageInput,
  contacts: ContactPorts,
  at: number,
): { readonly required: boolean; readonly domainRevisions: Readonly<Record<string, number>> } {
  const direct = { required: false, domainRevisions: {} };
  if (input.kind === "call" || input.to.kind !== "contact" || contacts.budgets === undefined || contacts.persons === undefined) return direct;
  if (parseContactAddress(input.to.id) !== undefined) return direct;
  const person = contacts.persons.get(input.to.id);
  if (person?.reach !== true) return direct;
  if (activeBudgetFor(contacts.budgets(), person.id, at) !== undefined) return direct;
  return { required: true, domainRevisions: { [person.id]: person.revision } };
}

function contactName(address: ContactAddress): string {
  return `${address.kind}:${address.id}`;
}

function delivered(address: ContactAddress): ContactOutcome {
  return { contact: contactName(address), status: "delivered" };
}

function notSent(address: ContactAddress, reason: string): ContactOutcome {
  return { contact: contactName(address), status: "not_sent", reason };
}

/**
 * CLI contact connector (#1512, superseding #1180's local spawn): the letter
 * is one turn of the declared child on its machine's pty through the
 * injected runner; when the reconciler has admitted the turn's terminal fact
 * the sender gets one `prompt{origin: contact cli:<id>}` whose content is
 * the pointer to those rows and whose reply_to is this send. A refusal is
 * `not_sent` with the runner's reason; a letter that reached the pane but
 * never ended (`landed`) is `unknown` and never re-sent. A silent child is
 * bounded by the deadline path.
 */
export function cliConnector(runner: CliRunnerPort | undefined, reply: ContactReplyPort | undefined): Connector {
  return (send) =>
    runner === undefined
      ? Effect.succeed(notSent(send.address, "cli runner is not composed"))
      : runner
          .run({
            agent: send.address.id,
            message: send.message,
            sender: send.sender,
            turnId: send.turnId,
            key: send.idempotencyKey,
            ...(send.deadlineMs === undefined ? {} : { deadlineMs: send.deadlineMs }),
          })
          .pipe(
            Effect.flatMap((turn) => {
              const outcome = delivered(send.address);
              if (reply === undefined) return Effect.succeed(outcome);
              const pointer: CliTurnPointer = {
                kind: "cli_turn",
                contact: contactName(send.address),
                child: turn.child,
                turn: turn.turn,
                phase: "terminal",
                facts: turn.facts,
              };
              return reply
                .prompt({
                  sessionId: send.sender,
                  contact: contactName(send.address),
                  content: JSON.stringify(pointer),
                  replyTo: send.idempotencyKey,
                })
                .pipe(
                  Effect.as(outcome),
                  Effect.catch((refused: { readonly reason: string }) => Effect.succeed(notSent(send.address, refused.reason))),
                );
            }),
            Effect.catch((refused: { readonly reason: string; readonly landed?: boolean }) =>
              Effect.succeed(
                refused.landed === true ? unknownOutcome(send.address, refused.reason) : notSent(send.address, refused.reason),
              ),
            ),
          );
}

/** What one POST to a declared webhook target came to, as the port reports it. */
export interface WebhookPostOutcome {
  readonly status: "sent" | "not_sent" | "unknown";
  readonly reason?: string;
  /** The target's answer body, when the POST was accepted and it said anything. */
  readonly response?: string;
}

/** A declared webhook target (#1569 lane 9): the letter POSTed to its URL, signed; composed over the vault and the sender. */
export interface WebhookContactPort {
  post(input: {
    readonly id: string;
    readonly idempotencyKey: string;
    readonly sender: string;
    readonly message: string;
    readonly replyTo?: string;
  }): Effect.Effect<WebhookPostOutcome>;
}

function unknownOutcome(address: ContactAddress, reason: string): ContactOutcome {
  return { contact: contactName(address), status: "unknown", reason };
}

/** The connector's fact from the port's outcome: the target's own word on a refusal, its textual answer on a delivery. */
function webhookOutcome(send: OutboundSend, posted: WebhookPostOutcome): ContactOutcome {
  if (posted.status === "not_sent") return notSent(send.address, posted.reason ?? "the target refused the letter");
  if (posted.status === "unknown")
    return unknownOutcome(send.address, posted.reason ?? "the outcome is unknown; the letter is not re-sent");
  const outcome = delivered(send.address);
  return posted.response === undefined || posted.response === "" ? outcome : { ...outcome, response: posted.response };
}

/**
 * Webhook target connector (#1569 lane 9): posts the letter to the declared
 * target through the composed port — signed, one physical attempt per tool
 * call — and returns the target's textual answer on the result itself: a
 * webhook is one request and one response, so the sender reads the answer
 * where it reads the receipt. An undeclared or unreachable target is
 * `not_sent` with its reason; a POST that may have landed is `unknown` and
 * never re-sent.
 */
export function webhookConnector(port: WebhookContactPort | undefined): Connector {
  return (send) =>
    port === undefined
      ? Effect.succeed(notSent(send.address, "webhook port is not composed"))
      : port
          .post({
            id: send.address.id,
            idempotencyKey: send.idempotencyKey,
            sender: send.sender,
            message: send.message,
            ...(send.replyTo === undefined ? {} : { replyTo: send.replyTo }),
          })
          .pipe(Effect.map((posted) => webhookOutcome(send, posted)));
}

/** What one letter to a declared A2A peer came to, as the port reports it. */
export interface A2APostOutcome {
  readonly status: "sent" | "not_sent" | "unknown";
  readonly reason?: string;
  /** The peer's answer: its message, or its task's status and artifacts. */
  readonly response?: string;
  /** The peer's task when it did not complete within the wait: still open, waiting on the sender, or ended otherwise. */
  readonly taskId?: string;
  readonly taskState?: string;
  /** What a later `reply_to` continues: `task:<id>` while the task is open, `context:<id>` once it is not. */
  readonly thread?: string;
}

/** A declared A2A peer (#1569 lane 9c): the letter sent as `message/send` with the peer's bearer; composed over the vault and the client. */
export interface A2AContactPort {
  post(input: {
    readonly id: string;
    readonly idempotencyKey: string;
    readonly sender: string;
    readonly message: string;
    /** The thread a previous result named: the task to continue, or the context to open a new task in. */
    readonly replyTo?: string;
    readonly deadlineMs?: number;
  }): Effect.Effect<A2APostOutcome>;
}

/** The sender's word for a task that did not complete within the wait, by where the peer left it. */
function a2aTaskWord(taskId: string, state: string): string {
  if (state === "input-required" || state === "auth-required")
    return `the peer is waiting on the sender for task ${taskId} (${state}); reply_to task:${taskId} answers it`;
  if (state === "failed" || state === "rejected" || state === "canceled") return `the peer's task ${taskId} ended ${state}`;
  return `the peer is still working on task ${taskId} (${state})`;
}

/** The connector's fact from the port's outcome: the peer's refusal, its answer, or where its task stands. */
function a2aOutcome(send: OutboundSend, posted: A2APostOutcome): ContactOutcome {
  if (posted.status === "not_sent") return notSent(send.address, posted.reason ?? "the peer refused the letter");
  if (posted.status === "unknown")
    return unknownOutcome(send.address, posted.reason ?? "the outcome is unknown; the letter is not re-sent");
  return {
    ...delivered(send.address),
    ...(posted.taskId === undefined ? {} : { reason: a2aTaskWord(posted.taskId, posted.taskState ?? "working") }),
    ...(posted.response === undefined || posted.response === "" ? {} : { response: posted.response }),
    ...(posted.thread === undefined ? {} : { thread: posted.thread }),
  };
}

/**
 * A2A peer connector (#1569 lane 9c): sends the letter to the declared peer
 * through the composed port — its card read once, one `message/send` per
 * tool call under custody, the peer's answer read back until its task
 * settles or the send's deadline passes — and returns that answer on the
 * result itself. An undeclared or unreachable peer is `not_sent` with its
 * reason; a send that may have landed is `unknown` and never re-sent.
 */
export function a2aConnector(port: A2AContactPort | undefined): Connector {
  return (send) =>
    port === undefined
      ? Effect.succeed(notSent(send.address, "a2a port is not composed"))
      : port
          .post({
            id: send.address.id,
            idempotencyKey: send.idempotencyKey,
            sender: send.sender,
            message: send.message,
            ...(send.replyTo === undefined ? {} : { replyTo: send.replyTo }),
            ...(send.deadlineMs === undefined ? {} : { deadlineMs: send.deadlineMs }),
          })
          .pipe(Effect.map((posted) => a2aOutcome(send, posted)));
}

/** kind → connector; composition builds it once from the injected ports. */
function createContactRegistry(ports: ContactPorts): ReadonlyMap<ContactKind, Connector> {
  return new Map<ContactKind, Connector>([
    ["cli", cliConnector(ports.cli, ports.reply)],
    ["webhook", webhookConnector(ports.webhook)],
    ["a2a", a2aConnector(ports.a2a)],
  ]);
}

// ─── the tool face ───

const SendMessageOutput = z.union([Gateway.SendMessageHandle, ContactOutcome, z.object({
  contact: Id, status: z.literal("joined"), call: Id, surface: Id, channelId: Id,
}).strict()]);

/** Connector dispatch at the tool's Promise boundary: effects run on the injected runner only. */
function routeContact(
  registry: ReadonlyMap<ContactKind, Connector>,
  contacts: ContactPorts,
  address: ContactAddress,
  input: SendMessageInput,
  context: { readonly sessionId: string; readonly turnId: string; readonly callId: string },
): Promise<ContactOutcome> {
  const connector = registry.get(address.kind);
  if (connector === undefined)
    throw new ToolRefused("send_message", `no connector for contact kind ${address.kind}`);
  if (contacts.run === undefined)
    throw new ToolRefused("send_message", "contact effect runner is not composed");
  if (input.react !== undefined)
    throw new ToolRefused("send_message", `a ${address.kind} contact takes a letter, not a reaction`);
  return contacts.run(
    connector({
      sender: context.sessionId,
      turnId: context.turnId,
      address,
      idempotencyKey: `${context.sessionId}:${context.callId}`,
      message: Outbound.text(outboundPayload(input)),
      ...(input.reply_to === undefined ? {} : { replyTo: input.reply_to }),
      ...(input.deadline_ms === undefined ? {} : { deadlineMs: input.deadline_ms }),
    }),
  );
}

/** A failed arm never fails the send: the child exists; the deadline is best-effort policy. */
function armChildDeadline(
  contacts: ContactPorts,
  context: { readonly sessionId: string; readonly turnId: string },
  child: string,
  at: number,
): Promise<void> {
  if (contacts.deadline === undefined || contacts.run === undefined) return Promise.resolve();
  return contacts.run(
    contacts.deadline
      .arm({ sessionId: context.sessionId, turnId: context.turnId, child, at })
      .pipe(Effect.catch(() => Effect.void)),
  );
}

function startCall(
  input: SendMessageInput,
  context: { readonly sessionId: string; readonly turnId: string },
  port: CallPort | undefined,
) {
  const target = input.to;
  if (target.kind !== "contact" || parseContactAddress(target.id) !== undefined ||
    target.surface === undefined || target.conversation?.channelId === undefined)
    throw new ToolRefused("send_message", "call_target: a person contact needs a surface and voice channel");
  if (target.as === "owner")
    throw new ToolRefused("send_message", "call_as_owner: calls use the selected voice surface's account");
  if (port === undefined)
    throw new ToolRefused("send_message", "call_unavailable: live calls are not composed");
  return port.start({
    contact: target.id, surface: target.surface, channelId: target.conversation.channelId,
    ...(input.message === undefined ? {} : { opening: typeof input.message === "string" ? input.message : Outbound.text(outboundPayload(input)) }),
    sessionId: context.sessionId, turnId: context.turnId,
  });
}

/** The catalog is static: without a composed gateway the tool exists and refuses. */
export function createSendMessageTool(
  port: MessagePort | undefined,
  now: () => number,
  contacts: ContactPorts = {},
) {
  const registry = createContactRegistry(contacts);
  return defineTool({
    name: "send_message",
    category: "authority",
    description:
      "Send one letter — markdown, code, images, files — or one emoji reaction to a contact: a session, a new child session, a person on a channel (contact id, with surface and conversation to answer where they wrote), a declared CLI agent on an attached machine (cli:<id> — the letter is typed into its terminal; the reply is a prompt pointing at the child's admitted rows), a declared webhook target (webhook:<id> — the letter is POSTed to its URL, signed; the target's textual answer is returned on the result as `response`), or a declared A2A peer (a2a:<id> — the letter goes to the agent as message/send; its answer, or where its task stands, is returned on the result, with `thread` for reply_to to continue the exchange). Otherwise returns a handle without waiting for a reply; the reply arrives as a delivered prompt in this session. A letter to a person on a channel for whom the Owner declared no social budget waits for the Owner's consent. A call joins the Owner's voice channel and talks with them live; it returns once joined.",
    input: SendMessageInput,
    output: SendMessageOutput,
    visibility: { model: ["resident", "child"], cell: ["resident", "child"] },
    async execute(input, context) {
      if (input.kind === "call") return startCall(input, context, contacts.call);
      const address = input.to.kind === "contact" ? parseContactAddress(input.to.id) : undefined;
      if (address !== undefined) return routeContact(registry, contacts, address, input, context);
      if (port === undefined)
        throw new ToolRefused("send_message", "message gateway is not composed");
      // The consent fact: the hook bound the Owner's answer to the Person row at admission
      // (a non-empty map), and the kernel runs the body only after that answer.
      const consented = Object.keys(context.domainRevisions ?? {}).length > 0;
      const result = await port.ingest(
        { kind: "session", id: context.sessionId },
        toGatewaySend(input, now(), consented),
      );
      if (result.status !== "executed") throw new ToolRefused("send_message", result.reasonCode);
      // #1600 lane R3: an actor delivery the platform rejected, or whose outcome is
      // unknown, is the sender's fact — the same word a connector contact gives.
      if (input.to.kind === "contact" && result.delivery?.kind === "actor" && result.delivery.value !== "accepted") {
        return result.delivery.value === "rejected"
          ? { contact: input.to.id, status: "not_sent" as const, reason: result.delivery.reason ?? "the platform did not accept the letter" }
          : { contact: input.to.id, status: "unknown" as const, reason: "the outcome is unknown; the letter is not re-sent" };
      }
      // #1258: a child created with a deadline arms the delegation.deadline
      // purpose; its handler cancels the child and prompts the parent.
      if (input.to.kind === "new_session" && input.deadline_ms !== undefined)
        await armChildDeadline(contacts, context, result.handle.target, now() + input.deadline_ms);
      return result.handle;
    },
    render: (_input, result) => JSON.stringify(result),
  }, (input) => ownerConsent(input, contacts, now()));
}

/**
 * The `send-message` bundle contract (#1255 `Bundle.define`): the one
 * `send_message` tool over the tool capability, executing against the
 * late-bound live gateway and contact ports (#1561).
 */
export interface SendMessageToolPorts {
  readonly messages: MessagePort | undefined;
  readonly contacts?: ContactPorts;
  readonly clock: () => number;
}

const ABSENT_SEND_PORTS: SendMessageToolPorts = { messages: undefined, clock: () => 0 };

export function sendMessageBundle(ports: () => SendMessageToolPorts | undefined): Bundle.BundleContract<"send-message"> {
  return Bundle.define({
    name: "send-message",
    // #1309: approval answers ride the owner contact this tool reaches, so the
    // send door requires the approval policy's seam — a manifest without the
    // approval-policy provider refuses typed (`seam_missing`) at compose.
    requires: [ToolCapabilityPort, Core.ApprovalPolicyPort],
    tools: [boundTool(ports, ABSENT_SEND_PORTS, (live) => createSendMessageTool(live.messages, live.clock, live.contacts))],
  });
}
