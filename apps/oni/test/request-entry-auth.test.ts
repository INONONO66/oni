import { expect, test } from "bun:test";
import { Effect } from "effect";
import { canonicalDigest } from "@oni/protocol";
import { approvalRequest } from "./helpers/approval-request";
import { assistantMessage, requestToolStep } from "./helpers/assistant-message";
import { newTraceId } from "./helpers/bus";
import { untilCommitted } from "./helpers/committed-state";
import { planeOf } from "./helpers/ledger";
import { openResidentRequest } from "./helpers/open-resident-request";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { nextFrame } from "./helpers/ws";

const suite = residentSuite();

test("an authenticated socket still requires the Owner credential on a request answer", async () => {
  const app = await suite.boot({
    config: suite.config("answer-auth-", { wsToken: "owner-token" }),
  });
  const socket = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "owner-token"]);
  const parsedInput = { operation: { op: "status", args: {} } };
  const request = { ...approvalRequest(parsedInput, {}), inputHash: canonicalDigest(parsedInput) };
  const receipt = nextFrame(
    socket,
    (frame) => frame.type === "receipt" && frame.inputId === "auth-check",
  );
  socket.send(
    JSON.stringify({
      type: "request_answer",
      inputId: "auth-check",
      request,
      decision: "approve",
      credential: "wrong-owner",
    }),
  );
  expect((await receipt).result).toMatchObject({
    status: "blocked_pre",
    reasonCode: "request_answer.unauthenticated",
  });
});

test("#1600 lane R3: on a tokenless loopback boot the socket answers an open request with an empty credential — authenticated under the loopback rule, the request resolves and the turn goes on", async () => {
  let calls = 0;
  const app = await suite.boot({
    config: suite.config("answer-tokenless-", { compactionSummarizer: false }),
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        calls += 1;
        if (calls === 1)
          requestToolStep(input, sink, {
            id: "disable-monitor",
            tool: "provision",
            input: { operation: { op: "bundle_disable", args: { name: "monitor" } } },
          });
        else sink.onMessage(assistantMessage(input, { text: `turn ${calls} done` }));
        return { type: "stop" as const };
      }),
    },
  });
  const socket = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, []);
  const plane = await planeOf(app.runtime);
  const residentSessionId = () => plane.listSessions().find((row) => row.id !== "gateway-ingress")?.id;
  socket.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "disable the monitor bundle" }));
  const openRequest = () => openResidentRequest(plane, residentSessionId());
  await untilCommitted(() => openRequest() !== undefined, "bundle_disable consent never opened");
  const request = openRequest();
  if (request === undefined) throw new Error("missing consent request");
  const answerId = newTraceId();
  const receipt = nextFrame(socket, (frame) => frame.type === "receipt" && frame.inputId === answerId);
  socket.send(JSON.stringify({ type: "request_answer", inputId: answerId, request, decision: "approve", credential: "" }));
  expect((await receipt).result).toMatchObject({ status: "executed" });
  await untilCommitted(() => openRequest() === undefined, "the approved request never resolved");
}, 40_000);
