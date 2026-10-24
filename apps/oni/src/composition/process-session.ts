import { z } from "zod";
import { Delivery, Gateway, SessionTransition } from "@oni/protocol";
import { Effect } from "effect";
import { CauseText, ThrownError } from "../thrown";
import type { ProcessDelivery, ProcessSessionRequest } from "../process-entry";
import type { DeliveryMedia } from "./delivery-media";
import { MEDIA_BYTE_CAP } from "./media";
import { ProcessReplyError, type ProcessReplyReceipt, RECEIPT_DEADLINE_MS } from "./process-replies";

// Promise band (#1423): the `Bun.spawn` stdin/stdout byte streams force this transport onto
// Promises; Effect takes over through injected calls, so no session state
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
  z.object({ kind: z.literal("request_media"), inputId: z.string().min(1), messageId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("request_bytes"), inputId: z.string().min(1), ref: z.string().min(1) }).strict(),
  z.object({
    kind: z.literal("request_derive"), inputId: z.string().min(1), ref: z.string().min(1), part: Gateway.MediaPart,
    model: z.object({
      input: z.array(z.enum(["text", "image", "audio", "video"])).optional(),
      api: z.object({ npm: z.string(), style: z.enum(["responses", "chat"]).optional() }).strict().optional(),
    }).strict(),
  }).strict().refine((request) => request.ref === request.part.ref),
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

/** A process is only a transport for the same durable session runner. */
export function createProcessSessionTransport(options: {
  readonly command: readonly string[];
  readonly child: Omit<ProcessSessionRequest, "sessionId">;
  readonly committed: (sessionIds: readonly string[]) => void;
  readonly answer: (answer: SessionTransition.Answer) => Promise<SessionTransition.Resolution>;
  readonly deliver: (input: ProcessDelivery) => Promise<Delivery.Row>;
  readonly media?: {
    readonly registry: DeliveryMedia;
    readonly run: <A, E>(effect: Effect.Effect<A, E>, signal: AbortSignal) => Promise<A>;
  };
}) {
  const children = new Map<string, { close: () => void; done: Promise<void> }>();
  function readBounded<A, E>(ref: string, effect: Effect.Effect<A, E>) {
    return effect.pipe(Effect.timeoutOrElse({
      duration: RECEIPT_DEADLINE_MS,
      orElse: () => Effect.fail(new ProcessReplyError("timeout", `process media operation timed out: ${ref}`)),
    }));
  }
  async function readBytes(ref: string, signal: AbortSignal) {
    const source = options.media?.registry.bytes();
    if (source === undefined || options.media === undefined)
      throw new ProcessReplyError("unbound", `process media byte source unbound: ${ref}`);
    const result = await options.media.run(readBounded(ref, Effect.suspend(() => source(ref))), signal);
    if (result.bytes.byteLength > MEDIA_BYTE_CAP)
      throw new ProcessReplyError("too_large", `process media exceeds ${MEDIA_BYTE_CAP} bytes: ${ref}`);
    return { bytes: Buffer.from(result.bytes).toString("base64"), mime: result.mime };
  }
  async function readDerivation(request: Extract<z.infer<typeof ProcessOutput>, { kind: "request_derive" }>, signal: AbortSignal) {
    const derive = options.media?.registry.derive();
    if (derive === undefined || options.media === undefined)
      throw new ProcessReplyError("unbound", `process media derivation unbound: ${request.ref}`);
    const result = await options.media.run(readBounded(request.ref, Effect.suspend(() => derive(request.part, request.model))), signal);
    return { ...result, parts: [...result.parts] };
  }
  async function receive(line: string, sessionId: string, channel: { write(value: string): void; signal: AbortSignal }) {
    const write = (receipt: z.infer<typeof ProcessReplyReceipt>) => {
      if (channel.signal.aborted) throw new ProcessSessionError(`session process closed: ${sessionId}`);
      channel.write(`${JSON.stringify(receipt)}\n`);
    };
    const output = ProcessOutput.parse(JSON.parse(line));
    if ("sessionIds" in output) {
      options.committed(output.sessionIds);
      return;
    }
    if (output.kind === "request_media") {
      write({ ok: true, inputId: output.inputId, parts: [...(options.media?.registry.recall(output.messageId) ?? [])] });
      return;
    }
    if (output.kind === "request_bytes" || output.kind === "request_derive") {
      const operation = output.kind === "request_bytes"
        ? readBytes(output.ref, channel.signal)
        : readDerivation(output, channel.signal);
      write(await operation.then(
        (value) => ({ ok: true as const, inputId: output.inputId, ...value }),
        ThrownError.transform((error) => ({
          ok: false as const, inputId: output.inputId, error: error.message,
          code: error instanceof ProcessReplyError ? error.code : "read_failed" as const,
        })).parse,
      ));
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
      write(receipt);
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
    write(receipt);
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
      const controller = new AbortController();
      void child.exited.then(() => controller.abort());
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
              await receive(line, sessionId, {
                signal: controller.signal,
                write: (value) => { child.stdin.write(value); },
              });
              end = buffer.indexOf("\n");
            }
          }
          const code = await child.exited;
          if (code !== 0) throw new ProcessSessionError(`session process exited ${code}: ${sessionId}`);
        } finally {
          reader.releaseLock();
          if (child.exitCode === null) child.kill();
          await child.exited;
          child.stdin.end();
          children.delete(sessionId);
        }
      })();
      children.set(sessionId, { close: () => { controller.abort(); child.kill(); }, done });
      return done;
    },
    async close(): Promise<void> {
      const active = [...children.values()];
      for (const child of active) child.close();
      await Promise.allSettled(active.map((child) => child.done));
    },
  };
}
