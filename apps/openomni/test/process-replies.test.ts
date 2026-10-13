import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { Delivery, SessionTransition } from "@openomni/protocol";
import { createProcessReplyChannel } from "../src/composition/process-replies";
import { runEffect } from "./helpers/effect";
import { bounded } from "./helpers/protected-dispatch";

const answer: SessionTransition.Answer = {
  inputId: "message",
  requestId: "request",
  sessionId: "receiver",
  receivedAt: 1,
  principal: { kind: "session", principalId: "child", evidenceId: "terminal" },
  bindingDigest: "binding",
  inputHash: "input",
  effectHash: "effect",
  generation: 1,
  toolsHash: "tools",
  domainRevisions: {},
  decision: "answer",
  allowedAction: "report_result",
  content: "answer",
};

const commit: Delivery.Commit = {
  id: "delivery",
  sessionId: "receiver",
  kind: "prompt",
  content: "hello",
  origin: { encodingVersion: 1, value: { kind: "session", id: "child" } },
  createdAt: 1,
  parentActionId: null,
};
const deliver = { kind: "prompt", body: JSON.stringify({ content: "hello" }), source: JSON.stringify(commit.origin.value), idempotencyKey: commit.id };

function fixture() {
  const input = new PassThrough();
  const output: string[] = [];
  const channel = createProcessReplyChannel(input, (line) => output.push(line), runEffect);
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
