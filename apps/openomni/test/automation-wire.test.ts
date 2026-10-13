import { expect, test } from "bun:test";
import { Ingress } from "@openomni/protocol";
import { residentSuite } from "./helpers/resident-suite";
import { automationFixture, automationRecord, automationRequest } from "./helpers/automation";
import { nextFrame } from "./helpers/ws";

const suite = residentSuite();

test("the real socket provisions, lists, disables, enables, and removes records with request correlation", async () => {
  const f = await automationFixture(suite);
  const socket = await f.socket();
  expect(await automationRequest(socket, { type: "automation_add", requestId: "add", record: automationRecord() }))
    .toMatchObject({ type: "automation_added", requestId: "add", record: { id: "build", enabled: true } });
  expect(await automationRequest(socket, { type: "automation_list", requestId: "list" }))
    .toMatchObject({ type: "automation_listed", records: [automationRecord()] });
  for (const [type, enabled] of [["automation_disable", false], ["automation_enable", true]] as const)
    expect(await automationRequest(socket, { type, requestId: type, id: "build" }))
      .toMatchObject({ requestId: type, record: { enabled } });
  expect(await automationRequest(socket, { type: "automation_remove", requestId: "remove", id: "build" }))
    .toMatchObject({ type: "automation_removed", id: "build" });
  expect(await automationRequest(socket, { type: "automation_enable", requestId: "missing", id: "build" }))
    .toMatchObject({ type: "automation_enable_refused", reason: "not_found" });
});

test("ledger filters and newest-first limits are read through the live socket", async () => {
  const f = await automationFixture(suite);
  const socket = await f.socket();
  await automationRequest(socket, { type: "automation_add", requestId: "add", record: automationRecord() });
  await f.ingest();
  f.time.now += 1;
  await f.ingest();
  const response = await automationRequest(socket, {
    type: "automation_ledger", requestId: "ledger", surface: "discord", recordId: "build",
    since: 1000, until: 1001, limit: 1,
  });
  expect(response).toMatchObject({ type: "automation_ledger_read", rows: [{ decision: "deduped" }] });
  if (response.type !== "automation_ledger_read") throw new Error("ledger refused");
  expect(response.rows).toHaveLength(1);
  expect(await automationRequest(socket, {
    type: "automation_ledger", requestId: "filtered", decision: "filtered", limit: 200,
  })).toMatchObject({ rows: [] });
});

test("invalid records produce correlated schema issues without a store write", async () => {
  const f = await automationFixture(suite);
  const socket = await f.socket();
  const response = nextFrame(socket, (frame) => frame.requestId === "invalid");
  socket.send(JSON.stringify({ type: "automation_add", requestId: "invalid", record: {} }));
  expect(Ingress.AutomationResponse.parse(await response))
    .toMatchObject({ type: "automation_add_refused", reason: "invalid_record", issues: expect.any(Array) });
  expect(f.stores.automations.list()).toEqual([]);
});
