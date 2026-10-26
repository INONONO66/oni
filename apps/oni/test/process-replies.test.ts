import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { Delivery } from "@oni/protocol";
import { createProcessReplyChannel, ProcessReplyError } from "../src/composition/process-replies";
import { z } from "zod";
import { Effect, Logger } from "effect";
import { runEffect } from "./helpers/effect";
import { bounded } from "./helpers/protected-dispatch";
import { answer } from "./helpers/child-answer";
import { MEDIA_BYTE_CAP } from "../src/composition/media";

const commit: Delivery.Commit = {
  id: "delivery",
  sessionId: "receiver",
  kind: "prompt",
  content: [{ kind: "text", text: "hello" }],
  origin: { encodingVersion: 1, value: { kind: "session", id: "child" } },
  createdAt: 1,
  parentActionId: null,
};
const deliver = { kind: "prompt", body: JSON.stringify({ content: commit.content }), source: JSON.stringify(commit.origin.value), idempotencyKey: commit.id };

function fixture(onWrite?: (line: string) => void) {
  const input = new PassThrough();
  const output: string[] = [];
  const channel = createProcessReplyChannel(input, (line) => { output.push(line); onWrite?.(line); }, runEffect);
  return {
    input,
    output,
    channel,
    [Symbol.dispose]() {
      channel.close();
      input.destroy();
    },
  };
}

test("process receiving transport correlates replies without minting another request lifecycle", async () => {
  using f = fixture();
  f.input.write("initial-request\n");
  expect(await bounded(f.channel.first)).toBe("initial-request");
  const received = f.channel.answer(answer);
  expect(f.output).toEqual([JSON.stringify({ kind: "request_answer", answer })]);
  await expect(f.channel.answer(answer)).rejects.toThrow("already in flight");
  f.input.write(
    `${JSON.stringify({ ok: true, inputId: answer.inputId, resolution: "resolved" })}\n`,
  );
  expect(await bounded(received)).toBe("resolved");
  const retry = f.channel.answer(answer);
  f.input.write(
    `${JSON.stringify({ ok: true, inputId: answer.inputId, resolution: "duplicate" })}\n`,
  );
  expect(await bounded(retry)).toBe("duplicate");
});

const MediaRequest = z.object({
  kind: z.literal("request_bytes"), inputId: z.string(), ref: z.string(),
});

test("bytes share correlation with an answer without changing the reference", async () => {
  using f = fixture((line) => {
    const frame = MediaRequest.safeParse(JSON.parse(line));
    if (!frame.success) return;
    const request = frame.data;
    const value = { bytes: Buffer.from([0, 255, 1]).toString("base64"), mime: "image/png" };
    f.input.write(`${JSON.stringify({ ok: true, inputId: request.inputId, ...value })}\n`);
  });
  f.input.write("initial\n");
  await f.channel.first;
  const answering = f.channel.answer(answer);
  expect(await runEffect(f.channel.media.bytes("mac:/inbox/a.png")))
    .toEqual({ bytes: new Uint8Array([0, 255, 1]), mime: "image/png" });
  expect(f.output.slice(1).map((line) => MediaRequest.parse(JSON.parse(line))))
    .toMatchObject([{ kind: "request_bytes", ref: "mac:/inbox/a.png" }]);
  f.input.write(`${JSON.stringify({ ok: true, inputId: answer.inputId, resolution: "resolved" })}\n`);
  expect(await answering).toBe("resolved");
});

test("wrong byte receipt fails its typed pending operation", async () => {
  using f = fixture((line) => {
    const { inputId } = MediaRequest.parse(JSON.parse(line));
    f.input.write(`${JSON.stringify({ ok: true, inputId, resolution: "resolved" })}\n`);
  });
  f.input.write("initial\n");
  await f.channel.first;
  const result = runEffect(f.channel.media.bytes("ref"));
  await expect(result).rejects.toMatchObject({ name: "ProcessReplyError", code: "invalid_receipt" });
});

test.each(["unbound", "read_failed", "too_large"] as const)("byte refusal preserves the parent's %s code", async (code) => {
  using f = fixture((line) => {
    const { inputId } = MediaRequest.parse(JSON.parse(line));
    f.input.write(`${JSON.stringify({ ok: false, inputId, code, error: "source refused" })}\n`);
  });
  f.input.write("initial\n");
  await f.channel.first;
  await expect(runEffect(f.channel.media.bytes("ref"))).rejects.toMatchObject({
    name: "ProcessReplyError", code, message: "source refused",
  });
});

test("parent close settles byte waits and refuses requests after close", async () => {
  const written = Promise.withResolvers<void>();
  using f = fixture(() => written.resolve());
  f.input.write("initial\n");
  await f.channel.first;
  const request = () => runEffect(f.channel.media.bytes("ref"));
  const waiting = request().then(() => undefined, (error: Error) => error);
  await written.promise;
  f.input.end();
  expect(await bounded(waiting)).toMatchObject({ name: "ProcessReplyError", code: "closed" });
  await expect(request()).rejects.toBeInstanceOf(ProcessReplyError);
});

test("invalid base64 cannot enter a byte source", async () => {
  using f = fixture((line) => {
    const { inputId } = MediaRequest.parse(JSON.parse(line));
    f.input.write(`${JSON.stringify({ ok: true, inputId, bytes: "%%%", mime: "image/png" })}\n`);
  });
  f.input.write("initial\n");
  await f.channel.first;
  await expect(runEffect(f.channel.media.bytes("ref"))).rejects.toMatchObject({ code: "invalid_receipt" });
});

test.each([MEDIA_BYTE_CAP - 1, MEDIA_BYTE_CAP, MEDIA_BYTE_CAP + 1])(
  "child byte receipts admit decoded size %i exactly through the cap", async (size) => {
    using f = fixture((line) => {
      const { inputId } = MediaRequest.parse(JSON.parse(line));
      const encoded = Buffer.alloc(size, 0x5a).toString("base64");
      expect(encoded.length).toBe(Math.ceil(MEDIA_BYTE_CAP / 3) * 4);
      f.input.write(`${JSON.stringify({ ok: true, inputId, bytes: encoded, mime: "image/png" })}\n`);
    });
    f.input.write("initial\n");
    await f.channel.first;
    const result = runEffect(f.channel.media.bytes("ref"));
    if (size > MEDIA_BYTE_CAP) {
      await expect(result).rejects.toMatchObject({ name: "ProcessReplyError", code: "invalid_receipt" });
    } else {
      const accepted = await bounded(result);
      expect(accepted.mime).toBe("image/png");
      expect(accepted.bytes).toHaveLength(size);
      expect(accepted.bytes[0]).toBe(0x5a);
      expect(accepted.bytes.at(-1)).toBe(0x5a);
    }
  },
);

test.each(["parts", "wrong"] as const)("a derive reply with %s and absent model metadata stays typed", async (mode) => {
  using f = fixture((line) => {
    const frame = z.object({ kind: z.literal("request_derive"), inputId: z.string(), model: z.object({}).strict() }).parse(JSON.parse(line));
    f.input.write(`${JSON.stringify({
      ok: true, inputId: frame.inputId, ...(mode === "parts" ? { parts: [] } : { resolution: "resolved" }),
    })}\n`);
  });
  f.input.write("initial\n");
  await f.channel.first;
  const warnings: string[] = [];
  const logger = Logger.make((entry) => {
    if (entry.logLevel === "Warn") warnings.push(z.array(z.union([
      z.string(), z.object({ ref: z.string(), err: z.string() }).transform((context) => context.err),
    ])).parse(entry.message).join("\n"));
  });
  expect(await runEffect(f.channel.media.derive({ kind: "audio", ref: "note" }, {})
    .pipe(Effect.provide(Logger.layer([logger]))))).toEqual({ parts: [] });
  expect(warnings).toHaveLength(mode === "parts" ? 0 : 1);
  if (mode === "wrong") expect(warnings[0]).toContain("ProcessReplyError: process derive receipt carries no parts");
});

test("process receiving refusal reaches the source instead of becoming an acknowledgement", async () => {
  using f = fixture();
  f.input.write("initial\n");
  await f.channel.first;
  const received = f.channel.answer(answer);
  const refused = received.then(
    () => null,
    (error: Error) => error,
  );
  f.input.write(
    `${JSON.stringify({ ok: false, inputId: answer.inputId, error: "receiver refused" })}\n`,
  );
  expect(await bounded(refused)).toMatchObject({ message: "receiver refused" });
});

test("a well-formed receipt of the other shape fails exactly its pending operation", async () => {
  // The wire accepts both receipt shapes; a delivery answered with a
  // resolution (or an answer with a row) is a protocol fault the pending
  // operation surfaces, never a success with a fabricated value.
  using f = fixture();
  f.input.write("initial\n");
  await f.channel.first;
  const delivered = f.channel.deliver({ commit, deliver }).then(
    () => null,
    (error: Error) => error,
  );
  f.input.write(`${JSON.stringify({ ok: true, inputId: commit.id, resolution: "resolved" })}\n`);
  expect(await bounded(delivered)).toMatchObject({ message: "process delivery receipt carries no row" });
  const answered = f.channel.answer(answer).then(
    () => null,
    (error: Error) => error,
  );
  const { parentActionId: _parent, ...fields } = commit;
  const row: Delivery.Row = { ...fields, status: "pending", consumedBy: null, consumedAt: null, ordinal: 1 };
  f.input.write(`${JSON.stringify({ ok: true, inputId: answer.inputId, row })}\n`);
  expect(await bounded(answered)).toMatchObject({ message: "process answer receipt carries no resolution" });
});

test.each([
  "malformed",
  "unsolicited",
] as const)("process receiving %s response fails its exact pending operation", async (mode) => {
  using f = fixture();
  f.input.write("initial\n");
  await f.channel.first;
  const received = f.channel.answer(answer);
  const rejected = received.then(
    () => null,
    (error: Error) => error,
  );
  f.input.write(
    mode === "malformed"
      ? "{\n"
      : `${JSON.stringify({ ok: true, inputId: "other", resolution: "resolved" })}\n`,
  );
  expect(await bounded(rejected)).toBeInstanceOf(Error);
});

test("closing process input settles both the missing initial frame and a pending response", async () => {
  using unopened = fixture();
  unopened.input.end();
  expect(await bounded(unopened.channel.first)).toBeUndefined();
  using pending = fixture();
  pending.input.write("initial\n");
  await pending.channel.first;
  const received = pending.channel.answer(answer);
  const rejected = received.then(
    () => null,
    (error: Error) => error,
  );
  pending.channel.close();
  expect(await bounded(rejected)).toMatchObject({ message: "process reply transport closed" });
});
