import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChannelStores, Vault } from "@oni/channels";
import { Provisioning } from "@oni/protocol";
import { createCliDeps } from "../src/cli/main";
import { channelStoreSource } from "../src/gateway";
import { planeOf } from "./helpers/ledger";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { closeSocket, nextFrame } from "./helpers/ws";

const suite = residentSuite();
const homes: string[] = [];
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

/** A CLI home whose env file names the daemon's socket. */
function cliHome(port: number | string, token?: string, host = "127.0.0.1"): string {
  const home = mkdtempSync(join(tmpdir(), "oni-login-home-"));
  homes.push(home);
  mkdirSync(join(home, ".oni"), { recursive: true });
  const lines = [`ONI_WS_HOST=${host}`, `ONI_WS_PORT=${port}`, ...(token === undefined ? [] : [`ONI_WS_TOKEN=${token}`])];
  writeFileSync(join(home, ".oni", "env"), `${lines.join("\n")}\n`);
  return home;
}

/** A booted daemon whose vault is open, so a declared credential can be sealed. */
async function booted() {
  const now = () => 1000;
  const app = await suite.boot({
    config: suite.config("channel-wire-", {
      wsToken: "owner-token",
      kek: { kind: "ok", kek: Vault.kekOf(new Uint8Array(32).fill(7)) },
    }),
    llm: { resolveModel: fakeProviderModel },
  });
  const plane = await planeOf(app.runtime);
  const stores = createChannelStores(channelStoreSource(plane, now));
  return { app, plane, stores };
}

async function declare(socket: WebSocket, request: Provisioning.ChannelDeclareRequest) {
  const response = nextFrame(socket, (frame) => frame.requestId === request.requestId);
  socket.send(JSON.stringify(request));
  return Provisioning.ChannelDeclareResponse.parse(await response);
}

/**
 * The Owner's channel declaration over the socket (#1569 lane 5b): the
 * login helper's seal — the same `channel_add` the provision tool runs,
 * with the Owner as the caller, so an Owner instance passes consent by the
 * call itself; the credential is sealed into the vault by the daemon. The
 * instance is declared disabled here: the wire is consent and sealing,
 * mounting is the supervisor's and proven with the identity instances.
 */
test("the Owner's socket declares a channel, seals its credential, and reads back every status; a peer socket is refused", async () => {
  const f = await booted();
  const socket = await suite.openSocket(`ws://127.0.0.1:${f.app.port}/ws`, ["auth", "owner-token"]);
  // A bot declaration with an invalid credential: refused by the provider schema, nothing lands.
  expect(
    await declare(socket, {
      type: "channel_add",
      requestId: "bad",
      id: "channel:telegram:main",
      provider: "telegram",
      credential: { wrong: "field" },
    }),
  ).toMatchObject({ type: "channel_add_refused", requestId: "bad", reason: "refused" });
  expect(f.plane.stores.instances.get("channel:telegram:main")).toBeUndefined();
  // An Owner instance: consent is the Owner's own call here.
  expect(
    await declare(socket, {
      type: "channel_add",
      requestId: "owner",
      id: "channel:slack:owner",
      provider: "slack",
      identity: "owner",
      enabled: false,
      settings: { intake: "none", autoReply: false },
      outbound: true,
      grant: { allowedSenders: ["T1:U-friend"] },
      credential: { token: "xoxc-1", cookie: "d" },
    }),
  ).toMatchObject({
    type: "channel_declared",
    requestId: "owner",
    id: "channel:slack:owner",
    statuses: [{ id: "channel:slack:owner", state: "disabled" }],
  });
  const instance = f.plane.stores.instances.get("channel:slack:owner");
  expect(instance).toMatchObject({
    identity: "owner",
    enabled: false,
    settings: { intake: "none", autoReply: false },
    grant: { outbound: true, allowedSenders: ["T1:U-friend"] },
    createdBy: "owner",
  });
  if (instance?.credentialRef === undefined) throw new Error("the declared credential was not sealed");
  expect(f.plane.stores.secrets.get(instance.credentialRef)).toBeDefined();
  // A malformed frame is answered with the issues, never routed as chat.
  expect(
    await declare(socket, {
      type: "channel_add",
      requestId: "malformed",
      id: "",
      provider: "slack",
    } as Provisioning.ChannelDeclareRequest),
  ).toMatchObject({ type: "channel_add_refused", requestId: "malformed", reason: "invalid_record" });
  await closeSocket(socket);
  // A declared peer is not the Owner: its socket may not declare channels.
  f.stores.actors.registerIdentity({ id: "peer", kind: "human", trustTier: "collaborator" });
  f.stores.actors.registerEndpoint({ id: "ws:peer", actorId: "peer", channel: "ws", externalId: "peer" });
  const peer = await suite.openSocket(`ws://127.0.0.1:${f.app.port}/ws?actor=peer`, ["auth", "owner-token"]);
  expect(
    await declare(peer, {
      type: "channel_add",
      requestId: "peer",
      id: "channel:slack:owner",
      provider: "slack",
      identity: "owner",
      credential: { token: "xoxc-2", cookie: "d" },
    }),
  ).toMatchObject({ type: "channel_add_refused", requestId: "peer", reason: "owner_only" });
  expect(f.plane.stores.instances.get("channel:slack:owner")?.credentialRef).toBe(instance.credentialRef);
  await closeSocket(peer);
});

/**
 * The CLI's own declaration client (`oni login` without `--print`): the
 * env file names the daemon's socket, one frame goes out under the `auth`
 * subprotocol and the matching frame comes back; a daemon that is not
 * there is a typed CLI error, not a hang.
 */
test("the CLI's declaration client reaches the daemon the env file names, and reports one that is not there", async () => {
  const f = await booted();
  const deps = createCliDeps(cliHome(f.app.port, "owner-token"));
  expect(
    await deps.login.declare({
      type: "channel_add",
      requestId: "cli-1",
      id: "channel:discord:owner",
      provider: "discord",
      identity: "owner",
      enabled: false,
      settings: { intake: "none", autoReply: false },
      credential: { token: "user-token" },
    }),
  ).toMatchObject({ type: "channel_declared", requestId: "cli-1", id: "channel:discord:owner" });
  expect(f.plane.stores.instances.get("channel:discord:owner")).toMatchObject({ createdBy: "owner" });
  expect(f.plane.stores.instances.get("channel:discord:owner")?.credentialRef).toBeDefined();
  // A refusal comes back as the daemon's frame, not as an error.
  expect(
    await deps.login.declare({ type: "channel_add", requestId: "cli-2", id: "channel:telegram:main", provider: "telegram", credential: { wrong: "field" } }),
  ).toMatchObject({ type: "channel_add_refused", requestId: "cli-2", reason: "refused" });
  const nobody = createCliDeps(cliHome(1));
  await expect(
    nobody.login.declare({ type: "channel_add", requestId: "cli-3", id: "channel:discord:owner", provider: "discord" }),
  ).rejects.toThrow("could not connect to ws://127.0.0.1:1/ws");
});

/** A bare socket server standing in for a daemon that misbehaves in one exact way. */
function misbehaving(message: (ws: { close(code: number, reason: string): void; send(data: string): void }) => void) {
  return Bun.serve({
    port: 0,
    fetch: (request, server) => (server.upgrade(request) ? undefined : new Response("no", { status: 400 })),
    websocket: { message: (ws) => message(ws) },
  });
}

test("the CLI's declaration client never hangs: a closed socket, a refused frame, an unreadable frame, a refused token and a non-loopback host are typed errors; another request's frame is passed over", async () => {
  const request: Provisioning.ChannelDeclareRequest = {
    type: "channel_add",
    requestId: "cli-x",
    id: "channel:discord:owner",
    provider: "discord",
  };
  const closing = misbehaving((ws) => ws.close(1001, "going away"));
  const refusing = misbehaving((ws) => ws.send(JSON.stringify({ type: "error", reason: "invalid_frame" })));
  const babbling = misbehaving((ws) => ws.send("not json at all"));
  // A frame for another request is not this declaration's answer; the matching one is, refusal or not.
  const crosstalk = misbehaving((ws) => {
    ws.send(JSON.stringify({ type: "channel_add_refused", requestId: "someone-else", reason: "refused", detail: "theirs" }));
    ws.send(JSON.stringify({ type: "channel_add_refused", requestId: "cli-x", reason: "store_unconfigured", detail: "composed nothing" }));
  });
  try {
    expect(await createCliDeps(cliHome(crosstalk.port ?? 0)).login.declare(request)).toEqual({
      type: "channel_add_refused",
      requestId: "cli-x",
      reason: "store_unconfigured",
      detail: "composed nothing",
    });
    await expect(createCliDeps(cliHome(closing.port ?? 0)).login.declare(request)).rejects.toThrow(
      "closed the socket before answering (code 1001)",
    );
    await expect(createCliDeps(cliHome(refusing.port ?? 0)).login.declare(request)).rejects.toThrow(
      "refused the frame: invalid_frame",
    );
    await expect(createCliDeps(cliHome(babbling.port ?? 0)).login.declare(request)).rejects.toThrow(
      "the daemon answered with a frame this CLI cannot read",
    );
  } finally {
    closing.stop(true);
    refusing.stop(true);
    babbling.stop(true);
    crosstalk.stop(true);
  }
  const f = await booted();
  await expect(createCliDeps(cliHome(f.app.port, "wrong-token")).login.declare(request)).rejects.toThrow(
    "ONI_WS_TOKEN refused",
  );
  await expect(createCliDeps(cliHome(f.app.port, "owner-token", "10.0.0.9")).login.declare(request)).rejects.toThrow(
    "loopback socket only",
  );
});
