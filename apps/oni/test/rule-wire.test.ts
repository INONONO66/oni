import { expect, test } from "bun:test";
import { Ingress } from "@oni/protocol";
import { residentSuite } from "./helpers/resident-suite";
import { automationFixture, automationRecord, automationRequest } from "./helpers/automation";
import { closeSocket, nextFrame } from "./helpers/ws";
import { ruleWire } from "../src/composition/rule-wire";
import { runEffect } from "./helpers/effect";
import { storeEditFixture } from "./helpers/store-edits";

const suite = residentSuite();

test("the Owner socket manages ordered rules before chat and after reconnect", async () => {
  const f = await automationFixture(suite);
  for (const requestId of ["first", "reconnected"]) {
    const socket = await suite.openSocket(`ws://127.0.0.1:${f.app.port}/ws`, ["auth", "owner-token"]);
    expect(await automationRequest(socket, { type: "rule_add", requestId: `${requestId}-add`, record: automationRecord({ enabled: false }) }))
      .toMatchObject({ type: "rule_added", record: { id: "build", enabled: false, createdBy: "owner" } });
    expect(await automationRequest(socket, { type: "rule_enable", requestId: `${requestId}-enable`, id: "build" }))
      .toMatchObject({ type: "rule_enabled", record: { id: "build", enabled: true } });
    expect(await automationRequest(socket, { type: "rule_move", requestId: `${requestId}-move`, id: "build", position: 1 }))
      .toMatchObject({ type: "rule_moved", record: { position: 1 } });
    const listed = await automationRequest(socket, { type: "rule_list", requestId: `${requestId}-list` });
    expect(listed).toEqual({ type: "rule_listed", requestId: `${requestId}-list`, records: f.stores.rules.list().map(({ record }) => record) });
    expect(f.stores.rules.get("build")?.approved).toBe(true);
    await closeSocket(socket);
  }
});

test("a registered peer cannot read or change rules", async () => {
  const f = await automationFixture(suite);
  f.stores.actors.registerIdentity({ id: "peer", kind: "human", trustTier: "collaborator" });
  f.stores.actors.registerEndpoint({ id: "ws:peer", actorId: "peer", channel: "ws", externalId: "peer" });
  const socket = await suite.openSocket(`ws://127.0.0.1:${f.app.port}/ws?actor=peer`, ["auth", "owner-token"]);
  expect(await automationRequest(socket, { type: "rule_add", requestId: "add", record: automationRecord() }))
    .toMatchObject({ type: "rule_add_refused", requestId: "add", reason: "require_approval" });
  expect(f.stores.rules.get("build")).toBeUndefined();
  for (const type of ["rule_enable", "rule_disable", "rule_remove"] as const) {
    expect(await automationRequest(socket, { type, requestId: type, id: "seed:alarm" }))
      .toMatchObject({ type: `${type}_refused`, reason: "require_approval" });
  }
  expect(await automationRequest(socket, { type: "rule_add", requestId: "replace", record: automationRecord({ id: "seed:alarm" }) }))
    .toMatchObject({ type: "rule_add_refused", reason: "require_approval" });
  expect(await automationRequest(socket, { type: "rule_list", requestId: "list" }))
    .toMatchObject({ type: "rule_list_refused", reason: "require_approval" });
  expect(await automationRequest(socket, { type: "rule_ledger", requestId: "ledger", limit: 1 }))
    .toMatchObject({ type: "rule_ledger_refused", reason: "require_approval" });
  expect(storeEditFixture(f.plane).rows()).toEqual([]);
});

test("seed removal is refused while disable and move remain durable", async () => {
  const f = await automationFixture(suite);
  const socket = await f.socket();
  expect(await automationRequest(socket, { type: "rule_remove", requestId: "remove", id: "seed:alarm" }))
    .toMatchObject({ type: "rule_remove_refused", reason: "seed_protected" });
  expect(await automationRequest(socket, { type: "rule_disable", requestId: "disable", id: "seed:alarm" }))
    .toMatchObject({ type: "rule_disabled", record: { enabled: false, seed: true } });
  expect(await automationRequest(socket, { type: "rule_move", requestId: "move", id: "seed:alarm", position: 0 }))
    .toMatchObject({ type: "rule_moved", record: { position: 0 } });
  expect(f.stores.rules.list()[0]?.record.id).toBe("seed:alarm");
});

test("the socket removes ordinary records and reports a missing id", async () => {
  const f = await automationFixture(suite);
  const socket = await f.socket();
  await automationRequest(socket, { type: "rule_add", requestId: "add", record: automationRecord() });
  expect(await automationRequest(socket, { type: "rule_remove", requestId: "remove", id: "build" }))
    .toEqual({ type: "rule_removed", requestId: "remove", id: "build" });
  expect(await automationRequest(socket, { type: "rule_enable", requestId: "missing", id: "build" }))
    .toMatchObject({ type: "rule_enable_refused", reason: "not_found" });
});

test("ledger filters retain newest-first limits over the live socket", async () => {
  const f = await automationFixture(suite);
  const socket = await f.socket();
  await automationRequest(socket, { type: "rule_add", requestId: "add", record: automationRecord() });
  await f.ingest();
  f.time.now++;
  await f.ingest();
  const response = await automationRequest(socket, { type: "rule_ledger", requestId: "ledger", surface: "discord", recordId: "build", since: 1000, until: 1001, limit: 1 });
  expect(response).toMatchObject({ type: "rule_ledger_read", rows: [{ decision: "deduped" }] });
  if (response.type !== "rule_ledger_read") throw new Error("ledger refused");
  expect(response.rows).toHaveLength(1);
});

test("malformed wire records return correlated issues without a store write", async () => {
  const f = await automationFixture(suite);
  const socket = await f.socket();
  const before = f.stores.rules.list();
  const response = nextFrame(socket, (frame) => frame.requestId === "invalid");
  socket.send(JSON.stringify({ type: "rule_add", requestId: "invalid", record: {} }));
  expect(Ingress.RuleResponse.parse(await response)).toMatchObject({ type: "rule_add_refused", reason: "invalid_record", issues: expect.any(Array) });
  expect(f.stores.rules.list()).toEqual(before);
});

test("a wire record cannot declare itself a seed", async () => {
  const f = await automationFixture(suite);
  const socket = await f.socket();
  const before = f.stores.rules.list();
  const response = nextFrame(socket, (frame) => frame.requestId === "seeded");
  socket.send(JSON.stringify({ type: "rule_add", requestId: "seeded", record: { ...automationRecord(), seed: true } }));
  expect(Ingress.RuleResponse.parse(await response)).toMatchObject({ type: "rule_add_refused", reason: "invalid_record" });
  expect(f.stores.rules.list()).toEqual(before);
});

test("unconfigured and failing stores answer with correlated refusal frames", async () => {
  const f = await automationFixture(suite);
  const request: Ingress.RuleRequest = { type: "rule_list", requestId: "list" };
  const edits = storeEditFixture(f.plane);
  expect(await runEffect(ruleWire(undefined, edits.port)(request, "owner"))).toMatchObject({ type: "rule_list_refused", requestId: "list", reason: "store_unconfigured" });
  const wire = ruleWire({ id: () => "new", store: { ...f.stores.rules, list: () => { throw new Error("unavailable"); } } }, edits.port);
  expect(await runEffect(wire(request, "owner"))).toMatchObject({ type: "rule_list_refused", requestId: "list", reason: "store_failed", detail: "unavailable" });
});

test.each([
  ["rule_add", "rule_added"], ["rule_move", "rule_moved"], ["rule_enable", "rule_enabled"],
  ["rule_disable", "rule_disabled"], ["rule_remove", "rule_removed"],
] as const)("%s commits exactly one settings receipt", async (type, responseType) => {
  const f = await automationFixture(suite);
  const record = automationRecord({ enabled: false });
  if (type !== "rule_add") f.stores.rules.add(record, false);
  const socket = await f.socket();
  const request: Ingress.RuleRequest = type === "rule_add"
    ? { type, requestId: type, record }
    : type === "rule_move" ? { type, requestId: type, id: record.id, position: 1 }
    : { type, requestId: type, id: record.id };
  const reply = await automationRequest(socket, request);
  expect(reply.type).toBe(responseType);
  expect(storeEditFixture(f.plane).rows()).toEqual([expect.objectContaining({
    requestId: type, time: 1000, caller: "owner", change: type === "rule_remove"
      ? { type: responseType, id: record.id }
      : { type: responseType, record: expect.objectContaining({
        id: record.id, enabled: type === "rule_enable", position: type === "rule_move" ? 1 : 0,
      }) },
  })]);
  expect(f.stores.rules.ledger({ limit: 100 })).toEqual([]);
});

test.each(["rule_list", "rule_ledger"] as const)("%s reads without writing settings receipts", async (type) => {
  const f = await automationFixture(suite);
  const socket = await f.socket();
  const reply = await automationRequest(socket, type === "rule_list"
    ? { type, requestId: type } : { type, requestId: type, limit: 10 });
  expect(reply).toEqual(type === "rule_list"
    ? { type: "rule_listed", requestId: type, records: f.stores.rules.list().map(({ record }) => record) }
    : { type: "rule_ledger_read", requestId: type, rows: [] });
  expect(storeEditFixture(f.plane).rows()).toEqual([]);
});

test("a failed rule receipt rolls back the mutation", async () => {
  const f = await automationFixture(suite);
  const edits = storeEditFixture(f.plane);
  f.plane.catalogDatabase.run("CREATE TRIGGER reject_edit BEFORE INSERT ON store_edit BEGIN SELECT RAISE(ABORT, 'receipt failed'); END");
  const response = await automationRequest(await f.socket(), {
    type: "rule_add", requestId: "rollback", record: automationRecord(),
  });
  expect(response).toMatchObject({ type: "rule_add_refused", reason: "store_failed", detail: "receipt failed" });
  expect(f.stores.rules.get("build")).toBeUndefined();
  expect(edits.rows()).toEqual([]);
});

test("tokenless loopback cannot read or write rules", async () => {
  const app = await suite.boot({ config: suite.config("rule-tokenless-", { compactionSummarizer: false }) });
  const socket = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, []);
  expect(await automationRequest(socket, { type: "rule_list", requestId: "no-token" }))
    .toMatchObject({ type: "rule_list_refused", reason: "require_approval" });
});
