import { z } from "zod";
import { Delivery, SessionTransition } from "@oni/protocol";
import { CauseText } from "../thrown";
import type { ProcessDelivery, ProcessSessionRequest } from "../process-entry";

// Promise band (#1423): the `Bun.spawn` stdin/stdout byte streams force this transport onto
// Promises; Effect takes over only inside the injected `answer` call, so no session state
// or request resolution logic belongs here.

/** The parent-side child-transport contract broke: an impostor answer or an abnormal exit. */
class ProcessSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcessSessionError";
  }
}

const Doorbell = z.object({ sessionIds: z.array(z.string().min(1)) }).strict();
/** The entity `Deliver` payload the child mapped (apps/oni/src/composition/message-session.ts). */
const DeliverPayload = z
  .object({ kind: z.string(), body: z.string(), source: z.string(), idempotencyKey: z.string().min(1) })
  .strict();
const ProcessOutput = z.union([
  Doorbell,
  z
    .object({
      kind: z.literal("request_answer"),
      answer: SessionTransition.Answer,
    })
    .strict(),
  // #1346: a child's delivery is admitted by the parent's Session entity;
  // the child never writes another session's chain.
  z
    .object({
      kind: z.literal("request_deliver"),
      commit: Delivery.Commit,
      deliver: DeliverPayload,
    })
    .strict(),
]);
export const ProcessReplyReceipt = z.union([
  z
    .object({
      ok: z.literal(true),
      inputId: z.string().min(1),
      resolution: SessionTransition.Resolution,
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      inputId: z.string().min(1),
      row: Delivery.Row,
    })
    .strict(),
  z.object({ ok: z.literal(false), inputId: z.string().min(1), error: z.string() }).strict(),
]);

/** A process is only a transport for the same durable session runner. */
export function createProcessSessionTransport(options: {
  readonly command: readonly string[];
  readonly child: Omit<ProcessSessionRequest, "sessionId">;
  readonly committed: (sessionIds: readonly string[]) => void;
  readonly answer: (answer: SessionTransition.Answer) => Promise<SessionTransition.Resolution>;
  readonly deliver: (input: ProcessDelivery) => Promise<Delivery.Row>;
}) {
  const children = new Map<string, { close: () => void; done: Promise<void> }>();
  async function receive(line: string, sessionId: string, write: (value: string) => void) {
    const output = ProcessOutput.parse(JSON.parse(line));
    if ("sessionIds" in output) {
      options.committed(output.sessionIds);
      return;
    }
    if (output.kind === "request_deliver") {
      const { commit, deliver } = output;
      if (commit.sender?.sessionId !== sessionId)
        throw new ProcessSessionError("process delivery sender does not match its authenticated child");
      const receipt: z.infer<typeof ProcessReplyReceipt> = await options.deliver({ commit, deliver }).then(
        (row) => ({ ok: true as const, inputId: commit.id, row }),
        CauseText.transform((error) => ({ ok: false as const, inputId: commit.id, error })).parse,
      );
      write(`${JSON.stringify(receipt)}\n`);
      return;
    }
    const answer = output.answer;
    if (
      answer.principal.kind !== "session" ||
      answer.principal.principalId !== sessionId ||
      answer.outbound?.sourceSessionId !== sessionId
    )
      throw new ProcessSessionError("process answer principal does not match its authenticated child");
    const receipt: z.infer<typeof ProcessReplyReceipt> = await options.answer(answer).then(
      (resolution) => ({ ok: true as const, inputId: answer.inputId, resolution }),
      CauseText.transform((error) => ({ ok: false as const, inputId: answer.inputId, error })).parse,
    );
    write(`${JSON.stringify(receipt)}\n`);
  }
  return {
    wake(sessionId: string): Promise<void> {
      const existing = children.get(sessionId);
      if (existing !== undefined) return existing.done;
      const child = Bun.spawn([...options.command], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
      });
      child.stdin.write(`${JSON.stringify({ ...options.child, sessionId })}\n`);
      const done = (async () => {
        const reader = child.stdout.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          for (;;) {
            const frame = await reader.read();
            if (frame.done) break;
            buffer += decoder.decode(frame.value, { stream: true });
            let end = buffer.indexOf("\n");
            while (end >= 0) {
              const line = buffer.slice(0, end);
              buffer = buffer.slice(end + 1);
              await receive(line, sessionId, (value) => {
                child.stdin.write(value);
              });
              end = buffer.indexOf("\n");
            }
          }
          const code = await child.exited;
          if (code !== 0) throw new ProcessSessionError(`session process exited ${code}: ${sessionId}`);
        } finally {
          reader.releaseLock();
          if (child.exitCode === null) child.kill();
          child.stdin.end();
          children.delete(sessionId);
        }
      })();
      children.set(sessionId, { close: () => child.kill(), done });
      return done;
    },
    async close(): Promise<void> {
      const active = [...children.values()];
      for (const child of active) child.close();
      await Promise.allSettled(active.map((child) => child.done));
    },
  };
}
