import { expect, test } from "bun:test";
import { AutomationRefusedError, GatewayUnavailableError } from "../src/renderer/errors";
import { automationRecord, createAutomationFixture } from "./helpers/automation-wire";

test("correlates simultaneous automation replies and rejects invalid requests before sending", async () => {
  const fixture = createAutomationFixture();
  const [listed, ledger] = await Promise.all([fixture.transport.automationList(), fixture.transport.automationLedger()]);
  expect(listed.records).toEqual([automationRecord]);
  expect(ledger.rows.length).toBe(7);
  expect(listed.requestId).not.toBe(ledger.requestId);
  const count = fixture.requests.length;
  await expect(fixture.transport.automationAdd({ ...automationRecord, triggers: [] })).rejects.toThrow();
  expect(fixture.requests).toHaveLength(count);
  await expect(fixture.transport.automationRemove("missing")).rejects.toBeInstanceOf(AutomationRefusedError);
});

test("socket drain rejects automation requests and the next call reconnects", async () => {
  let close = true;
  const fixture = createAutomationFixture([], [], (request) => close ? "close" : { type: "automation_listed", requestId: request.requestId, records: [] });
  await expect(fixture.transport.automationList()).rejects.toBeInstanceOf(GatewayUnavailableError);
  close = false;
  expect((await fixture.transport.automationList()).records).toEqual([]);
  expect(fixture.sockets).toHaveLength(2);
});

test("wrong response types fail explicitly instead of returning another method's data", async () => {
  const fixture = createAutomationFixture([], [], (request) => ({ type: "automation_removed", requestId: request.requestId, id: "wrong" }));
  await expect(fixture.transport.automationList()).rejects.toThrow("Unexpected automation response");
});

test("out-of-order and unsolicited frames cannot settle another request", async () => {
  const fixture = createAutomationFixture([], [], () => "hold");
  const first = fixture.nextRequest();
  const list = fixture.transport.automationList();
  const request = await first;
  const second = fixture.nextRequest();
  const ledger = fixture.transport.automationLedger();
  const ledgerRequest = await second;
  const socket = fixture.sockets[0];
  if (socket === undefined) throw new Error("Missing fixture socket");
  socket.deliver({ type: "automation_listed", requestId: "unsolicited", records: [automationRecord] });
  socket.deliver({ type: "automation_ledger_read", requestId: ledgerRequest.requestId, rows: [] });
  socket.deliver({ type: "automation_listed", requestId: request.requestId, records: [] });
  expect((await list).records).toEqual([]);
  expect((await ledger).rows).toEqual([]);
});
