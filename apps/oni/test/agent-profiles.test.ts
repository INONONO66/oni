import { expect, test } from "bun:test";
import type { Core } from "@oni/agent";
import { Gateway, Provisioning, SessionGeneration, type Delivery } from "@oni/protocol";
import { Effect } from "effect";
import { materializeDeliveryTarget, prepareMessage } from "../src/composition/message-session";
import { buildAgentPrompt } from "../src/bundles/prompt/build";
import { runEffect } from "./helpers/effect";
import { residentRunner } from "./helpers/resident-runner";
import { fakeProviderModel } from "./helpers/resident-suite";
import { assistantMessage, requestToolStep } from "./helpers/assistant-message";

const custom = {
  id: "x",
  prompt: { identity: "IDENTITY_SENTINEL", mandate: "MANDATE_SENTINEL", policies: "POLICIES_SENTINEL", style: "STYLE_SENTINEL" },
  tools: ["eval"],
  model: "fake/family/custom",
};

function delivery(createSession: ReturnType<ReturnType<typeof residentRunner>["genesis"]>): Delivery.Commit {
  return {
    id: `${createSession.row.id}:input`, sessionId: createSession.row.id,
    kind: "prompt", content: [{ kind: "text", text: "INPUT_SENTINEL" }],
    origin: { encodingVersion: 1, value: { kind: "external", inboundTreatment: "full_access" } },
    createdAt: 10, parentActionId: null, createSession,
  };
}

test("a custom session uses its prompt sections model and restricted execution catalog", async () => {
  const seen: Core.RunInput[] = [];
  let forbiddenRuns = 0;
  const resident = residentRunner({
    model: { provider: "fake", id: "default" }, apiKey: "test", tools: {
      cells: { cell: {
        run: async () => { forbiddenRuns += 1; throw new Error("denied tool ran"); },
        peek: async () => { throw new Error("unused"); },
        stop: async () => { throw new Error("unused"); },
      } },
    },
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        seen.push(input);
        const result = requestToolStep(input, sink, {
          id: "forbidden", tool: "eval", input: { operation: { op: "run", code: "1" } },
        });
        if (result !== undefined) {
          expect(result.isError).toBe(true);
          sink.onMessage(assistantMessage(input, { text: "DONE" }));
        }
        return { type: "stop" as const };
      }),
    },
  });
  resident.plane.stores.agents.add({ ...custom, tools: [] });
  await runEffect(materializeDeliveryTarget(
    resident.plane, delivery(resident.genesis("custom", null, "resident", "native", "x")), () => 10,
  ));
  await resident.prompt("custom", "INPUT_SENTINEL");
  expect(seen.length).toBeGreaterThan(1);
  expect(seen[0]?.system).toBe(`${buildAgentPrompt({ name: custom.id, ...custom.prompt })}\n\nnative`);
  expect(seen[0]?.model.id).toBe("family/custom");
  expect(seen[0]?.tools).toEqual([]);
  expect(seen[0]?.toolChoice).toBe("none");
  expect(forbiddenRuns).toBe(0);
  expect(resident.plane.read.session("custom").row("custom")).toMatchObject({ agent: "x", role: "resident" });
});

test.each(["x", undefined])("delegation selects %s independently of the child's lineage", async (agent) => {
  const calls: Core.RunInput[] = [];
  const resident = residentRunner({
    model: { provider: "fake", id: "default" }, apiKey: "test", tools: {},
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        calls.push(input);
        sink.onMessage(assistantMessage(input, { text: "DONE" }));
        return { type: "stop" as const };
      }),
    },
  });
  resident.plane.stores.agents.add({ ...custom, tools: ["eval", "provision"] });
  await resident.prompt("parent", "PARENT");
  const send = Gateway.SendMessage.parse({
    to: { kind: "new_session", role: "child", runner: "native", parent: "me", ...(agent === undefined ? {} : { agent }) },
    type: "message", content: "CHILD",
  });
  const prepared = await runEffect(prepareMessage(resident.plane, resident.genesis)(
    { kind: "session", id: "parent" }, send, "delegated", "delegation",
  ));
  if (prepared.createSession === undefined) throw new Error("missing child genesis");
  await runEffect(materializeDeliveryTarget(resident.plane, delivery(prepared.createSession), () => 10));
  await resident.prompt("delegated", "CHILD");
  const profile = resident.plane.stores.agents.get(agent ?? "child");
  const child = calls.find((call) => call.trace.sessionId === "delegated");
  expect(resident.plane.read.session("delegated").row("delegated")).toMatchObject({
    agent: agent ?? "child", role: "child", parentId: "parent",
  });
  expect(child?.system).toBe(`${buildAgentPrompt({ name: profile.id, ...profile.prompt })}\n\nnative`);
  expect(child?.model.id).toBe(agent === undefined ? "default" : "family/custom");
  expect(child?.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(profile.tools.filter((name) => name === "eval")));
  if (agent !== undefined) expect(child?.tools.map((tool) => tool.name)).toEqual(["eval"]);
});

test("disabled profiles refuse new sessions but existing sessions keep their persona", async () => {
  const resident = residentRunner({
    model: { provider: "fake", id: "default" }, apiKey: "test", tools: {},
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        sink.onMessage(assistantMessage(input, { text: "DONE" }));
        return { type: "stop" as const };
      }),
    },
  });
  resident.plane.stores.agents.add(custom);
  const create = resident.genesis("existing", null, "resident", "native", "x");
  await runEffect(materializeDeliveryTarget(resident.plane, delivery(create), () => 10));
  resident.plane.stores.agents.disable("x");
  expect(() => resident.genesis("new", null, "resident", "native", "x")).toThrow(Provisioning.AgentError);
  expect(() => resident.genesis("new", null, "resident", "native", "missing")).toThrow(Provisioning.AgentError);
  await resident.prompt("existing", "CONTINUE");
  expect(resident.plane.read.session("existing").row("existing").agent).toBe("x");
  expect(SessionGeneration.ConfigureIntent.parse(create.initialAction.intent.value).agent).toBe("x");
});
