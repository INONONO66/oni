import { Bundle, Core } from "@openomni/agent";
import { Gateway, Outbound } from "@openomni/protocol";
import { Effect } from "effect";
import { z } from "zod";
import { ToolCapabilityPort } from "../../seams";

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
    edit: z.string().min(1).optional().describe("Replace a previously sent channel message by its returned message id."),
    kind: z
      .enum(["prompt", "interrupt", "resume"])
      .default("prompt")
      .describe("prompt is the default letter; interrupt and resume steer a running session."),
    reply_to: Id.optional(),
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
  .refine((input) => (input.message === undefined) !== (input.react === undefined), {
    message: "exactly one of message or react",
  });
type SendMessageInput = z.output<typeof SendMessageInput>;

/** The one outbound value the gateway carries: a letter of parts, or one reaction on the contact's message. */
function outboundPayload(input: SendMessageInput): Outbound.Payload {
  if (input.react === undefined) {
    if (input.message === undefined)
      throw new ToolRefused("send_message", "exactly one of message or react");
    if (input.edit !== undefined) return {
      kind: "edit",
      messageId: input.edit,
      spec: typeof input.message === "string"
        ? { root: "message", elements: {
          message: { type: "Markdown", props: { text: input.message }, children: [] },
        } }
        : input.message,
    };
    return typeof input.message === "string"
      ? Outbound.payload(input.message)
      : { kind: "message", spec: input.message };
  }
  if (input.edit !== undefined)
    throw new ToolRefused("send_message", "edit cannot be combined with react");
  const messageId = input.to.kind === "contact" ? input.to.conversation?.replyToMessageId : undefined;
  if (messageId === undefined)
    throw new ToolRefused("send_message", "react needs a channel contact with conversation.replyToMessageId");
  return { kind: "react", messageId, emoji: input.react };
}

/** The tool's vocabulary folded onto the gateway's consumer surface. */
function toGatewaySend(input: SendMessageInput, now: number): Gateway.SendMessage {
  return {
    to:
      input.to.kind === "contact"
        ? {
            kind: "actor",
            actorId: input.to.id,
            ...(input.to.surface === undefined ? {} : { surface: input.to.surface }),
            ...(input.to.conversation === undefined ? {} : { conversation: input.to.conversation }),
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
const CONTACT_KINDS = ["cli"] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

/** The external CLI agents (#1180 absorbed): contacts, not a separate integration. */
const CLI_AGENTS = ["claude-code", "codex", "omp"] as const;

export interface ContactAddress {
  readonly kind: ContactKind;
  readonly id: string;
}

/** `cli:claude-code|codex|omp`; any other id is a registered contact reached through the gateway. */
export function parseContactAddress(contact: string): ContactAddress | undefined {
  const split = contact.indexOf(":");
  if (split <= 0 || split === contact.length - 1) return undefined;
  const kind = contact.slice(0, split);
  const id = contact.slice(split + 1);
  if (!CONTACT_KINDS.some((known) => known === kind)) return undefined;
  if (kind === "cli" && !CLI_AGENTS.some((agent) => agent === id)) return undefined;
  return { kind: kind as ContactKind, id };
}

/** One outbound letter as a connector sees it. */
interface OutboundSend {
  readonly sender: string;
  readonly address: ContactAddress;
  readonly message: string;
  readonly replyTo?: string;
  readonly deadlineMs?: number;
}

/** The tool result for a connector-routed send: the issue's `{contact, delivered|not_sent}` fact. */
const ContactOutcome = z
  .object({
    contact: Id,
    status: z.enum(["delivered", "not_sent"]),
    reason: z.string().optional(),
  })
  .strict();
type ContactOutcome = z.infer<typeof ContactOutcome>;

/** A connector never throws: failure is the journaled `not_sent` fact. */
export type Connector = (send: OutboundSend) => Effect.Effect<ContactOutcome>;

/** External CLI agent runner over the machines exec/pty surface; injected, never ambient. */
export interface CliRunnerPort {
  run(input: {
    readonly agent: string;
    readonly message: string;
  }): Effect.Effect<{ readonly stdout: string; readonly code: number }, { readonly reason: string }>;
}

/** Captured connector output delivered back as the sender's prompt (one reply path for every kind). */
export interface ContactReplyPort {
  prompt(input: {
    readonly sessionId: string;
    readonly contact: string;
    readonly content: string;
  }): Effect.Effect<void, { readonly reason: string }>;
}

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
  readonly run?: RunContactEffect;
  readonly cli?: CliRunnerPort;
  readonly reply?: ContactReplyPort;
  readonly deadline?: DelegationDeadlinePort;
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
 * CLI agent connector (#1180): spawns the external agent on the injected
 * runner, writes the message to stdin, and forwards captured stdout to the
 * sender as a `prompt{origin: contact cli:<agent>}` through the reply port.
 * Spawn failure is `not_sent`; a silent process is bounded by the deadline path.
 */
export function cliConnector(runner: CliRunnerPort | undefined, reply: ContactReplyPort | undefined): Connector {
  return (send) =>
    runner === undefined
      ? Effect.succeed(notSent(send.address, "cli runner is not composed"))
      : runner.run({ agent: send.address.id, message: send.message }).pipe(
          Effect.flatMap(({ stdout, code }) => {
            if (code !== 0) return Effect.succeed(notSent(send.address, `exit ${code}`));
            const outcome = delivered(send.address);
            if (reply === undefined || stdout.length === 0) return Effect.succeed(outcome);
            return reply
              .prompt({ sessionId: send.sender, contact: contactName(send.address), content: stdout })
              .pipe(
                Effect.as(outcome),
                Effect.catch((refused: { readonly reason: string }) => Effect.succeed(notSent(send.address, refused.reason))),
              );
          }),
          Effect.catch((refused: { readonly reason: string }) => Effect.succeed(notSent(send.address, refused.reason))),
        );
}

/** kind → connector; composition builds it once from the injected ports. */
function createContactRegistry(ports: ContactPorts): ReadonlyMap<ContactKind, Connector> {
  return new Map<ContactKind, Connector>([["cli", cliConnector(ports.cli, ports.reply)]]);
}

// ─── the tool face ───

const SendMessageOutput = z.union([Gateway.SendMessageHandle, ContactOutcome]);

/** Connector dispatch at the tool's Promise boundary: effects run on the injected runner only. */
function routeContact(
  registry: ReadonlyMap<ContactKind, Connector>,
  contacts: ContactPorts,
  address: ContactAddress,
  input: SendMessageInput,
  context: { readonly sessionId: string },
): Promise<ContactOutcome> {
  const connector = registry.get(address.kind);
  if (connector === undefined)
    throw new ToolRefused("send_message", `no connector for contact kind ${address.kind}`);
  if (contacts.run === undefined)
    throw new ToolRefused("send_message", "contact effect runner is not composed");
  if (input.react !== undefined)
    throw new ToolRefused("send_message", "a CLI agent takes a letter, not a reaction");
  if (input.edit !== undefined)
    throw new ToolRefused("send_message", "a CLI agent cannot edit a channel message");
  return contacts.run(
    connector({
      sender: context.sessionId,
      address,
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
      "Send one letter — markdown, code, images, files — or one emoji reaction to a contact: a session, a new child session, a person on a channel (contact id, with surface and conversation to answer where they wrote), or an external CLI agent (cli:claude-code|codex|omp). Returns a handle without waiting for a reply; the reply arrives as a delivered prompt in this session.",
    input: SendMessageInput,
    output: SendMessageOutput,
    visibility: { model: ["resident", "child"], cell: ["resident", "child"] },
    async execute(input, context) {
      if (input.edit === "")
        throw new ToolRefused("send_message", "edit needs a nonempty message id");
      const address = input.to.kind === "contact" ? parseContactAddress(input.to.id) : undefined;
      if (address !== undefined) return routeContact(registry, contacts, address, input, context);
      if (input.edit !== undefined && input.to.kind !== "contact")
        throw new ToolRefused("send_message", "edit needs a channel contact");
      if (port === undefined)
        throw new ToolRefused("send_message", "message gateway is not composed");
      const result = await port.ingest(
        { kind: "session", id: context.sessionId },
        toGatewaySend(input, now()),
      );
      if (result.status !== "executed") throw new ToolRefused("send_message", result.reasonCode);
      // #1258: a child created with a deadline arms the delegation.deadline
      // purpose; its handler cancels the child and prompts the parent.
      if (input.to.kind === "new_session" && input.deadline_ms !== undefined)
        await armChildDeadline(contacts, context, result.handle.target, now() + input.deadline_ms);
      return result.delivery.kind === "actor" && result.delivery.externalMessageId !== undefined
        ? { ...result.handle, messageId: result.delivery.externalMessageId }
        : result.handle;
    },
    render: (_input, result) => JSON.stringify(result),
  });
}

/**
 * The `send-message` bundle contract (#1255 `Bundle.define`): the one tool
 * face over the tool capability. The declaration face; execution ports stay
 * composition-wired through the catalog (same pattern as `bundles/monitor`) —
 * the catalog stays sealed at twelve tools because this face shares the
 * catalog definition's name.
 */
export function sendMessageBundle(): Bundle.BundleContract<"send-message"> {
  return Bundle.define({
    name: "send-message",
    // #1309: approval answers ride the owner contact this tool reaches, so the
    // send door requires the approval policy's seam — a manifest without the
    // approval-policy provider refuses typed (`seam_missing`) at compose.
    requires: [ToolCapabilityPort, Core.ApprovalPolicyPort],
    tools: [Core.eraseTool(createSendMessageTool(undefined, () => 0))],
  });
}
