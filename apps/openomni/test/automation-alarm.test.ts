import { expect, test } from "bun:test";
import { Bundle, Core } from "@openomni/agent";
import { Effect } from "effect";
import { residentSuite } from "./helpers/resident-suite";
import { automationFixture, automationRecord } from "./helpers/automation";
import { commitArm, FIXTURE_BASE } from "./helpers/watch-fixture";
import { runAppEffect } from "../src/gateway";
import { CRON_TICK } from "../src/bundles/cron";

const suite = residentSuite();
const cron = { expr: "* * * * *", tz: "UTC", description: "CRON_SENTINEL" };
const monitor = {
  spec: {
    watch: { command: "unused", description: "WATCH_SENTINEL", persistent: true },
    policyGeneration: 1, notificationLimit: 8,
  },
  notifications: 0,
  hit: { content: "MONITOR_SENTINEL", terminal: true, detail: "exit:0" },
};

test.each(["cron", "monitor"] as const)("%s tick reaches the matcher and the same entity without a self-RPC deadlock", async (source) => {
  const f = await automationFixture(suite);
  const target = await f.target();
  f.time.now = FIXTURE_BASE;
  const kernel = f.plane.openKernel(target);
  const purpose = source === "cron" ? CRON_TICK : Bundle.MONITOR_HIT;
  const payload = source === "cron" ? cron : monitor;
  f.stores.automations.add(automationRecord({
    triggers: [{ type: "schedule", cron: source === "cron" ? cron.expr : "watch", tz: "UTC" }],
    target: `session:${target}`, kind: "action",
  }));
  const armed = await commitArm({ kernel, fence: kernel.row(target).fence }, target, {
    purpose, at: 0, alarmId: "watch", sourceKey: source, payload, ts: f.time.now,
  });
  const result = await runAppEffect(f.app.runtime, Effect.scoped(Effect.gen(function* () {
    const client = yield* Core.SessionEntity.client;
    return yield* client(target).Alarm({
      ...armed, purpose, sourceKey: source, payload: JSON.stringify(payload), fireAt: 0,
    });
  })));
  expect(result.outcome).toBe("delivered");
  expect(kernel.actionById(armed.occurrenceId)?.kind).toBe("action");
  expect(kernel.actionById(`${armed.occurrenceId}:prompt`)).toBeUndefined();
  expect(f.stores.automations.decisions(armed.occurrenceId)).toEqual([expect.objectContaining({
    decision: "matched", surface: "alarm", inboundId: armed.occurrenceId,
    time: f.time.now, target: `session:${target}`,
  })]);
});

test("a filtered schedule tick writes no local prompt shortcut", async () => {
  const f = await automationFixture(suite);
  const target = await f.target();
  f.time.now = FIXTURE_BASE;
  const kernel = f.plane.openKernel(target);
  f.stores.automations.add(automationRecord({
    triggers: [{ type: "schedule", cron: cron.expr, tz: "UTC" }],
    target: `session:${target}`, conditions: { contains: ["ABSENT"] },
  }));
  const armed = await commitArm({ kernel, fence: kernel.row(target).fence }, target, {
    purpose: CRON_TICK, at: 0, alarmId: "filtered", sourceKey: "cron", payload: cron, ts: f.time.now,
  });
  await runAppEffect(f.app.runtime, Effect.scoped(Effect.gen(function* () {
    const client = yield* Core.SessionEntity.client;
    return yield* client(target).Alarm({
      ...armed, purpose: CRON_TICK, sourceKey: "cron", payload: JSON.stringify(cron), fireAt: 0,
    });
  })));
  expect(kernel.actionById(armed.occurrenceId)).toBeUndefined();
  expect(kernel.actionById(`${armed.occurrenceId}:prompt`)).toBeUndefined();
  expect(f.stores.automations.decisions(armed.occurrenceId)).toEqual([expect.objectContaining({ decision: "filtered" })]);
});
