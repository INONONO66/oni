import { AppInvariantError } from "../invariant";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { EffectRunner } from "@oni/channels";
import type { PartBytes, PartDerive } from "@oni/llm";
import { Deferred, Effect, Exit, Result } from "effect";
import { ThrownError } from "../thrown";
import { Delivery, Gateway, SessionTransition } from "@oni/protocol";
import { z } from "zod";
import type { ProcessDelivery } from "../process-entry";
import type { DeliveryMedia } from "./delivery-media";
import { MEDIA_BYTE_CAP } from "./media";

// Promise band (#1423): readline and stdio force the reply channel onto Promises;
// every bounded wait enters Effect through the injected run port.
export const RECEIPT_DEADLINE_MS = 30_000;

const ReplyCode = z.enum(["closed", "timeout", "invalid_receipt", "refused", "unbound", "read_failed", "too_large"]);
export class ProcessReplyError extends Error {
  constructor(readonly code: z.infer<typeof ReplyCode>, message: string) {
    super(message);
    this.name = "ProcessReplyError";
  }
}

export const ProcessReplyReceipt = z.union([
  z.object({ ok: z.literal(true), inputId: z.string().min(1), resolution: SessionTransition.Resolution }).strict(),
  z.object({ ok: z.literal(true), inputId: z.string().min(1), row: Delivery.Row }).strict(),
  z.object({
    ok: z.literal(true), inputId: z.string().min(1), parts: z.array(Gateway.MediaPart), text: z.string().optional(),
  }).strict(),
  z.object({
    ok: z.literal(true),
    inputId: z.string().min(1),
    bytes: z.base64().max(Math.ceil(MEDIA_BYTE_CAP / 3) * 4)
      .refine((value) => Buffer.byteLength(value, "base64") <= MEDIA_BYTE_CAP),
    mime: z.string().min(1),
  }).strict(),
  z.object({
    ok: z.literal(false), inputId: z.string().min(1), error: z.string(), code: ReplyCode.optional(),
  }).strict(),
]);
type Receipt = z.infer<typeof ProcessReplyReceipt>;

export interface ProcessMedia {
  readonly bytes: PartBytes;
  readonly derive: PartDerive;
  readonly load: (registry: DeliveryMedia, ids: readonly string[]) => Effect.Effect<void, Error>;
}

/** Transport response correlation only; durable delivery truth remains in the source action tree. */
export function createProcessReplyChannel(
  input: Readable,
  write: (line: string) => void,
  run: EffectRunner,
) {
  const lines = createInterface({ input });
  const first = Promise.withResolvers<string | undefined>();
  let opened = false;
  const pending = new Map<string, Deferred.Deferred<Receipt, Error>>();
  // Keep the last 256 expired correlations in FIFO order; older IDs are
  // unsolicited again. A retry with the same ID owns its new pending slot.
  const expired = new Set<string>();
  let closed: Error | undefined;
  function fail(error: Error): void {
    closed = error;
    first.reject(error);
    for (const entry of pending.values()) Deferred.doneUnsafe(entry, Exit.fail(error));
  }
  lines.on("line", (line) => {
    if (!opened) {
      opened = true;
      first.resolve(line);
      return;
    }
    const parsed = Result.try({
      try: () => ProcessReplyReceipt.parse(JSON.parse(line)),
      catch: ThrownError.parse,
    });
    if (Result.isFailure(parsed)) {
      fail(new ProcessReplyError("invalid_receipt", parsed.failure.message));
      return;
    }
    const receipt = parsed.success;
    const entry = pending.get(receipt.inputId);
    if (entry === undefined) {
      if (expired.has(receipt.inputId)) return;
      fail(new ProcessReplyError("invalid_receipt", "unsolicited process receiving receipt"));
      return;
    }
    Deferred.doneUnsafe(entry, Exit.succeed(receipt));
  });
  lines.on("close", () => {
    if (!opened) first.resolve(undefined);
    fail(new ProcessReplyError("closed", "process reply transport closed"));
  });
  lines.on("error", fail);
  async function request(input: { readonly inputId: string; readonly frame: object; readonly operation: string }) {
    if (closed !== undefined) throw closed;
    if (pending.has(input.inputId)) throw new AppInvariantError("process reply is already in flight");
    const response = Deferred.makeUnsafe<Receipt, Error>();
    expired.delete(input.inputId);
    pending.set(input.inputId, response);
    try {
      write(JSON.stringify(input.frame));
      const receipt = await run(Deferred.await(response).pipe(
        Effect.timeoutOrElse({
          duration: RECEIPT_DEADLINE_MS,
          orElse: () => {
            expired.add(input.inputId);
            for (const oldest of expired) {
              if (expired.size <= 256) break;
              expired.delete(oldest);
            }
            return Effect.fail(new ProcessReplyError("timeout", `process ${input.operation} receipt timed out`));
          },
        }),
      ));
      if (!receipt.ok) throw new ProcessReplyError(receipt.code ?? "refused", receipt.error);
      return receipt;
    } finally {
      pending.delete(input.inputId);
    }
  }
  const recall = async (messageId: string) => {
    const inputId = crypto.randomUUID();
    const receipt = await request({ inputId, operation: "media", frame: { kind: "request_media", inputId, messageId } });
    if (!("parts" in receipt)) throw new ProcessReplyError("invalid_receipt", "process media receipt carries no parts");
    return receipt.parts;
  };
  const media: ProcessMedia = {
    load: (registry, ids) => Effect.forEach(ids, (id) => Effect.tryPromise({
      try: () => recall(id),
      catch: ThrownError.parse,
    }).pipe(Effect.map((parts) => registry.remember(id, parts))), { discard: true }),
    derive: (part, model) => Effect.tryPromise({
      try: async () => {
        const inputId = crypto.randomUUID();
        const receipt = await request({
          inputId, operation: "derive",
          frame: { kind: "request_derive", inputId, ref: part.ref, part, model: {
            input: model.input,
            api: model.api === undefined ? undefined : { npm: model.api.npm, style: model.api.style },
          } },
        });
        if (!("parts" in receipt)) throw new ProcessReplyError("invalid_receipt", "process derive receipt carries no parts");
        return { parts: receipt.parts, ...(receipt.text === undefined ? {} : { text: receipt.text }) };
      },
      catch: ThrownError.parse,
    }).pipe(Effect.catch((error) => Effect.logWarning("process media derivation unavailable", {
      ref: part.ref, err: String(error),
    }).pipe(Effect.as({ parts: [] })))),
    bytes: (ref) => Effect.tryPromise({
      try: async () => {
        const inputId = crypto.randomUUID();
        const receipt = await request({ inputId, operation: "bytes", frame: { kind: "request_bytes", inputId, ref } });
        if (!("bytes" in receipt)) throw new ProcessReplyError("invalid_receipt", "process bytes receipt carries no bytes");
        return { bytes: new Uint8Array(Buffer.from(receipt.bytes, "base64")), mime: receipt.mime };
      },
      catch: ThrownError.parse,
    }),
  };
  return {
    first: first.promise,
    media,
    async answer(answer: SessionTransition.Answer): Promise<SessionTransition.Resolution> {
      const receipt = await request({ inputId: answer.inputId, operation: "receiving", frame: { kind: "request_answer", answer } });
      if (!("resolution" in receipt)) throw new ProcessReplyError("invalid_receipt", "process answer receipt carries no resolution");
      return receipt.resolution;
    },
    /** #1346: one child delivery, admitted by the parent's Session entity; the receipt is the pending row. */
    async deliver(input: ProcessDelivery): Promise<Delivery.Row> {
      const receipt = await request({
        inputId: input.commit.id, operation: "delivery",
        frame: { kind: "request_deliver", commit: input.commit, deliver: input.deliver },
      });
      if (!("row" in receipt)) throw new ProcessReplyError("invalid_receipt", "process delivery receipt carries no row");
      return receipt.row;
    },
    close() {
      lines.close();
      input.pause();
    },
  };
}
