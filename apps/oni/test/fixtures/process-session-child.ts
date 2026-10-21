import { createInterface } from "node:readline";

// Stand-in for process-entry's stdio side: speaks the transport wire format
// (doorbell + request_answer frames in, receipt lines back) without a model.
const scenario = process.argv[2];
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
async function next(): Promise<string> {
  const item = await lines.next();
  if (item.done) throw new Error("parent closed stdin");
  return item.value;
}
const request = JSON.parse(await next()) as { sessionId: string };
const answer = (inputId: string, principalId: string) => ({
  kind: "request_answer",
  answer: {
    inputId,
    requestId: "request",
    sessionId: "owner",
    receivedAt: 1,
    principal: { kind: "session", principalId, evidenceId: "terminal" },
    bindingDigest: "binding",
    inputHash: "input",
    effectHash: "effect",
    generation: 1,
    toolsHash: "tools",
    domainRevisions: {},
    decision: "answer",
    allowedAction: "report_result",
    content: inputId,
    outbound: {
      messageId: `${inputId}-message`,
      sourceSessionId: request.sessionId,
      sourceActionId: `${inputId}-action`,
      destinationSessionId: "owner",
      requestId: "request",
      replyTo: "request",
      terminal: "completed",
      content: inputId,
      digest: "digest",
    },
  },
});
switch (scenario) {
  case "conversation": {
    console.log(JSON.stringify({ sessionIds: ["child-a", "child-b"] }));
    const receipts: string[] = [];
    for (const inputId of ["first", "second"]) {
      console.log(JSON.stringify(answer(inputId, request.sessionId)));
      receipts.push(await next());
    }
    const expected = [
      JSON.stringify({ ok: true, inputId: "first", resolution: "resolved" }),
      JSON.stringify({ ok: false, inputId: "second", error: "owner refused" }),
    ];
    if (receipts.join("\n") !== expected.join("\n")) {
      console.error(`unexpected receipts: ${JSON.stringify(receipts)}`);
      process.exit(3);
    }
    break;
  }
  case "impostor":
    console.log(JSON.stringify(answer("forged", "someone-else")));
    await next();
    break;
  case "malformed":
    console.log("{not-json}");
    await next();
    break;
  case "linger":
    console.log(JSON.stringify({ sessionIds: [request.sessionId] }));
    await next();
    break;
  case "ack-crash":
    console.log(JSON.stringify({ sessionIds: [request.sessionId] }));
    break;
  case "crash":
    break;
  default:
    throw new Error(`unknown scenario ${scenario}`);
}
// readline keeps stdin open; a settled child must not outlive its conversation.
process.exit(scenario === "crash" || scenario === "ack-crash" ? 2 : 0);
