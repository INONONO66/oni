import { ledger } from "../helpers/ledger.js";
import { runEffect } from "../../../../../packages/channels/test/helpers/effect.js";
import { beforeEach, expect, test } from "bun:test";

import { openRequest } from "../helpers/requests.js";
import {
  commits,
  createMappedOwnerSession,
  kernelRouter,
  ownerFacts,
  ownerSender,
  registerOwnerDm,
  resetRouterState,
  routingDecisions,
} from "./_router-fixture.js";

beforeEach(() => {
  resetRouterState();
  registerOwnerDm();
});

test("delivery receipt target equals the durable route decision", async () => {
  const mapped = createMappedOwnerSession();
  const result = await runEffect(kernelRouter().ingest(ownerSender, ownerFacts));
  expect(result).toMatchObject({
    status: "executed",
    handle: { target: mapped.id },
    delivery: { kind: "session" },
  });
  expect(routingDecisions()[0]).toMatchObject({
    sessionId: mapped.id,
    actorId: "actor-owner",
    trustTier: "owner",
  });
  expect(commits[0]).toMatchObject({
    sessionId: mapped.id,
    origin: { value: { kind: "external", actorId: "actor-owner" } },
  });
});

test("Request correlation selects the owner delivery instead of the default session", async () => {
  const mapped = createMappedOwnerSession();
  await runEffect(await openRequest("request-contract", {
    correlation: { tokenHash: "token", channelId: ownerFacts.channelId },
    expectedResponders: ["actor-owner"],
  }));
  const result = await runEffect(kernelRouter().ingest(ownerSender, {
    ...ownerFacts,
    reply: { chain: [], tokenHash: "token" },
    payload: { action: "report_result", output: "done" },
    render: "done",
  }));
  expect(result).toMatchObject({ status: "executed", handle: { target: "request-owner" } });
  expect(commits[0]?.sessionId).not.toBe(mapped.id);
  expect(routingDecisions()[0]).toMatchObject({
    stage: "request_correlation",
    sessionId: "request-owner",
  });
  expect(ledger().kernel.requestById("request-contract")?.state).toBe("resolved");
});
