import { APPROVAL_POLICY } from "../src/bundles/approval-policy/index";
import { testToolPorts } from "./helpers/tool-ports";
import { Effect } from "effect";
import { runEffect } from "./helpers/effect";
import { expect, test } from "bun:test";
import { newTraceId } from "./helpers/bus";
import { Bus } from "./helpers/bus";
import { Component } from "@openomni/protocol";
import { observeComponent } from "../src/observation/component";
import { createResident } from "../src/composition/resident";
import { allowConfigure } from "./helpers/generation-services";
import { testPlane } from "./helpers/ledger";

test("component failure observation preserves an unprintable rejection", async () => {
  const failure = {
    toString() {
      throw new Error("conversion failed");
    },
  };
  const states: string[] = [];
  const unsubscribe = [
    Bus.subscribe(Component.Events.Active, () => {
      states.push("active");
    }),
    Bus.subscribe(Component.Events.Failed, () => {
      states.push("failed");
    }),
    Bus.subscribe(Component.Events.Disposed, () => {
      states.push("disposed");
    }),
  ];
  const component = observeComponent({
    traceId: newTraceId(),
    sessionId: "unprintable",
    runId: "run",
    componentId: "fixture",
    componentGeneration: 1,
  }, Bus);
  try {
    const result = await runEffect(Effect.flip(component.run(Effect.fail(failure))));
    expect(result).toBe(failure);
    expect(states).toEqual(["active", "failed", "disposed"]);
  } finally {
    for (const stop of unsubscribe) stop();
  }
});

test("resident genesis refuses unregistered runners before storage", () => {
  const plane = testPlane();
  const resident = createResident({
    model: { provider: "fixture", id: "fixture" },
    apiKey: "fixture",
    tools: { ...testToolPorts,},
    sessionRuntime: {
      approvalPolicy: APPROVAL_POLICY,
      authorizeConfigure: allowConfigure,
      openKernel: plane.openKernel,
      listSessions: plane.listSessions,
    },
    policyGeneration: () => 1,
  });
  expect(() => resident.genesis("invalid", null, "resident", "missing")).toThrow();
});
