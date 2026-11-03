import { expect, test } from "bun:test";
import { Provisioning } from "@oni/protocol";
import { agentWire } from "../src/composition/agent-wire";
import { automationFixture } from "./helpers/automation";
import { residentSuite } from "./helpers/resident-suite";
import { storeEditFixture } from "./helpers/store-edits";
import { nextFrame } from "./helpers/ws";
import { testPlane } from "./helpers/ledger";

const suite = residentSuite();
const profile = Provisioning.Agent.parse({
  id: "research", prompt: { identity: "Researcher", mandate: "Verify sources" }, tools: ["read"],
});
const owner = { authenticated: true, caller: "owner" } as const;

async function request(socket: WebSocket, frame: Provisioning.AgentRequest) {
  const reply = nextFrame(socket, (value) => value.requestId === frame.requestId);
  socket.send(JSON.stringify(frame));
  return Provisioning.AgentResponse.parse(await reply);
}

test("agent_list returns stored profiles without a settings receipt", async () => {
  const f = await automationFixture(suite);
  f.plane.stores.agents.add(profile);
  const reply = await request(await f.socket(), { type: "agent_list", requestId: "list" });
  expect(reply).toEqual({ type: "agent_listed", requestId: "list", records: f.plane.stores.agents.list() });
  expect(storeEditFixture(f.plane).rows()).toEqual([]);
});

test("agent_add stores the profile with one settings receipt", async () => {
  const f = await automationFixture(suite);
  const reply = await request(await f.socket(), { type: "agent_add", requestId: "add", record: profile });
  expect(reply).toEqual({ type: "agent_added", requestId: "add", record: profile });
  expect(f.plane.stores.agents.get(profile.id)).toEqual(profile);
  expect(storeEditFixture(f.plane).rows()).toEqual([expect.objectContaining({
    requestId: "add", time: 1000, caller: "owner", change: { type: "agent_added", record: profile },
  })]);
});

test("agent_disable retains the profile with one settings receipt", async () => {
  const f = await automationFixture(suite);
  f.plane.stores.agents.add(profile);
  const reply = await request(await f.socket(), { type: "agent_disable", requestId: "disable", id: profile.id });
  const disabled = { ...profile, enabled: false };
  expect(reply).toEqual({ type: "agent_disabled", requestId: "disable", record: disabled });
  expect(f.plane.stores.agents.get(profile.id)).toEqual(disabled);
  expect(storeEditFixture(f.plane).rows()).toEqual([expect.objectContaining({
    requestId: "disable", time: 1000, caller: "owner", change: { type: "agent_disabled", record: disabled },
  })]);
});

test.each(["resident", "child"])("agent_disable refuses the %s seed without a receipt", async (id) => {
  const f = await automationFixture(suite);
  expect(await request(await f.socket(), { type: "agent_disable", requestId: id, id }))
    .toMatchObject({ type: "agent_disable_refused", requestId: id, reason: "seed_protected" });
  expect(f.plane.stores.agents.get(id).enabled).toBe(true);
  expect(storeEditFixture(f.plane).rows()).toEqual([]);
});

test("duplicate and missing agent writes refuse without receipts", async () => {
  const f = await automationFixture(suite);
  f.plane.stores.agents.add(profile);
  const socket = await f.socket();
  expect(await request(socket, { type: "agent_add", requestId: "duplicate", record: profile }))
    .toMatchObject({ type: "agent_add_refused", reason: "duplicate" });
  expect(await request(socket, { type: "agent_disable", requestId: "missing", id: "missing" }))
    .toMatchObject({ type: "agent_disable_refused", reason: "not_found" });
  expect(storeEditFixture(f.plane).rows()).toEqual([]);
});

test("a registered peer cannot read or change agent rows", async () => {
  const f = await automationFixture(suite);
  f.stores.actors.registerIdentity({ id: "peer", kind: "human", trustTier: "collaborator" });
  f.stores.actors.registerEndpoint({ id: "ws:peer", actorId: "peer", channel: "ws", externalId: "peer" });
  const socket = await suite.openSocket(`ws://127.0.0.1:${f.app.port}/ws?actor=peer`, ["auth", "owner-token"]);
  for (const frame of [
    { type: "agent_list", requestId: "list" },
    { type: "agent_add", requestId: "add", record: profile },
    { type: "agent_disable", requestId: "disable", id: "resident" },
  ] satisfies Provisioning.AgentRequest[]) {
    expect(await request(socket, frame)).toMatchObject({ type: `${frame.type}_refused`, reason: "owner_auth_required" });
  }
  expect(storeEditFixture(f.plane).rows()).toEqual([]);
});

test("malformed agent frames cannot fall through to chat", async () => {
  const f = await automationFixture(suite);
  const socket = await f.socket();
  const reply = nextFrame(socket, (value) => value.requestId === "invalid");
  socket.send(JSON.stringify({ type: "agent_add", requestId: "invalid", record: {}, text: "not a prompt" }));
  expect(Provisioning.AgentResponse.parse(await reply)).toMatchObject({
    type: "agent_add_refused", requestId: "invalid", reason: "invalid_record",
  });
  expect(storeEditFixture(f.plane).rows()).toEqual([]);
});

test("tokenless loopback cannot read agent rows", async () => {
  const app = await suite.boot({ config: suite.config("agent-tokenless-", { compactionSummarizer: false }) });
  const socket = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, []);
  expect(await request(socket, { type: "agent_list", requestId: "no-token" }))
    .toMatchObject({ type: "agent_list_refused", reason: "owner_auth_required" });
});

test("a failed agent receipt rolls back its profile write", async () => {
  const f = await automationFixture(suite);
  f.plane.catalogDatabase.run("CREATE TRIGGER reject_edit BEFORE INSERT ON store_edit BEGIN SELECT RAISE(ABORT, 'receipt failed'); END");
  expect(await request(await f.socket(), { type: "agent_add", requestId: "rollback", record: profile }))
    .toMatchObject({ type: "agent_add_refused", reason: "store_failed", detail: "receipt failed" });
  expect(f.plane.stores.agents.list().some((row) => row.id === profile.id)).toBe(false);
  expect(storeEditFixture(f.plane).rows()).toEqual([]);
});

test("agent frame recognition and unavailable stores remain typed", () => {
  const plane = testPlane();
  try {
    const edits = storeEditFixture(plane);
    const wire = agentWire(undefined, edits.port);
    for (const data of ["null", "[]", '"text"', "{}"]) expect(wire(data, owner)).toBeUndefined();
    expect(wire(Buffer.from('{"type":"agent_list","requestId":"list"}'), owner))
      .toMatchObject({ type: "agent_list_refused", requestId: "list", reason: "store_unconfigured" });
    expect(wire('{"type":"agent_list"}', owner))
      .toMatchObject({ type: "agent_list_refused", requestId: "invalid", reason: "invalid_record" });
  } finally {
    plane.close();
  }
});
