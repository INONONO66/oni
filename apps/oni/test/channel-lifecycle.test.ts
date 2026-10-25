import { expect, test } from "bun:test";
import { Outbound } from "@oni/protocol";
import { fakeTelegramOwner, ownerRuntime } from "../../../packages/channels/test/helpers/telegram-owner-sdk";
import { createChannelSupervisor, type DesiredChannelRow, type SupervisorDeps } from "../src/bundles/provision/supervisor";
import { residentSuite } from "./helpers/resident-suite";

const suite = residentSuite();

async function fixture(scripts: readonly Parameters<typeof fakeTelegramOwner>[0][]) {
  const directory = suite.tempDir("channel-lifecycle-");
  const fakes = scripts.map((script) => fakeTelegramOwner(script));
  const rows: DesiredChannelRow[] = fakes.map((fake, index) => {
    const runtime = ownerRuntime(fake.sdk, directory);
    return {
      instanceId: `channel:telegram:owner-${index}`, key: "one", defaultTier: "owner",
      component: { id: "telegram", identity: "owner", listens: true, build: () => runtime },
    };
  });
  const delivery: SupervisorDeps["deliveryRoutes"] = new Map();
  const history: NonNullable<SupervisorDeps["historyRoutes"]> = new Map();
  const bound: string[] = [];
  const supervisor = createChannelSupervisor({
    desired: () => ({ source: "declared", rows, statuses: [] }),
    build: (component) => component.build(async () => undefined),
    grant: () => () => undefined,
    bindAccount: (_platform, account) => { bound.push(account.externalId); },
    deliveryRoutes: delivery, historyRoutes: history,
    typingRoutes: new Map(), webhookHandlers: new Map(), traceId: () => "lifecycle",
  });
  return { supervisor, delivery, history, fakes, bound, rows };
}

test("stopAll joins pending startup and forbids late routes or account binding", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { supervisor, delivery, history, fakes, bound } = await fixture([{
    onStart: () => { entered.resolve(); return release.promise; },
  }]);
  const completion: string[] = [];
  const starting = supervisor.reconcile().then(() => { completion.push("start"); });
  await entered.promise;
  expect(delivery.size).toBe(0);
  expect(history.size).toBe(0);
  const stopping = supervisor.stopAll().then(() => { completion.push("stop"); });
  release.resolve();
  await Promise.all([starting, stopping]);
  try {
    expect(completion).toEqual(["start", "stop"]);
    expect(supervisor.status()).toEqual([]);
    expect(delivery.size).toBe(0);
    expect(history.size).toBe(0);
    expect(bound).toEqual([]);
    expect(fakes[0]?.calls.filter((call) => call === "close")).toHaveLength(1);
  } finally {
    await supervisor.stopAll();
  }
});

test("busy second declaration preserves the incumbent's usable delivery and history", async () => {
  const { supervisor, delivery, history, fakes } = await fixture([{}, {}]);
  try {
    expect(await supervisor.reconcile()).toMatchObject([
      { state: "mounted" }, { state: "start_failed", detail: "session_in_use" },
    ]);
    expect(fakes[1]?.calls).toEqual([]);
    expect(await delivery.get("telegram:owner")?.("33", Outbound.payload("hello"), "one"))
      .toEqual({ value: "accepted", externalMessageId: "ack-1" });
    expect(await history.get("telegram:owner")?.({ chatId: "33", limit: 1 }))
      .toEqual({ status: "ok", page: { messages: [] } });
  } finally {
    await supervisor.stopAll();
  }
});
