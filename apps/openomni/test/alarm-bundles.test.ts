import { expect, test } from "bun:test";
import { Bundle, Core } from "@openomni/agent";
import type { PlainObject } from "@openomni/protocol";
import { Effect } from "effect";
import { CRON_TICK, cronBundle, cronPurposes } from "../src/bundles/alarms/cron/index";
import { monitorBundle, monitorPurposes } from "../src/bundles/alarms/monitor/index";
import { ToolCapabilitySeam } from "../src/bundles/seams";
import { runEffect } from "./helpers/effect";

/** A recording `AlarmWakeContext.prompt` — the core's verb, stubbed for assertion. */
function recordingPrompt() {
  const prompts: Parameters<Bundle.AlarmPromptVerb>[0][] = [];
  const prompt: Bundle.AlarmPromptVerb = (input) => {
    prompts.push(input);
    return Effect.succeed({ seq: prompts.length });
  };
  return { prompts, prompt };
}

async function composedCapability(): Promise<Bundle.AlarmCapabilityDefinition> {
  return await runEffect(
    Bundle.alarmCapability({
      bundles: [monitorPurposes({ close: () => undefined }), cronPurposes()],
      arm: () => () => Effect.die(new Error("unused arm")),
      watch: { install: () => Effect.void },
    }),
  );
}

test("alarmCapability composes the monitor and cron purposes under their owning bundles", async () => {
  const capability = await composedCapability();
  // The composed registry binds each product purpose to its declaring bundle.
  expect([...capability.registry.entries()].filter(([, owner]) => owner !== "core")).toEqual([
    ["monitor.hit", "monitor"],
    ["monitor.timeout", "monitor"],
    ["cron.tick", "cron"],
  ]);
});

const cronFired = (payload: PlainObject, fireAt: number): Bundle.AlarmFired => ({
  occurrenceId: "grid:tick:1",
  purpose: CRON_TICK,
  alarmId: "grid",
  armSeq: 1,
  sourceKey: "cron",
  payload: JSON.stringify(payload),
  fireAt,
});

function cronWake(refuse?: Core.ArmRefused["code"]) {
  const { prompts, prompt } = recordingPrompt();
  const arms: Parameters<Bundle.ArmVerb>[0][] = [];
  const declaration = cronPurposes().purposes[0];
  if (declaration === undefined) throw new Error("missing cron purpose");
  const wake = (fired: Bundle.AlarmFired, now: number) =>
    declaration.handler({
      fired,
      ctx: {
        sessionId: "cron-session",
        reads: { latestArm: () => undefined, settled: () => false },
        arm: (input) => {
          arms.push(input);
          if (refuse !== undefined) return Effect.fail(new Core.ArmRefused({ code: refuse }));
          return Effect.succeed({
            alarmId: input.alarmId ?? "grid",
            occurrenceId: "occ-next",
            armSeq: arms.length,
          });
        },
        now,
        prompt,
      },
    });
  return { prompts, arms, wake };
}

const payload = { expr: "*/5 * * * *", tz: "UTC", description: "five-minute grid" };

test("cron.tick prompts once and re-arms the chain at the next grid time", async () => {
  const { prompts, arms, wake } = cronWake();
  // On time: fired at 0:05, woken at 0:05 — nothing missed, next tick 0:10.
  expect(await runEffect(wake(cronFired(payload, 300_000), 300_000))).toBe("delivered");
  expect(prompts).toEqual([
    {
      content: JSON.stringify({
        kind: CRON_TICK,
        description: "five-minute grid",
        expr: "*/5 * * * *",
        firedAt: 300_000,
        missed: 0,
        missedSaturated: false,
      }),
      payload: { expr: "*/5 * * * *", missed: 0, missedSaturated: false },
    },
  ]);
  expect(arms).toEqual([
    {
      purpose: CRON_TICK,
      at: 600_000,
      alarmId: "grid",
      supersedes: "grid:tick:1",
      sourceKey: "cron",
      payload,
    },
  ]);
  // Downtime: fired at 0:05, woken at 0:20:10 — 0:10, 0:15 and 0:20 elapsed
  // in (fireAt, now]; one prompt carries the count, no catch-up storm.
  expect(await runEffect(wake(cronFired(payload, 300_000), 1_210_000))).toBe("delivered");
  expect(prompts).toHaveLength(2);
  expect(prompts.at(-1)).toMatchObject({
    payload: { expr: "*/5 * * * *", missed: 3, missedSaturated: false },
  });
  expect(arms.at(-1)).toMatchObject({ at: 1_500_000 });
});

test("cron.tick counts every grid instant lost to downtime: */30 asleep 3h reports missed: 6", async () => {
  const { prompts, arms, wake } = cronWake();
  const half = { expr: "*/30 * * * *", tz: "UTC", description: "half-hour grid" };
  // Issue #1254 line 64: fired at 10:00Z, host slept, woken at 13:00Z. The six
  // elapsed grid instants in (fireAt, now] are 10:30, 11:00, 11:30, 12:00,
  // 12:30 and 13:00 — missed: 6, and the chain re-arms at 13:30.
  const firedAt = Date.UTC(2026, 0, 1, 10, 0);
  const now = Date.UTC(2026, 0, 1, 13, 0);
  expect(await runEffect(wake(cronFired(half, firedAt), now))).toBe("delivered");
  expect(prompts).toEqual([
    {
      content: JSON.stringify({
        kind: CRON_TICK,
        description: "half-hour grid",
        expr: "*/30 * * * *",
        firedAt,
        missed: 6,
        missedSaturated: false,
      }),
      payload: { expr: "*/30 * * * *", missed: 6, missedSaturated: false },
    },
  ]);
  expect(arms).toEqual([
    {
      purpose: CRON_TICK,
      at: Date.UTC(2026, 0, 1, 13, 30),
      alarmId: "grid",
      supersedes: "grid:tick:1",
      sourceKey: "cron",
      payload: half,
    },
  ]);
});

test("cron.tick saturates the missed count at 1024 and the prompt says at least (#1254 r2 M1)", async () => {
  const { prompts, arms, wake } = cronWake();
  const minute = { expr: "* * * * *", tz: "UTC", description: "minute grid" };
  // 1025 elapsed minute ticks: the count stops at the 1024 cap WITHOUT
  // materializing more, and the payload discloses the saturation instead of
  // reporting an exact-looking truncated number.
  const firedAt = Date.UTC(2026, 0, 1, 0, 0);
  const now = firedAt + 1025 * 60_000;
  expect(await runEffect(wake(cronFired(minute, firedAt), now))).toBe("delivered");
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toMatchObject({
    payload: { expr: "* * * * *", missed: 1024, missedSaturated: true },
  });
  // The machine-consumed saturation contract is the parsed fields; the
  // human-facing `note` sentence is prose and deliberately NOT pinned (r3 M1).
  expect(JSON.parse(prompts[0]?.content ?? "{}")).toMatchObject({
    missed: 1024,
    missedSaturated: true,
  });
  expect(arms.at(-1)).toMatchObject({ at: now + 60_000 });
});

test("cron.tick surfaces a refused grid re-arm as a typed wake failure carrying the refusal code", async () => {
  const { wake, prompts } = cronWake("alarm_budget");
  const refused = await runEffect(Effect.flip(wake(cronFired(payload, 300_000), 300_000)));
  expect(refused).toBeInstanceOf(Bundle.AlarmWakeError);
  expect(refused.reason).toBe("alarm_budget");
  // The prompt for the fired tick was still raised before the re-arm was refused.
  expect(prompts).toHaveLength(1);
});

test("cron.tick reports payload and expression faults as typed wake failures", async () => {
  const { wake } = cronWake();
  const bad = await runEffect(Effect.flip(wake(cronFired({ not: "cron" }, 300_000), 300_000)));
  expect(bad).toBeInstanceOf(Bundle.AlarmWakeError);
  expect(bad.reason).toBe("payload");
  const expr = await runEffect(
    Effect.flip(wake(cronFired({ ...payload, expr: "not a cron line" }, 300_000), 300_000)),
  );
  expect(expr.reason).toBe("cron_expr");
});

// ─── #1255 P2: the Bundle.define contracts the manifest composes ────────────

test("monitorBundle declares the sealed tool face, the wake budget row and the watch purposes", () => {
  const monitor = monitorBundle({ close: () => undefined }, () => undefined);
  expect(monitor.contract).toBe("bundle");
  expect(monitor.name).toBe("monitor");
  expect(monitor.requires.map((seam) => seam.key)).toEqual([
    Bundle.AlarmSeam.key,
    ToolCapabilitySeam.key,
  ]);
  // The 12-tool catalog stays sealed: the bundle declares the same `monitor` face.
  expect(monitor.tools.map((tool) => tool.name)).toEqual(["monitor"]);
  expect(monitor.rows).toEqual([
    {
      id: "monitor/tool.pre#1",
      on: "tool.pre",
      when: { op: "monitor" },
      do: "gate",
      how: { ref: "kernel/budget-clamp", metric: "notifications", limit: 8 },
      order: 900,
    },
  ]);
  expect(Object.keys(monitor.purposes).sort()).toEqual([Bundle.MONITOR_HIT, Bundle.MONITOR_TIMEOUT].sort());
});

test("cronBundle declares the one cron.tick purpose and nothing else", () => {
  const cron = cronBundle();
  expect(cron.contract).toBe("bundle");
  expect(cron.name).toBe("cron");
  expect(cron.requires.map((seam) => seam.key)).toEqual([Bundle.AlarmSeam.key]);
  expect(cron.tools).toEqual([]);
  expect(cron.rows).toEqual([]);
  expect(Object.keys(cron.purposes)).toEqual([CRON_TICK]);
});

test("the port-less monitor tool face refuses execution with a typed refusal", async () => {
  const face = monitorBundle({ close: () => undefined }, () => undefined).tools[0];
  if (face === undefined) throw new Error("missing monitor tool face");
  const attempt = face.execute(
    { operation: { op: "cancel", id: "w-1" } },
    { sessionId: "s", turnId: "t", callId: "c-1", signal: new AbortController().signal },
  );
  expect(attempt).rejects.toThrow("alarm port unavailable");
});
