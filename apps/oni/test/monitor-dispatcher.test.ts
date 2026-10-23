import { policySnapshot } from "../../../packages/agent/test/helpers/compiled-policy";
import { dispatcherFixture } from "./helpers/dispatcher-fixture";
import { expect, test } from "bun:test";
import { Bundle, Core } from "@oni/agent";
const eraseTool = Core.eraseTool;
const ExecutorContextError = Core.ExecutorContextError;
const ToolRefused = Core.ToolRefused;
import { Effect, Exit, Cause } from "effect";
import { createMonitorTool } from "../src/bundles/alarms/monitor/index";
import { alarmChainReads, foldAlarmChains } from "../src/bundles/alarms/index";
import { runEffect } from "./helpers/effect";
import { FIXTURE_BASE, awaitScheduled, scheduledAt, withEntityAlarmPorts } from "./helpers/watch-fixture";
import { activeInvocation } from "../../../packages/agent/src/core/loop/executor";

test("monitor schema and dispatcher keep one strict create/rearm/cancel surface", async () => {
  const monitorTool = createMonitorTool(() => undefined);
  for (const input of [
    {
      op: "create",
      description: "command",
      source: { kind: "command", command: "echo yes", persistent: true },
    },
    {
      op: "create",
      description: "path",
      source: { kind: "path", path: "/tmp/target", event: "modify", timeout_ms: 20 },
    },
    {
      op: "create",
      description: "cron",
      source: { kind: "cron", expr: "*/5 * * * *", tz: "UTC" },
    },
    { op: "rearm", id: "watch" },
    { op: "cancel", id: "watch" },
  ])
    expect(monitorTool.input.safeParse({ operation: input }).success).toBe(true);
  for (const input of [
    { op: "create", description: "no lifetime", source: { kind: "command", command: "echo yes" } },
    {
      op: "create",
      description: "both",
      source: { kind: "command", command: "echo yes", persistent: true, timeout_ms: 1 },
    },
    {
      op: "create",
      description: "regex",
      source: { kind: "command", command: "echo yes", filter: "[", persistent: true },
    },
    {
      op: "create",
      description: "path",
      source: { kind: "path", path: "relative", event: "create", persistent: true },
    },
    {
      // A cron chain's lifecycle is its grid: lifetime fields are a watch concept.
      op: "create",
      description: "cron",
      source: { kind: "cron", expr: "*/5 * * * *", tz: "UTC", persistent: true },
    },
    { op: "cancel", id: "watch", source: { kind: "command", command: "echo wrong" } },
    { op: "rearm" },
  ])
    expect(monitorTool.input.safeParse({ operation: input }).success).toBe(false);
  const dispatcher = dispatcherFixture([eraseTool(monitorTool)]);
  const context = { sessionId: "session", turnId: "turn" };
  expect(
    await runEffect(dispatcher.execute({ id: "bad", tool: "monitor", input: { op: "cancel" } }, context)),
  ).toMatchObject({ errorKind: "invalid_input" });
  expect(
    await runEffect(dispatcher.execute({ id: "missing", tool: "not_monitor", input: {} }, context)),
  ).toMatchObject({ errorKind: "unregistered_tool" });
  const missingContext = await runEffect(Effect.exit(
    dispatcher.execute(
      { id: "context", tool: "monitor", input: { operation: { op: "cancel", id: "watch" } } },
      context,
    ),
  ));
  expect(Exit.isFailure(missingContext)).toBe(true);
  if (Exit.isFailure(missingContext)) {
    expect(
      missingContext.cause.reasons
        .filter(Cause.isDieReason)
        .map((reason) => (reason.defect instanceof ExecutorContextError ? reason.defect : null)),
    ).toEqual([expect.any(ExecutorContextError)]);
  }
  await expect(
    monitorTool.execute(
      { operation: { op: "cancel", id: "watch" } },
      { ...context, callId: "missing-port", signal: new AbortController().signal },
    ),
  ).rejects.toBeInstanceOf(ToolRefused);
});

const SESSION = "monitor-session";

const watchSpec = (notificationLimit: number) => ({
  watch: { command: "true", description: "control", persistent: true as const },
  policyGeneration: 1,
  notificationLimit,
});

test("monitor controls fold create/rearm/cancel as chain facts through the real entity", async () => {
  await withEntityAlarmPorts(SESSION, async (fx) => {
    // Enough committed history that the fold and the rearm's spec recovery
    // must page (`historyPage` default limit 100) instead of reading one page.
    // Seeded as ledger facts under the LIVE activation's fence.
    const row = fx.kernel.row(fx.sessionId);
    const owner = row.fenceOwner;
    if (owner === null) throw new Error("live activation without a fence");
    const filler = Array.from({ length: 110 }, (_, index) => ({
      id: `filler-${index + 1}`,
      parentId: index === 0 ? null : `filler-${index}`,
      sessionId: fx.sessionId,
      kind: "llm" as const,
      intent: { encodingVersion: 1 as const, value: { phase: "intent" } },
      effect: { encodingVersion: 1 as const, value: { phase: "pending" } },
      irreversible: true as const,
      ts: 2,
    }));
    await runEffect(
      fx.kernel.commit({
        sessionId: fx.sessionId,
        owner,
        fence: row.fence,
        now: 2,
        expectedRevision: row.revision,
        actions: filler,
        state: row.state,
      }),
    );
    const monitorTool = createMonitorTool(() => fx.ports);
    const armed = await fx.ports.create(
      {
        id: "control",
        sessionId: fx.sessionId,
        turnId: fx.turnId,
        kind: "watch",
        spec: watchSpec(8),
      },
      new AbortController().signal,
    );
    expect(armed).toMatchObject({
      id: "control",
      kind: "watch",
      status: "armed",
      fireAt: FIXTURE_BASE,
    });
    expect(fx.installed.map((spec) => spec.id)).toEqual(["control"]);
    const context = {
      sessionId: fx.sessionId,
      turnId: fx.turnId,
      callId: "call",
      signal: new AbortController().signal,
    };
    // Rearm of a live watch is a no-op: the armed chain stands.
    expect(
      await monitorTool.execute({ operation: { op: "rearm", id: "control" } }, context),
    ).toMatchObject({ id: "control", status: "armed", occurrenceId: armed.occurrenceId });
    // A chain the session never armed is refused, not cancelled.
    await expect(
      monitorTool.execute({ operation: { op: "cancel", id: "ghost" } }, context),
    ).rejects.toMatchObject({ _tag: "MonitorRefused" });
    expect(
      await monitorTool.execute({ operation: { op: "cancel", id: "control" } }, context),
    ).toMatchObject({ status: "cancelled", fireAt: null });
    expect(fx.closed).toEqual(["control"]);
    // Rearm revives the cancelled chain under a fresh occurrence.
    const revived = await monitorTool.execute(
      { operation: { op: "rearm", id: "control" } },
      context,
    );
    expect(revived).toMatchObject({ id: "control", status: "armed", notifications: 0 });
    expect(revived.occurrenceId).not.toBe(armed.occurrenceId);
    expect(fx.installed.map((spec) => spec.id)).toEqual(["control", "control"]);
  });
});

test("capability wakes spend the chain budget: prompt, re-arm, then exhaustion retire", async () => {
  // The prompt append is the entity's (`AlarmWakeContext.prompt`); here it is
  // recorded so the chain budget, re-arm and retire are what the test proves.
  // Every arm the handler commits goes through the REAL entity verb.
  const prompts: Parameters<Bundle.AlarmPromptVerb>[0][] = [];
  const prompt: Bundle.AlarmPromptVerb = (input) => {
    prompts.push(input);
    return Effect.succeed({ seq: prompts.length });
  };
  await withEntityAlarmPorts(SESSION, async (fx) => {
    const wake = (content: string) => {
      const live = fx.kernel.armedAlarms().find((candidate) => candidate.alarmId === "budget");
      if (live === undefined) throw new Error("no armed chain");
      const chain = foldAlarmChains(fx.kernel, fx.sessionId).get("budget");
      if (chain === undefined || chain.latest.at === null) throw new Error("no armed chain");
      return runEffect(
        fx.capability.wake(
          {
            occurrenceId: live.occurrenceId,
            purpose: Bundle.MONITOR_HIT,
            alarmId: "budget",
            armSeq: live.armSeq,
            sourceKey: Bundle.MONITOR_SOURCE,
            payload: JSON.stringify({
              spec: chain.latest.payload.spec,
              notifications: chain.latest.payload.notifications,
              hit: { content, terminal: false, detail: "line:1" },
            }),
            fireAt: FIXTURE_BASE,
          },
          {
            sessionId: fx.sessionId,
            reads: alarmChainReads(fx.kernel, fx.sessionId),
            arm: fx.entityArm,
            now: FIXTURE_BASE + 10,
            prompt,
          },
        ),
      );
    };
    await fx.ports.create(
      { id: "budget", sessionId: fx.sessionId, turnId: fx.turnId, kind: "watch", spec: watchSpec(2) },
      new AbortController().signal,
    );
    expect(await wake("WAKE first")).toBe("delivered");
    const afterFirst = foldAlarmChains(fx.kernel, fx.sessionId).get("budget");
    expect(afterFirst?.latest).toMatchObject({
      at: FIXTURE_BASE + 10,
      payload: { notifications: 1 },
    });
    expect(fx.closed).toEqual([]);
    // The second wake spends the whole budget: prompt + exhaustion retire.
    expect(await wake("WAKE second")).toBe("exhausted");
    const afterSecond = foldAlarmChains(fx.kernel, fx.sessionId).get("budget");
    expect(afterSecond?.latest).toMatchObject({ at: null, payload: { reason: "exhausted" } });
    expect(fx.kernel.armedAlarms().filter((live) => live.alarmId === "budget")).toEqual([]);
    // The handler closes the native source AND the entity's post-commit arm
    // notice does: close is idempotent fire-and-forget, so the overlap is
    // harmless (and exactly what production composes).
    expect(fx.closed).toEqual(["budget", "budget"]);
    expect(prompts).toEqual([
      { content: "WAKE first", payload: { watchId: "budget", detail: "line:1" } },
      { content: "WAKE second", payload: { watchId: "budget", detail: "line:1" } },
    ]);
  });
});

/** A compiled tool/pre snapshot the invocation frame carries into `evaluateGate`. */
type PolicyRow = Parameters<typeof policySnapshot>[0]["rows"][number];

function monitorPolicy(extraRows: readonly PolicyRow[] = []) {
  return policySnapshot({
    registry: Core.KERNEL_POLICY_REGISTRY,
    generation: 1,
    mandatory: [],
    rows: [
      ...Core.SEEDED_POLICY_ROWS.map((row) => ({ ...row, generation: 1 })),
      ...extraRows,
    ] as PolicyRow[],
  });
}

test("cron create validates the grid and consults the gate before arming the chain", async () => {
  await withEntityAlarmPorts(SESSION, async (fx) => {
    const monitorTool = createMonitorTool(() => fx.ports);
    const context = {
      sessionId: fx.sessionId,
      turnId: fx.turnId,
      callId: "call",
      signal: new AbortController().signal,
    };
    const cron = (expr: string) => ({
      op: "create" as const,
      description: "five minute grid",
      source: { kind: "cron" as const, expr, tz: "UTC" },
    });
    const run = (policy: ReturnType<typeof monitorPolicy>, operation: ReturnType<typeof cron>) =>
      activeInvocation.run(
        {
          executor: {} as never,
          captured: { executor: {} as never, cell: {} as never, policy, generation: {} as never },
        },
        () => monitorTool.execute({ operation }, context),
      );
    // An invalid expression is refused before the gate and before any commit.
    await expect(run(monitorPolicy(), cron("not a cron"))).rejects.toMatchObject({
      name: "ToolRefused",
      message: expect.stringContaining("invalid cron expression"),
    });
    // A deny verdict refuses the arm: no chain row, no scheduled occurrence.
    const deny = monitorPolicy([{
      name: "deny-monitor",
      kind: "tool",
      phase: "pre",
      generation: 1,
      priority: 2000,
      match: { encodingVersion: 1, value: { op: "monitor" } },
      verdict: { encodingVersion: 1, value: { type: "deny", reason: "monitors are off" } },
    }]);
    await expect(run(deny, cron("*/5 * * * *"))).rejects.toMatchObject({
      name: "ToolRefused",
      message: "monitor refused: cron arm denied",
    });
    expect(foldAlarmChains(fx.kernel, fx.sessionId).size).toBe(0);
    expect(scheduledAt(fx.catalogFile, FIXTURE_BASE + 300_000)).toBe(false);
    // An allowed grid arms one cron chain at the next boundary; the REAL
    // entity schedules it through the durable DeliverAt door.
    const armed = await run(monitorPolicy(), cron("*/5 * * * *"));
    expect(armed).toMatchObject({ id: "minted", kind: "cron", status: "armed", notifications: 0 });
    // FIXTURE_BASE sits on a five-minute boundary: the next tick is +5min.
    expect(armed.fireAt).toBe(FIXTURE_BASE + 300_000);
    await awaitScheduled(fx.catalogFile, FIXTURE_BASE + 300_000);
  });
});
