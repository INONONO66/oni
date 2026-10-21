import { expect, test } from "bun:test";
import { type ChannelDeliveryRoute, type ProviderTypingRoute, Vault } from "@oni/channels";
import { z } from "zod";
import { A2A_DOOR_ID } from "../src/channels";
import { desiredChannels } from "../src/bundles/provision/declared";
import { createChannelSupervisor } from "../src/bundles/provision/supervisor";
import { putChannelCredential } from "./helpers/channel-credential";
import { testPlane } from "./helpers/ledger";
import { testChannelDeps } from "./helpers/test-entropy";

const KEY = new Uint8Array(32).fill(7);
const Answer = z.object({ result: z.object({ status: z.object({ state: z.string() }) }).optional(), error: z.object({ code: z.number() }).optional() });

function declarePeer(plane: ReturnType<typeof testPlane>, id: string, token: string, revision = 0, enabled = true): void {
  putChannelCredential(plane.stores.secrets, `secret:channel-a2a-${id}`, JSON.stringify({ token }), KEY, 1);
  plane.stores.instances.put({
    id: `channel:a2a:${id}`,
    provider: "a2a",
    identity: "bot",
    enabled,
    settings: {},
    credentialRef: `secret:channel-a2a-${id}`,
    revision,
    createdBy: "owner",
    updatedAt: 1,
  });
}

const call = (token: string) =>
  new Request("http://daemon.local/a2a", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { role: "user", parts: [{ kind: "text", text: "hi" }], messageId: `m-${token}` } } }),
  });

test("#1569 lane 9c: every a2a peer is a roster entry of the one door — mounted once, kept while any peer is declared, admitting the roster as the store and the vault hold it now", async () => {
  const plane = testPlane();
  declarePeer(plane, "scout", "scout-token");
  declarePeer(plane, "planner", "planner-token");
  const deliveryRoutes = new Map<string, ChannelDeliveryRoute>();
  const typingRoutes = new Map<string, ProviderTypingRoute>();
  const webhookHandlers = new Map<string, (request: Request) => Promise<Response>>();
  const builds: string[] = [];
  const supervisor = createChannelSupervisor({
    desired: () => desiredChannels({ instances: plane.stores.instances, secrets: plane.stores.secrets }, { kind: "ok", kek: Vault.kekOf(KEY) }, testChannelDeps()),
    build: (component) => {
      builds.push(component.id);
      return component.build(async () => undefined);
    },
    grant: () => () => undefined,
    deliveryRoutes,
    typingRoutes,
    webhookHandlers,
    traceId: () => "00-11111111111111111111111111111111-2222222222222222-01",
  });
  const verdicts = (statuses: Awaited<ReturnType<typeof supervisor.reconcile>>) => statuses.map((status) => [status.id, status.surface, status.state]);
  // Two declarations, one row: the door, under its own id, keyed by nothing a peer changes.
  expect(verdicts(await supervisor.reconcile())).toEqual([
    ["channel:a2a:scout", "a2a", "ready"],
    ["channel:a2a:planner", "a2a", "ready"],
    [A2A_DOOR_ID, "a2a", "mounted"],
  ]);
  expect(builds).toEqual(["a2a"]);
  expect([...webhookHandlers.keys()]).toEqual(["a2a"]);
  expect([...deliveryRoutes.keys()]).toEqual(["a2a"]);
  const door = (token: string) => webhookHandlers.get("a2a")?.(call(token)) ?? Promise.reject(new Error("no door"));
  expect(Answer.parse(await (await door("planner-token")).json()).result?.status.state).toBe("working");
  expect(Answer.parse(await (await door("scout-token")).json()).result?.status.state).toBe("working");
  // Disabling one peer leaves the door up for the other and drops the peer from the roster at the next request.
  declarePeer(plane, "planner", "planner-token", 1, false);
  expect(verdicts(await supervisor.reconcile())).toEqual([
    ["channel:a2a:scout", "a2a", "ready"],
    ["channel:a2a:planner", "a2a", "disabled"],
    [A2A_DOOR_ID, "a2a", "mounted"],
  ]);
  expect(builds).toEqual(["a2a"]);
  expect(webhookHandlers.has("a2a")).toBe(true);
  expect(deliveryRoutes.has("a2a")).toBe(true);
  expect((await door("planner-token")).status).toBe(401);
  expect(Answer.parse(await (await door("scout-token")).json()).result?.status.state).toBe("working");
  // A rotated bearer is read from the vault at request time: no reconcile needed.
  putChannelCredential(plane.stores.secrets, "secret:channel-a2a-scout", JSON.stringify({ token: "scout-rotated" }), KEY, 2);
  expect((await door("scout-token")).status).toBe(401);
  expect(Answer.parse(await (await door("scout-rotated")).json()).result?.status.state).toBe("working");
  // A peer declared mid-run is admitted by the door already mounted.
  declarePeer(plane, "ranger", "ranger-token");
  expect(verdicts(await supervisor.reconcile())).toContainEqual([A2A_DOOR_ID, "a2a", "mounted"]);
  expect(builds).toEqual(["a2a"]);
  expect(Answer.parse(await (await door("ranger-token")).json()).result?.status.state).toBe("working");
  // With no peer declared the door goes.
  declarePeer(plane, "scout", "scout-rotated", 1, false);
  declarePeer(plane, "ranger", "ranger-token", 1, false);
  expect(verdicts(await supervisor.reconcile())).toEqual([
    ["channel:a2a:scout", "a2a", "disabled"],
    ["channel:a2a:planner", "a2a", "disabled"],
    ["channel:a2a:ranger", "a2a", "disabled"],
  ]);
  expect(webhookHandlers.has("a2a")).toBe(false);
  expect(deliveryRoutes.has("a2a")).toBe(false);
  await supervisor.stopAll();
  plane.close();
});
