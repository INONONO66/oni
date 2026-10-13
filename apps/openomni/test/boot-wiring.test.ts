import { composedHolder } from "./helpers/bundle-fixture";
import { describe, expect, test } from "bun:test";
import {
  type ChannelDeliveryRoute,
  type ProviderDeliveryRoute,
  resolveChannelGrant,
} from "@openomni/channels";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Core } from "@openomni/agent";
import { openCatalogStore } from "../../../packages/agent/src/core/store/catalog";
type RunInput = Core.RunInput;
type Sink = Core.LlmSink;
import type { Channel } from "@openomni/protocol";
import type { BuiltChannel, ChannelComponent } from "../src/channels";
import { Effect } from "effect";
import { bootResource } from "../src/composition/boot";
import { rescanOccurrences } from "../src/composition/cluster-runtime";
import { gatewayRuntime, runAppBoot } from "../src/gateway";
import { MOUNTED_CHANNEL_DEFAULT_TIER, registerTrustedChannelGrant } from "../src/gateway";
import {
  type ChannelSupervisor,
  createChannelSupervisor,
  type DesiredChannelRow,
  type DesiredChannels,
} from "../src/provisioning/supervisor";
import { assistantMessage } from "./helpers/assistant-message";
import { planeOf } from "./helpers/ledger";
import { planeFixture } from "./helpers/plane-fixture";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { nextResidentTurn } from "./helpers/resident-turn";
import { Bus, newTraceId } from "./helpers/bus";

const suite = residentSuite();

describe("boot tool catalog", () => {
  test("boots ready without legacy work tools in the Resident catalog", async () => {
    let resolveToolNames!: (names: readonly string[]) => void;
    const toolNames = new Promise<readonly string[]>((resolve) => {
      resolveToolNames = resolve;
    });
    const app = await suite.boot({
      config: suite.config("openomni-boot-catalog-", { wsToken: "boot-catalog-token" }),
      llm: {
        resolveModel: fakeProviderModel,
        run: (input: RunInput, sink: Sink) => Effect.sync(() => {
          resolveToolNames(input.tools.map((tool) => tool.name));
          sink.onMessage(assistantMessage(input, { id: "boot-catalog-reply", text: "ready" }));
          return { type: "stop" as const };
        }),
      },
    });

    const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws?actor=owner`, [
      "auth",
      "boot-catalog-token",
    ]);
    const reply = nextResidentTurn(await planeOf(app.runtime));
    ws.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "catalog" }));

    expect(await reply).toMatchObject({ text: "ready" });
    expect(await toolNames).not.toContain("work_items");
    expect(await toolNames).not.toContain("complete_work");
  });
});

test("stopping the daemon preserves the durable WebSocket bootstrap grant", async () => {
  const config = suite.config("openomni-bootstrap-lifetime-");
  const app = await suite.boot({ config, llm: { resolveModel: fakeProviderModel } });
  if (config.catalogPath === undefined) throw new Error("suite config always sets catalogPath");
  const database = new Database(config.catalogPath, { readonly: true });
  try {
    expect((await fetch(`http://127.0.0.1:${app.port}/health`)).status).toBe(200);
    const grants = () =>
      database
        .query<Record<string, string | number | null>, [string]>(
          "SELECT * FROM channel_grant WHERE id = ?",
        )
        .all("openomni-resident-ws");
    const before = grants();
    expect(before).toHaveLength(1);
    await app.stop();
    expect(grants()).toEqual(before);
  } finally {
    database.close();
  }
});

// W5.2 L3.3b: the legacy single-DB promotion test ("967 boot preserves
// promoted expired session") is deleted with the storage plane it exercised:
// legacy `session.data` JSON rows, the delivery/alarm tables, `alarms.arm`,
// `SqliteStorageAdapter` reopen and the module-level storage accessor have
// no kernel/fence equivalent, and boot no longer promotes legacy rows.

describe("channel supervisor", () => {
  const { plane, channelStores } = planeFixture();

  interface FakeChannel {
    readonly component: ChannelComponent;
    readonly calls: string[];
    failNextStarts: number;
  }

  function fakeChannel(
    id: ChannelComponent["id"],
    calls: string[],
    options: { deliveryRoute?: ProviderDeliveryRoute; webhook?: boolean } = {},
  ): FakeChannel {
    const channel: FakeChannel = {
      calls,
      failNextStarts: 0,
      component: {
        id,
        build: (): BuiltChannel => {
          const surface: Channel.Surface = {
            id,
            config: {},
            async start() {
              if (channel.failNextStarts > 0) {
                channel.failNextStarts -= 1;
                throw new Error(`${id} start refused`);
              }
              calls.push(`start:${id}`);
            },
            async stop() {
              calls.push(`stop:${id}`);
            },
            onMessage() {
              // The handler was bound at build time; the stage never rebinds it.
            },
          };
          return {
            surface,
            ...(options.deliveryRoute === undefined
              ? {}
              : { deliveryRoute: options.deliveryRoute }),
            ...(options.webhook === true ? { webhookHandler: async () => new Response("ok") } : {}),
          };
        },
      },
    };
    return channel;
  }

  function supervisorFor(desired: () => DesiredChannels): {
    supervisor: ChannelSupervisor;
    deliveryRoutes: Map<string, ChannelDeliveryRoute>;
    webhookHandlers: Map<string, (request: Request) => Promise<Response>>;
  } {
    const deliveryRoutes = new Map<string, ChannelDeliveryRoute>();
    const webhookHandlers = new Map<string, (request: Request) => Promise<Response>>();
    const supervisor = createChannelSupervisor({
      desired,
      build: (component) => component.build(async () => undefined),
      grant: (surface, defaultTier) => registerTrustedChannelGrant(plane().stores.channelGrants, { surface, defaultTier }),
      deliveryRoutes,
      webhookHandlers,
      traceId: () => "00-11111111111111111111111111111111-2222222222222222-01",
    });
    return { supervisor, deliveryRoutes, webhookHandlers };
  }

  const row = (channel: FakeChannel, key: string, instanceId?: string): DesiredChannelRow => ({
    instanceId: instanceId ?? `channel:${channel.component.id}:main`,
    key,
    component: channel.component,
    defaultTier: MOUNTED_CHANNEL_DEFAULT_TIER,
  });

  test("a stage owns its grant, route, and webhook; stopAll revokes all of them", async () => {
    const calls: string[] = [];
    const route: ProviderDeliveryRoute = async () => ({ value: "accepted" });
    const routed = fakeChannel("telegram", calls, { deliveryRoute: route });
    const ingressOnly = fakeChannel("github", calls, { webhook: true });
    const { supervisor, deliveryRoutes, webhookHandlers } = supervisorFor(() => ({
      source: "declared",
      rows: [row(routed, "0:0"), row(ingressOnly, "0:0")],
      statuses: [],
    }));

    const statuses = await supervisor.reconcile();

    expect(statuses.map((status) => status.state)).toEqual(["mounted", "mounted"]);
    expect(calls).toEqual(["start:telegram", "start:github"]);
    expect(deliveryRoutes.get("telegram")).toBe(route);
    // Ingress-only channels register no outbound route; webhook channels land
    // in the live webhook table the HTTP surface reads per request.
    expect(deliveryRoutes.has("github")).toBe(false);
    expect(webhookHandlers.has("github")).toBe(true);
    expect(resolveChannelGrant(channelStores(), { surface: "telegram" })?.grant.kind).toBe("trusted_channel");
    // #931: the mounted stage's grant carries the row's declared tier — a
    // named surface never materializes owner authority by mounting.
    expect(resolveChannelGrant(channelStores(), { surface: "telegram" })?.grant.defaultTier).toBe(
      MOUNTED_CHANNEL_DEFAULT_TIER,
    );
    expect(resolveChannelGrant(channelStores(), { surface: "github" })?.grant.defaultTier).toBe(
      MOUNTED_CHANNEL_DEFAULT_TIER,
    );
    expect(supervisor.source()).toBe("declared");

    await supervisor.stopAll();

    expect(calls).toEqual(["start:telegram", "start:github", "stop:github", "stop:telegram"]);
    expect(deliveryRoutes.has("telegram")).toBe(false);
    expect(webhookHandlers.has("github")).toBe(false);
    expect(resolveChannelGrant(channelStores(), { surface: "telegram" })).toBeUndefined();
    expect(resolveChannelGrant(channelStores(), { surface: "github" })).toBeUndefined();
  });

  // #931 done-means 5: the grant row is observable immediately after the
  // synchronous part of reconcile resolves, at the row's exact tier, and the
  // disposal path removes it.
  test("a row's declared tier is the mounted grant's tier and disposal removes the row", async () => {
    const calls: string[] = [];
    const declared = fakeChannel("discord", calls);
    const { supervisor } = supervisorFor(() => ({
      source: "declared",
      rows: [{ ...row(declared, "0:0"), defaultTier: "observer" }],
      statuses: [],
    }));

    await supervisor.reconcile();

    expect(resolveChannelGrant(channelStores(), { surface: "discord" })?.grant.defaultTier).toBe("observer");

    await supervisor.stopAll();

    expect(resolveChannelGrant(channelStores(), { surface: "discord" })).toBeUndefined();
  });

  test("§8.7 rotation bounces exactly the changed stage, stop before start", async () => {
    const calls: string[] = [];
    const rotated = fakeChannel("telegram", calls);
    const untouched = fakeChannel("discord", calls);
    let key = "1:100";
    const { supervisor } = supervisorFor(() => ({
      source: "declared",
      rows: [row(rotated, key), row(untouched, "1:0")],
      statuses: [],
    }));

    await supervisor.reconcile();
    calls.length = 0;
    key = "1:200"; // secret_rotate bumped the rotation epoch, same revision.
    const statuses = await supervisor.reconcile();

    // The old mount released everything BEFORE its replacement started, and
    // the untouched stage never restarted.
    expect(calls).toEqual(["stop:telegram", "start:telegram"]);
    expect(statuses).toEqual([
      { id: "channel:telegram:main", surface: "telegram", state: "mounted" },
      { id: "channel:discord:main", surface: "discord", state: "mounted" },
    ]);
  });

  test("a removed declaration unmounts and a failed start unwinds fail-closed", async () => {
    const calls: string[] = [];
    const flaky = fakeChannel("telegram", calls);
    let rows: DesiredChannelRow[] = [row(flaky, "0:0")];
    const { supervisor, deliveryRoutes } = supervisorFor(() => ({
      source: "declared",
      rows,
      statuses: [],
    }));

    flaky.failNextStarts = 1;
    const failed = await supervisor.reconcile();
    expect(failed[0]).toEqual({
      id: "channel:telegram:main",
      surface: "telegram",
      state: "start_failed",
      detail: "telegram start refused",
    });
    // Fail-closed: the stage that never started owns no grant and no route.
    expect(resolveChannelGrant(channelStores(), { surface: "telegram" })).toBeUndefined();
    expect(deliveryRoutes.has("telegram")).toBe(false);

    await supervisor.reconcile();
    expect(calls).toEqual(["start:telegram"]);
    rows = [];
    const removed = await supervisor.reconcile();
    expect(removed).toEqual([]);
    expect(calls).toEqual(["start:telegram", "stop:telegram"]);
    expect(resolveChannelGrant(channelStores(), { surface: "telegram" })).toBeUndefined();
  });

  test("three consecutive start failures trip the breaker; only resume re-arms it", async () => {
    const calls: string[] = [];
    const broken = fakeChannel("telegram", calls);
    broken.failNextStarts = 3;
    const { supervisor } = supervisorFor(() => ({
      source: "declared",
      rows: [row(broken, "0:0")],
      statuses: [],
    }));

    const first = await supervisor.reconcile();
    const second = await supervisor.reconcile();
    const third = await supervisor.reconcile();
    expect(first[0]?.state).toBe("start_failed");
    expect(second[0]?.state).toBe("start_failed");
    expect(third[0]?.state).toBe("paused_by_breaker");

    // Paused means paused: further reconciles never touch the surface again.
    const paused = await supervisor.reconcile();
    expect(paused[0]?.state).toBe("paused_by_breaker");
    expect(paused[0]?.detail).toBe("3 consecutive start failures; channel_enable re-arms it");
    expect(calls).toEqual([]);

    expect(supervisor.resume("channel:telegram:main")).toBe(true);
    expect(supervisor.resume("channel:telegram:main")).toBe(false);
    const resumed = await supervisor.reconcile();
    expect(resumed[0]?.state).toBe("mounted");
    expect(calls).toEqual(["start:telegram"]);
    expect(supervisor.status()).toEqual(resumed);
    await supervisor.stopAll();
  });

  test("app scope disposal drives stopAll exactly like shutdown", async () => {
    const calls: string[] = [];
    const channel = fakeChannel("telegram", calls);
    const { supervisor } = supervisorFor(() => ({
      source: "declared",
      rows: [row(channel, "0:0", "channel:telegram:main")],
      statuses: [],
    }));
    const runtime = gatewayRuntime({ composed: composedHolder(), observations: Bus });
    await runAppBoot(
      runtime,
      bootResource(Effect.succeed(supervisor), (resource) =>
        Effect.promise(() => resource.stopAll()),
      ),
    );
    await supervisor.reconcile();

    expect(calls).toEqual(["start:telegram"]);
    expect(supervisor.source()).toBe("declared");
    await runtime.dispose();
    expect(calls).toEqual(["start:telegram", "stop:telegram"]);
    expect(supervisor.status()).toEqual([]);
  });
});

describe("supervisor status passthrough", () => {
  test("profile statuses surface verbatim in the reconcile verdict, detail included", async () => {
    const deliveryRoutes = new Map<string, ChannelDeliveryRoute>();
    const webhookHandlers = new Map<string, (request: Request) => Promise<Response>>();
    const supervisor = createChannelSupervisor({
      desired: () => ({
        source: "declared",
        rows: [],
        statuses: [
          {
            id: "channel:discord:main",
            provider: "discord",
            state: "vault_locked",
            detail: "no KEK",
          },
          { id: "channel:slack:main", provider: "slack", state: "disabled" },
        ],
      }),
      build: () => {
        throw new Error("nothing to build");
      },
      grant: () => {
        throw new Error("nothing to grant");
      },
      deliveryRoutes,
      webhookHandlers,
      traceId: () => "00-11111111111111111111111111111111-2222222222222222-01",
    });

    const statuses = await supervisor.reconcile();

    expect(statuses).toEqual([
      { id: "channel:discord:main", surface: "discord", state: "vault_locked", detail: "no KEK" },
      { id: "channel:slack:main", surface: "slack", state: "disabled" },
    ]);
  });
});

// ─── #1254 S3: boot alarm rescan ───

describe("boot alarm rescan", () => {
  const DAY_MS = 86_400_000;
  const NOW = 100 * DAY_MS;

  test("targets has_armed sessions always, idle sessions past the floor, everything under full", () => {
    const sessions = [
      { id: "active", lastActivityAt: NOW - DAY_MS },
      { id: "idle", lastActivityAt: NOW - 8 * DAY_MS },
      { id: "flagged", lastActivityAt: NOW },
    ];
    const sweep = { full: false, idleDays: 7 };

    const rescans = rescanOccurrences({
      armedSessionIds: ["flagged"],
      sessions,
      sweep,
      bootId: "boot-1",
      now: NOW,
    });
    expect(rescans.map((rescan) => rescan.sessionId)).toEqual(["flagged", "idle"]);
    expect(rescans[0]?.occurrence).toEqual({
      occurrenceId: "flagged:rescan:boot-1",
      purpose: "rescan",
      alarmId: "flagged:rescan",
      armSeq: 0,
      sourceKey: "rescan",
      payload: "{}",
      fireAt: NOW,
    });

    // A flagged session that is also idle stays one target (set semantics).
    expect(
      rescanOccurrences({
        armedSessionIds: ["idle"],
        sessions,
        sweep,
        bootId: "boot-1",
        now: NOW,
      }).map((rescan) => rescan.sessionId),
    ).toEqual(["idle"]);

    // Full sweep: every session, and a new boot id mints new occurrences.
    const full = rescanOccurrences({
      armedSessionIds: [],
      sessions,
      sweep: { full: true, idleDays: 7 },
      bootId: "boot-2",
      now: NOW,
    });
    expect(full.map((rescan) => rescan.sessionId)).toEqual(["active", "flagged", "idle"]);
    expect(full.map((rescan) => rescan.occurrence.occurrenceId)).toEqual([
      "active:rescan:boot-2",
      "flagged:rescan:boot-2",
      "idle:rescan:boot-2",
    ]);
  });

  test("the catalog flag feeds the sweep: markArmed round-trips through armedSessionIds", () => {
    const directory = mkdtempSync(join(tmpdir(), "boot-rescan-catalog-"));
    const catalog = openCatalogStore(join(directory, "catalog.sqlite"), {
      now: () => 1,
    });
    try {
      catalog.indexSession({ id: "s-armed", parentId: null, role: "resident", createdAt: 1 });
      catalog.indexSession({ id: "s-quiet", parentId: null, role: "resident", createdAt: 1 });
      expect(catalog.armedSessionIds()).toEqual([]);

      catalog.markArmed("s-armed", true);
      expect(catalog.armedSessionIds()).toEqual(["s-armed"]);
      expect(
        rescanOccurrences({
          armedSessionIds: catalog.armedSessionIds(),
          sessions: [],
          sweep: { full: false, idleDays: 7 },
          bootId: "boot-3",
          now: NOW,
        }).map((rescan) => rescan.occurrence.occurrenceId),
      ).toEqual(["s-armed:rescan:boot-3"]);

      catalog.markArmed("s-armed", false);
      expect(catalog.armedSessionIds()).toEqual([]);
    } finally {
      catalog.close();
      rmSync(directory, { recursive: true });
    }
  });
});
