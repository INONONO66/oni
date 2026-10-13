import { afterEach, beforeEach, expect, test } from "bun:test";
import { Bus } from "./helpers/bus";
import { Effect } from "effect";
import { runEffect } from "./helpers/effect";
import { Tool } from "@openomni/protocol";
import { createProvisionTool } from "../src/bundles/provision/provision";
import { protectedDispatch, bounded } from "./helpers/protected-dispatch";
import { provisionPort } from "./helpers/provision-port";
import { testPlane } from "./helpers/ledger";

beforeEach(() => {
  Bus.reset();
});
afterEach(() => {
  Bus.reset();
});

test("an endpoint changed at body entry cannot spend consent for its old binding", async () => {
  const plane = testPlane();
  const actors = plane.stores.actors;
  for (const id of ["source", "target", "new-owner"])
    actors.registerIdentity({ id, kind: "human", trustTier: "collaborator" });
  actors.registerEndpoint({
    id: "endpoint",
    actorId: "source",
    channel: "ws",
    externalId: "peer",
  });
  const observations = {
    publish(event: { readonly name: string }) {
      if (event.name === Tool.Events.Started.name) {
        actors.registerEndpoint({
          id: "endpoint",
          actorId: "new-owner",
          channel: "ws",
          externalId: "peer",
        });
      }
    },
  };
  const running = protectedDispatch(
    createProvisionTool(provisionPort(plane), () => 1000),
    {
      operation: { op: "contact_merge", args: { endpointId: "endpoint", toActorId: "target" } },
    },
    observations,
    { plane },
  );
  try {
    const result = await running.answer();
    expect(result.isError).toBe(true);
    expect(actors.getEndpoint("endpoint")?.actorId).toBe("new-owner");
    expect(plane.stores.persons.list()).toEqual([]);
  } finally {
    await running.close();
  }
});

test("a second Owner decision cannot spend the same promotion CAS", async () => {
  const plane = testPlane();
  const actors = plane.stores.actors;
  actors.mintProvisional(
    { id: "contact:cas", kind: "unknown", trustTier: "observer", standing: "provisional" },
    { id: "ep:cas", channel: "ws", externalId: "cas" },
  );
  const running = protectedDispatch(createProvisionTool(provisionPort(plane), () => 1000), {
    operation: { op: "contact_promote", args: { actorId: "contact:cas" } },
  }, undefined, { plane });
  try {
    await bounded(running.opened);
    const approvals = running.executor.approvals;
    const request = approvals?.pending()[0];
    if (approvals === undefined || request === undefined) throw new Error("missing Owner request");
    expect((await running.answer()).isError).toBeUndefined();
    const promoted = actors.getIdentity("contact:cas");
    expect(promoted?.standing).toBe("registered");
    expect(await runEffect(Effect.result(approvals.answer({ request, decision: "refuse", credential: "owner-token" }))))
      .toMatchObject({ _tag: "Failure", failure: { _tag: "ExecutionApprovalError", code: "stale_approval" } });
    expect(actors.getIdentity("contact:cas")).toEqual(promoted);
  } finally {
    await running.close();
  }
});
