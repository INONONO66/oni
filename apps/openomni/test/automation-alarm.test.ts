import { expect, test } from "bun:test";
import { Bundle, Core } from "@openomni/agent";
import { Effect } from "effect";
import { residentSuite } from "./helpers/resident-suite";
import { automationFixture, automationRecord } from "./helpers/automation";
import { commitArm, FIXTURE_BASE } from "./helpers/watch-fixture";
import { runAppEffect } from "../src/gateway";
import { CRON_TICK } from "../src/bundles/cron";
import { automationAlarm } from "../src/composition/automation-alarm";

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

function fireAlarm(f: Awaited<ReturnType<typeof automationFixture>>, target: string,
  armed: Awaited<ReturnType<typeof commitArm>>, purpose: string, source: string, payload: object) {
  return runAppEffect(f.app.runtime, Effect.scoped(Effect.gen(function* () {
    const client = yield* Core.SessionEntity.client;
    return yield* client(target).Alarm({ ...armed, purpose, sourceKey: source, payload: JSON.stringify(payload), fireAt: 0 });
  })));
}

test.each(["action", "prompt"] as const)("cron tick routes %s to the same entity without a self-RPC deadlock", async (kind) => {
  const source = "cron";
  const f = await automationFixture(suite);
  const target = await f.target();
  f.time.now = FIXTURE_BASE;
  const kernel = f.plane.openKernel(target);
  f.stores.automations.add(automationRecord({
    triggers: [{ type: "schedule", cron: cron.expr, tz: "UTC" }], target: `session:${target}`, kind,
  }));
  const armed = await commitArm({ kernel, fence: kernel.row(target).fence }, target, {
    purpose: CRON_TICK, at: 0, alarmId: "watch", sourceKey: source, payload: cron, ts: f.time.now,
  });
  const result = await fireAlarm(f, target, armed, CRON_TICK, source, cron);
  expect(result.outcome).toBe("delivered");
  expect(kernel.actionById(armed.occurrenceId)?.kind).toBe(kind);
  expect(kernel.actionById(`${armed.occurrenceId}:prompt`)).toBeUndefined();
  expect(f.stores.automations.decisions(armed.occurrenceId)).toEqual([expect.objectContaining({
    decision: "matched", surface: "alarm", inboundId: armed.occurrenceId,
    time: f.time.now, target: `session:${target}`,
  })]);
});

test("a monitor tick matches no schedule record, even one whose cron is the alarm id", async () => {
  const f = await automationFixture(suite);
  const target = await f.target();
  f.time.now = FIXTURE_BASE;
  const kernel = f.plane.openKernel(target);
  f.stores.automations.add(automationRecord({
    triggers: [{ type: "schedule", cron: "watch", tz: "UTC" }], target: `session:${target}`,
  }));
  const armed = await commitArm({ kernel, fence: kernel.row(target).fence }, target, {
    purpose: Bundle.MONITOR_HIT, at: 0, alarmId: "watch", sourceKey: "monitor", payload: monitor, ts: f.time.now,
  });
  await fireAlarm(f, target, armed, Bundle.MONITOR_HIT, "monitor", monitor);
  expect(f.stores.automations.decisions(armed.occurrenceId)).toEqual([]);
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

function wakeInput(sessionId: string, payload: string, occurrenceId: string) {
  const fired: Core.AlarmFired = {
    occurrenceId, purpose: CRON_TICK, alarmId: "direct", armSeq: 1, sourceKey: "cron", payload, fireAt: 0,
  };
  const prompts: string[] = [];
  const ctx: Core.AlarmWakeContext = {
    sessionId, now: FIXTURE_BASE,
    reads: { latestArm: () => undefined, settled: () => false },
    arm: () => Effect.die(new Error("unused arm")),
    prompt: (input) => Effect.sync(() => ({ seq: prompts.push(input.content) })),
  };
  return { fired, ctx, prompts };
}

test("the alarm sender is registered on the first tick only", async () => {
  const f = await automationFixture(suite);
  const registrations: string[] = [];
  const actors = {
    ...f.stores.actors,
    registerIdentity: (identity: Parameters<typeof f.stores.actors.registerIdentity>[0]) => {
      registrations.push(identity.id);
      return f.stores.actors.registerIdentity(identity);
    },
  };
  const ingress = automationAlarm(f.app.gateway, { ...f.stores, actors });
  for (const occurrenceId of ["direct:fire:1", "direct:fire:2"]) {
    const { fired, ctx, prompts } = wakeInput("ticking", JSON.stringify(cron), occurrenceId);
    await runAppEffect(f.app.runtime, ingress(fired, ctx, { content: "TICK_SENTINEL" }));
    expect(prompts).toEqual(["TICK_SENTINEL"]);
  }
  expect(registrations).toEqual(["alarm:ticking"]);
});

test.each([
  ["an unparseable payload", "{not json", "ticking"],
  ["an input outside the ingress schema", JSON.stringify(cron), ""],
])("%s is a typed wake failure, not a defect", async (_label, payload, sessionId) => {
  const f = await automationFixture(suite);
  const { fired, ctx, prompts } = wakeInput(sessionId, payload, "direct:malformed");
  const error = await runAppEffect(f.app.runtime,
    Effect.flip(automationAlarm(f.app.gateway, f.stores)(fired, ctx, { content: "UNUSED" })));
  expect(error).toBeInstanceOf(Bundle.AlarmWakeError);
  expect(error).toMatchObject({ purpose: CRON_TICK, reason: expect.stringMatching(/^malformed_payload: /) });
  expect(prompts).toEqual([]);
});
