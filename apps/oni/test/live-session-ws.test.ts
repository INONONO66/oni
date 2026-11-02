import "../src/bundles/prompt/roles";
import { expect, test } from "bun:test";
import { Core } from "@oni/agent";
import { Message } from "@oni/protocol";
import { z } from "zod";
import { sessionTree } from "../../../packages/agent/test/store/helpers/session-tree";
import { testToolsBundle } from "./helpers/app-fixture";
import { planeOf } from "./helpers/ledger";
import { nextResidentTurn } from "./helpers/resident-turn";
import { residentSuite } from "./helpers/resident-suite";
import { scriptedLive } from "./helpers/scripted-live";

const suite = residentSuite();

test("the authenticated ws door selects a kernel live runner and records its gated tool", async () => {
  const bodies: number[] = [];
  const stream = scriptedLive([
    { type: "utterance_start" },
    { type: "utterance_delta", text: "Checking." },
    { type: "tool_call", call: { id: "ws-live-call", tool: "live_probe", input: { n: 7 } } },
    { type: "utterance_end" },
  ]);
  const tool = Core.defineTool({
    name: "live_probe", description: "Echo a number", category: "query",
    input: z.object({ n: z.number() }), output: z.object({ n: z.number() }),
    visibility: { model: ["resident"], cell: ["resident"] },
    execute: (input) => { bodies.push(input.n); return Promise.resolve(input); },
    render: (_input, result) => JSON.stringify(result),
  });
  const app = await suite.boot({
    config: suite.config("live-session-ws-", { wsToken: "live-token", compactionSummarizer: false }),
    bundles: [testToolsBundle([tool])],
    liveSession: () => stream.live,
  });
  const plane = await planeOf(app.runtime);
  const socket = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws?actor=owner`, ["auth", "live-token"]);
  const completed = nextResidentTurn(plane);
  socket.send(JSON.stringify({ text: "Check the live fixture", eventId: "live-ws" }));
  await completed;

  expect(bodies).toEqual([7]);
  expect(stream.sent).toMatchObject([{ type: "tool", callID: "ws-live-call", state: { status: "completed" } }]);
  const session = plane.listSessions().find((row) => row.role === "resident");
  expect(session).toBeDefined();
  if (session === undefined) throw new Error("resident missing");
  const actions = sessionTree(session.id, plane.sessionStore(session.id).actions);
  const messages = actions.flatMap((row) => {
    const value = row.effect.value;
    if (row.kind !== "message" || value === null || typeof value !== "object" || Array.isArray(value)) return [];
    const parsed = Message.WithParts.safeParse(value.result);
    return parsed.success ? [parsed.data] : [];
  });
  expect(messages).toMatchObject([{ parts: [{ type: "text", text: "Checking." }, { type: "tool", callID: "ws-live-call" }] }]);
});
