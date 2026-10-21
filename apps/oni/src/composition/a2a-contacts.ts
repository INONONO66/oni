import { type A2AAnswer, type A2AClient, A2ACredentials, type ChannelInstanceStore, textOfA2A } from "@oni/channels";
import { Operational, type PlainValue } from "@oni/protocol";
import { Duration, Effect } from "effect";
import type { A2AContactPort, A2APostOutcome } from "../bundles/messaging/send-message/index";
import type { ChannelRuntimeDeps, CredentialReader } from "../channels";

/** How long the connector keeps asking a peer about a task it is still working on, absent a deadline on the send. */
const A2A_DEFAULT_WAIT_MS = 30_000;
/** The longest wait a send may ask for: the turn is held while the peer works. */
const A2A_WAIT_CEILING_MS = 300_000;
/** How often a working task is read back. */
const A2A_POLL_MS = 2_000;
/** How much of a peer's answer rides back on the tool result. */
const A2A_RESPONSE_LIMIT = 64 * 1024;
/** The states a peer is still at work in: read back until it leaves them or the wait is over. */
const WORKING: ReadonlySet<string> = new Set(["submitted", "working"]);
/** The states a task never leaves. */
const SETTLED: ReadonlySet<string> = new Set(["completed", "canceled", "failed", "rejected"]);

interface A2APeerTarget {
  readonly url: string;
  readonly token: string;
}

/** Why a peer cannot be written to: the word for the sender's fact, and the detail that goes to the Owner, never to the model. */
interface Withheld {
  readonly reason: string;
  readonly detail?: string;
}

function parseJson(plaintext: Uint8Array): PlainValue | undefined {
  try {
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return undefined;
  }
}

const unavailable = (id: string, detail: string): Withheld => ({ reason: `a2a peer ${id}: its credential is unavailable`, detail });

/** The declared peer behind `a2a:<id>`, or why there is none. */
function resolvePeer(deps: Pick<A2AContactDeps, "instances" | "readCredential">, id: string): A2APeerTarget | Withheld {
  const row = deps.instances.get(`channel:a2a:${id}`);
  if (row === undefined || row.provider !== "a2a") return { reason: `no a2a peer ${id} is declared` };
  if (!row.enabled) return { reason: `a2a peer ${id} is disabled` };
  if (row.credentialRef === undefined) return { reason: `a2a peer ${id} has no credential` };
  const credential = deps.readCredential(row.credentialRef);
  if (credential.kind === "locked") return unavailable(id, credential.reason);
  const parsed = A2ACredentials.safeParse(parseJson(credential.plaintext));
  if (!parsed.success) return unavailable(id, "the credential payload is invalid");
  if (parsed.data.url === undefined) return { reason: `a2a peer ${id} declares no url` };
  return { url: parsed.data.url, token: parsed.data.token };
}

/** The text a peer's answer carries, bounded: the status message, the artifacts, or the message itself. */
function answerText(answer: A2AAnswer): string | undefined {
  if (answer.kind === "error") return undefined;
  const text =
    answer.kind === "message"
      ? textOfA2A(answer.message.parts)
      : [
          answer.task.status.message === undefined ? "" : textOfA2A(answer.task.status.message.parts),
          ...(answer.task.artifacts ?? []).map((artifact) => textOfA2A(artifact.parts)),
        ]
          .filter((part) => part !== "")
          .join("\n");
  if (text === "") return undefined;
  return text.length > A2A_RESPONSE_LIMIT ? text.slice(0, A2A_RESPONSE_LIMIT) : text;
}

export interface A2AContactDeps {
  readonly instances: Pick<ChannelInstanceStore, "get">;
  readonly readCredential: CredentialReader;
  readonly client: A2AClient;
  readonly publish: ChannelRuntimeDeps["publish"];
  readonly now: () => number;
  readonly id: () => string;
  readonly run: ChannelRuntimeDeps["run"];
}

/** What `reply_to` continues: the task a previous result named while open, else the context to open a new task in. */
function threadOf(replyTo: string | undefined): { readonly taskId: string } | { readonly contextId: string } | undefined {
  if (replyTo === undefined) return undefined;
  if (replyTo.startsWith("task:")) return { taskId: replyTo.slice("task:".length) };
  return { contextId: replyTo.replace(/^context:/, "") };
}

/** The letter as A2A carries it: one text part, the tool call's key as the message id, blocking for the answer. */
function letterOf(input: Parameters<A2AContactPort["post"]>[0]): Parameters<A2AClient["send"]>[2] {
  return {
    message: {
      kind: "message",
      role: "user",
      parts: [{ kind: "text", text: input.message }],
      messageId: input.idempotencyKey,
      ...threadOf(input.replyTo),
    },
    configuration: { blocking: true },
  };
}

/** A send that did not go through, or that the peer refused: the receipt's value with the peer's own word. */
function refusedOutcome(sent: Awaited<ReturnType<A2AClient["send"]>>): A2APostOutcome {
  const reason = sent.answer?.kind === "error" ? `${sent.answer.error.code}: ${sent.answer.error.message}` : undefined;
  return {
    status: sent.receipt.value === "sent" ? "not_sent" : sent.receipt.value,
    ...(reason === undefined ? {} : { reason }),
  };
}

/**
 * The peer's answer as the sender's fact. A task that did not complete is
 * named with its state, so the sender knows what is still open, waiting on
 * it, or ended otherwise; the thread is the task while it is open and the
 * context once it is not.
 */
function settledOutcome(settled: A2AAnswer): A2APostOutcome {
  const response = answerText(settled);
  const answered = response === undefined ? {} : { response };
  if (settled.kind === "error") return { status: "sent" };
  if (settled.kind === "message")
    return {
      status: "sent",
      ...answered,
      ...(settled.message.contextId === undefined ? {} : { thread: `context:${settled.message.contextId}` }),
    };
  const { task } = settled;
  return {
    status: "sent",
    ...answered,
    ...(task.status.state === "completed" ? {} : { taskId: task.id, taskState: task.status.state }),
    thread: SETTLED.has(task.status.state) ? `context:${task.contextId}` : `task:${task.id}`,
  };
}

/**
 * The `a2a:` contact (#1569 lane 9c): a declared peer whose credential
 * names a `url` is an agent the Resident may write to — its card read
 * once and honoured only within the declared url's origin, one
 * `message/send` per tool call under custody, the peer's answer (a
 * message, or a task's status and artifacts) returned on the tool result;
 * a task the peer is still working on is read back until it settles or
 * the send's deadline passes, and then reported as it stands. A replayed
 * call keeps its `sent` receipt: the answer went to the first.
 */
export function a2aContacts(deps: A2AContactDeps): A2AContactPort {
  const withheld = (target: Withheld, id: string): A2APostOutcome => {
    if (target.detail !== undefined)
      deps.publish(Operational.Events.Warn, {
        traceId: deps.id(),
        time: deps.now(),
        component: "server",
        msg: "a2a peer unavailable",
        context: { peer: id, detail: target.detail },
      });
    return { status: "not_sent", reason: target.reason };
  };
  return {
    post: (input) =>
      Effect.promise(async (): Promise<A2APostOutcome> => {
        const peer = resolvePeer(deps, input.id);
        if ("reason" in peer) return withheld(peer, input.id);
        const read = await deps.client.card(peer.url, peer.token);
        if (read.kind === "none") return { status: "not_sent", reason: `a2a peer ${input.id} serves no agent card` };
        if (read.kind === "foreign")
          return withheld({ reason: `a2a peer ${input.id}: its card names an endpoint outside its declared url`, detail: read.url }, input.id);
        const sent = await deps.client.send(read.card.url, peer.token, letterOf(input), input.idempotencyKey);
        if (sent.receipt.value !== "sent" || sent.answer?.kind === "error") return refusedOutcome(sent);
        if (sent.answer === undefined) return { status: "sent" };
        const settled = await settle(deps, read.card.url, peer.token, sent.answer, input.deadlineMs ?? A2A_DEFAULT_WAIT_MS);
        return settledOutcome(settled);
      }),
  };
}

/** A task the peer is still working on is read back until it settles or the wait is over; a read that fails ends the wait with the task as last seen. */
async function settle(deps: A2AContactDeps, endpoint: string, token: string, answer: A2AAnswer, waitMs: number): Promise<A2AAnswer> {
  let current = answer;
  const until = deps.now() + Math.min(waitMs, A2A_WAIT_CEILING_MS);
  while (current.kind === "task" && WORKING.has(current.task.status.state) && deps.now() < until) {
    await deps.run(Effect.sleep(Duration.millis(A2A_POLL_MS)));
    let read: A2AAnswer;
    try {
      read = await deps.client.getTask(endpoint, token, { id: current.task.id, historyLength: 0 });
    } catch (error) {
      deps.publish(Operational.Events.Warn, {
        traceId: deps.id(),
        time: deps.now(),
        component: "server",
        msg: "a2a task read failed",
        context: { task: current.task.id, detail: error instanceof Error ? error.message : String(error) },
      });
      return current;
    }
    if (read.kind === "error") return current;
    current = read;
  }
  return current;
}
