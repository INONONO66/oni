/** #1561: every model tool is bundle-owned, removable, and never shared by name. */
import { sessionTree } from "../../../packages/agent/test/store/helpers/session-tree";
import { Effect } from "effect";
import { expect, test } from "bun:test";
import { Bundle, Core } from "@oni/agent";
import { newTraceId } from "./helpers/bus";
import { assistantMessage, requestToolStep } from "./helpers/assistant-message";
import { untilCommitted } from "./helpers/committed-state";
import { openResidentRequest } from "./helpers/open-resident-request";
import { planeOf } from "./helpers/ledger";
import { residentSuite, fakeProviderModel } from "./helpers/resident-suite";
import { nextFrame } from "./helpers/ws";
import { alarmDefinition } from "./helpers/alarm-definition";
import { appManifest } from "../src/manifest";
import { createSendMessageTool } from "../src/bundles/messaging/send-message/index";
import type { TestLedgerPlane as AppLedgerPlane } from "./helpers/ledger";

const suite = residentSuite();
const TOKEN = "tool-bundle-test";

function residentSessionId(plane: AppLedgerPlane): string | undefined {
  return plane.listSessions().find((row) => row.id !== "gateway-ingress")?.id;
}

function lastTurnTerminal(plane: AppLedgerPlane, sessionId: string): string | undefined {
  return plane.openKernel(sessionId).getSnapshot(sessionId).turns.at(-1)?.terminal?.kind;
}

test("bundle_disable of a tool bundle removes its tool from the next generation", async () => {
  const toolsSeen: string[][] = [];
  let calls = 0;
  const app = await suite.boot({
    config: suite.config("tool-bundle-disable-", { wsToken: TOKEN, compactionSummarizer: false }),
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        calls += 1;
        toolsSeen.push(input.tools.map((tool) => tool.name));
        if (calls === 1)
          requestToolStep(input, sink, {
            id: "disable-bash",
            tool: "provision",
            input: { operation: { op: "bundle_disable", args: { name: "bash" } } },
          });
        else sink.onMessage(assistantMessage(input, { text: `turn ${calls} done` }));
        return { type: "stop" as const };
      }),
    },
  });
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", TOKEN]);
  const plane = await planeOf(app.runtime);
  ws.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "disable bash" }));
  const openRequest = () => openResidentRequest(plane, residentSessionId(plane));
  await untilCommitted(() => openRequest() !== undefined, "bundle_disable consent never opened");
  const request = openRequest();
  const sessionId = residentSessionId(plane);
  if (request === undefined || sessionId === undefined) throw new Error("missing consent request");
  const kernel = plane.openKernel(sessionId);
  const before = kernel.latestGenerationFor(sessionId);
  expect(toolsSeen[0]).toContain("bash");
  expect(before.bundles).toContain("bash");
  const answerId = newTraceId();
  const receipt = nextFrame(ws, (frame) => frame.type === "receipt" && frame.inputId === answerId);
  ws.send(JSON.stringify({ type: "request_answer", inputId: answerId, request, decision: "approve", credential: TOKEN }));
  await receipt;
  await untilCommitted(() => lastTurnTerminal(plane, sessionId) === "result", "disable turn never finished");
  ws.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "and now?" }));
  await untilCommitted(() => calls >= 3, "next turn never ran");
  await untilCommitted(() => lastTurnTerminal(plane, sessionId) === "result", "adopting turn never finished");
  expect(toolsSeen[2]).not.toContain("bash");
  expect(toolsSeen[2]).toContain("read");
  const after = kernel.latestGenerationFor(sessionId);
  expect(after.generation).toBe(before.generation + 1);
  expect(after.bundles).not.toContain("bash");
  expect(after.bundles).toContain("file");
  const compose = sessionTree(sessionId, plane.sessionStore(sessionId).actions).find(
    (action) =>
      action.kind === "session.configure" &&
      (action.intent.value as { operation?: string }).operation === "compose",
  );
  if (compose === undefined) throw new Error("no compose adoption configure");
  expect((compose.intent.value as { disabled?: readonly { name: string; because: string }[] }).disabled).toEqual([
    { name: "bash", because: "bash" },
  ]);
}, 40_000);

test("a second bundle declaring a product tool name is the typed duplicate refusal", async () => {
  const product = appManifest({
    alarm: await alarmDefinition(),
    wake: { close: () => undefined },
    alarms: () => undefined,
    tools: () => undefined,
  });
  const rival = Bundle.define({
    name: "rival-messages",
    requires: [],
    tools: [Core.eraseTool(createSendMessageTool(undefined, () => 0))],
  });
  const manifest = Bundle.Manifest.define({
    capabilities: [...product.capabilities],
    bundles: [...product.bundles, rival],
    off: [],
  });
  expect(() => Bundle.composeSync(manifest)).toThrow(
    expect.objectContaining({ _tag: "ComposeRefused", code: "duplicate", name: "rival-messages", detail: "tool send_message" }),
  );
});
