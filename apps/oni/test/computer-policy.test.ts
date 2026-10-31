import { expect, test } from "bun:test";
import { Core } from "@oni/agent";
import { Machine } from "@oni/protocol";
import { Effect } from "effect";
import { computerFixture, textInput, target, observed, app } from "./helpers/computer";
import { runEffect } from "./helpers/effect";

test("captured tool.pre refuses missing and expired leases before forwarding", async () => {
  const f = computerFixture();
  try {
    expect(await f.call()).toEqual({ status: "refused", reason: "lease_missing" });
    f.grant();
    f.setClock(600_100);
    expect(await f.call()).toEqual({ status: "refused", reason: "lease_expired" });
    expect(f.policy.store.get("resident", "desk")).toMatchObject({ state: "ended", endReason: "expired", revision: 2 });
    expect(await f.call()).toEqual({ status: "refused", reason: "lease_missing" });
    expect(f.stopped).toEqual(["desk"]);
  } finally { f.close(); }
});

test("the 1500th admitted input succeeds and the 1501st carries its sliding reset time", async () => {
  const f = computerFixture();
  try {
    f.grant({ admittedAt: Array.from({ length: 1499 }, () => 100) });
    expect(await f.call()).toEqual({ status: "ok" });
    expect(await f.call()).toEqual({ status: "refused", reason: "budget_exhausted", resetAt: 3_600_100 });
    const listed = f.policy.store.get("resident", "desk");
    expect(listed?.admittedAt).toHaveLength(1500);
    f.setClock(3_600_100);
    // A fresh lease keeps this fixture's scope valid while the hour rolls forward.
    f.grant({ expiresAt: 4_000_000, admittedAt: listed?.admittedAt ?? [] });
    expect(await f.call()).toEqual({ status: "ok" });
  } finally { f.close(); }
});

test("an enrollment ceiling caps a larger approved lease without charging observation", async () => {
  const f = computerFixture();
  try {
    f.plane.policyState.put("computer_use.enrollmentCeiling", { key: "desk", revision: 0, value: 2 });
    f.grant({ budget: { actionsPerHour: 5000 } });
    const observe = { ...textInput, method: Machine.WireMethod.ScreenObserve, params: { target, screenshot: false } };
    expect(await f.call(observe)).toEqual({ status: "ok" });
    expect(await f.call()).toEqual({ status: "ok" });
    expect(await f.call()).toEqual({ status: "ok" });
    expect(await f.call(observe)).toEqual({ status: "ok" });
    expect(await f.call()).toEqual({ status: "refused", reason: "budget_exhausted", resetAt: 3_600_100 });
  } finally { f.close(); }
});

test("a native refusal after admission still consumes one input attempt", async () => {
  const f = computerFixture();
  try {
    f.grant({ budget: { actionsPerHour: 1 } });
    const refusal = { status: "refused", reason: "input_not_available" } as const;
    expect(await runEffect(f.capture(textInput, Effect.succeed(refusal))
      .pipe(Effect.provideService(Core.ExecutorContext, f.executor)))).toEqual(refusal);
    expect(await f.call()).toEqual({ status: "refused", reason: "budget_exhausted", resetAt: 3_600_100 });
  } finally { f.close(); }
});

test("app scope, target binding, exclusions and foreground grants are enforced by compiled rows", async () => {
  const f = computerFixture();
  try {
    f.grant();
    const { binding: _binding, ...unbound } = textInput;
    expect(await f.call(unbound)).toEqual({ status: "refused", reason: "target_unbound" });
    expect(await f.call({ ...textInput, binding: { ...target, app: { bundleId: null, path: "/usr/bin/other" } } }))
      .toEqual({ status: "refused", reason: "app_out_of_scope" });
    const foreground = { ...textInput, params: { requestId: "1-2", captureId: "cap-1", text: "hello", delivery: "foreground" as const } };
    expect(await f.call(foreground)).toEqual({ status: "refused", reason: "foreground_not_granted" });
    f.grant({ foreground: { purpose: "Review output", expiresAt: 200 } });
    expect(await f.call(foreground)).toEqual({ status: "ok" });
    f.setClock(200);
    expect(await f.call(foreground)).toEqual({ status: "refused", reason: "foreground_not_granted" });
    expect(await f.call()).toEqual({ status: "ok" });
    f.policy.store.exclude({ machineId: "desk", app: app.bundleId });
    f.policy.store.exclude({ machineId: "desk", app: app.bundleId });
    f.grant({ apps: "any" });
    expect(await f.call()).toEqual({ status: "refused", reason: "excluded" });
    expect(await f.call({ ...textInput, binding: { ...target, app: { bundleId: null, path: "/usr/bin/other" } } }))
      .toEqual({ status: "ok" });
    expect(f.policy.store.exclusions()).toHaveLength(1);
  } finally { f.close(); }
});

test.each(["human_input", "takeover", "private", "locked", "asleep"] as const)(
  "%s pauses the lease and resumes only after a new turn observes freshly",
  async (reason) => {
    const f = computerFixture();
    try {
      f.grant();
      f.policy.pause("desk", reason);
      f.policy.pause("desk", reason);
      expect(await f.call()).toEqual(reason === "human_input"
        ? { status: "refused", reason: "paused:human_input", humanActiveMs: 0, retryAfterMs: 10000 }
        : { status: "refused", reason: `paused:${reason}` });
      const request = { machineId: "desk", generation: 1, method: Machine.WireMethod.ScreenObserve, params: { target, screenshot: false }, binding: { ...target, app } };
      expect(await f.call(request)).toEqual({ status: "ok" });
      f.policy.turns.set("resident", "turn-2");
      expect(await f.call({ ...request, params: { ...request.params, since: "o1" } })).toEqual({ status: "ok" });
      if (reason === "human_input") f.setClock(10_100);
      const answer = await runEffect(f.capture(request, Effect.succeed(observed)).pipe(Effect.provideService(Core.ExecutorContext, f.executor)));
      expect(answer).toEqual(observed);
      expect(f.policy.store.get("resident", "desk")).toMatchObject({ state: "active", revision: 3 });
      expect(await f.call()).toEqual(reason === "human_input"
        ? { status: "refused", reason: "stale_capture" } : { status: "ok" });
    } finally { f.close(); }
  },
);

test("human activity returns a typed retry while observation stays available", async () => {
  const f = computerFixture();
  try {
    f.grant();
    f.policy.pause("desk", "human_input");
    expect(await f.call()).toEqual({
      status: "refused", reason: "paused:human_input", humanActiveMs: 0, retryAfterMs: 10000,
    });
    const observe = { ...textInput, method: Machine.WireMethod.ScreenObserve, params: { target, screenshot: false } };
    const settle = { ...textInput, method: Machine.WireMethod.ScreenSettle, params: { target, quietMs: 100 } };
    expect(await f.call(observe)).toEqual({ status: "ok" });
    expect(await f.call(settle)).toEqual({ status: "ok" });
    f.setClock(10_100);
    expect(await f.call()).toEqual({
      status: "refused", reason: "paused:human_input", humanActiveMs: 10000, retryAfterMs: 0,
    });
  } finally { f.close(); }
});

test("only a full post-edge observation in a later turn restores anchored input", async () => {
  const f = computerFixture();
  const request = { ...textInput, method: Machine.WireMethod.ScreenObserve, params: { target, screenshot: false } };
  const action = { ...textInput, method: Machine.WireMethod.InputAction, params: {
    requestId: "1-2", observationId: "o1", target, ref: "AXButton[0]", action: "press" as const,
  } };
  try {
    f.grant();
    await runEffect(f.capture(request, Effect.succeed(observed)).pipe(Effect.provideService(Core.ExecutorContext, f.executor)));
    f.policy.pause("desk", "human_input");
    f.setClock(10_100);
    expect(await f.call(action)).toMatchObject({ reason: "paused:human_input", retryAfterMs: 0 });
    f.policy.turns.set("resident", "turn-2");
    await runEffect(f.capture({ ...request, params: { ...request.params, since: "o1" } }, Effect.succeed(observed))
      .pipe(Effect.provideService(Core.ExecutorContext, f.executor)));
    expect(await f.call(action)).toMatchObject({ reason: "paused:human_input", retryAfterMs: 0 });
    await runEffect(f.capture(request, Effect.succeed(observed)).pipe(Effect.provideService(Core.ExecutorContext, f.executor)));
    expect(await f.call(action)).toEqual({ status: "ok" });
    expect(await f.call()).toEqual({ status: "refused", reason: "stale_capture" });
    f.policy.pause("desk", "human_input", 10_101);
    f.setClock(20_101);
    expect(await f.call(action)).toMatchObject({ reason: "paused:human_input", retryAfterMs: 0 });
  } finally { f.close(); }
});

test("policy rows set the quiet and maximum wait windows", async () => {
  const f = computerFixture();
  try {
    f.plane.policyState.put("computer_use.humanQuietMs", { key: "default", revision: 0, value: 3000 });
    f.plane.policyState.put("computer_use.maxWaitMs", { key: "default", revision: 0, value: 1000 });
    f.grant();
    f.policy.pause("desk", "human_input");
    expect(await f.call()).toMatchObject({ reason: "paused:human_input", retryAfterMs: 3000 });
    f.setClock(1100);
    f.policy.pause("desk", "human_input");
    expect(await f.call()).toMatchObject({ reason: "paused:human_input", retryAfterMs: 3000, humanActiveMs: 0 });
    f.setClock(4100);
    expect(await f.call()).toMatchObject({ reason: "paused:human_input", retryAfterMs: 0 });
  } finally { f.close(); }
});

test("a new lease cannot bypass a human-input edge before it was granted", async () => {
  const f = computerFixture();
  try {
    f.policy.pause("desk", "human_input");
    f.grant();
    expect(await f.call()).toMatchObject({ reason: "paused:human_input", retryAfterMs: 10000 });
  } finally { f.close(); }
});

test("a short human-input pause refuses immediately without scheduling an input", async () => {
  const f = computerFixture();
  try {
    f.grant();
    f.policy.pause("desk", "human_input");
    f.setClock(3600);
    expect(await f.call()).toEqual({
      status: "refused", reason: "paused:human_input", humanActiveMs: 3500, retryAfterMs: 6500,
    });
    expect(f.scheduled.size).toBe(0);
  } finally { f.close(); }
});

test("a second human-input edge resets the retry window", async () => {
  const f = computerFixture();
  try {
    f.grant();
    f.policy.pause("desk", "human_input");
    expect((await f.call()).status).toBe("refused");
    f.setClock(20_100);
    f.policy.pause("desk", "human_input");
    expect(await f.call()).toMatchObject({
      status: "refused", reason: "paused:human_input", humanActiveMs: 0, retryAfterMs: 10000,
    });
  } finally { f.close(); }
});

test.each([{ locked: true, asleep: false }, { locked: false, asleep: true }])(
  "live session facts pause input before their observation callback drains",
  async (session) => {
    const f = computerFixture();
    try {
      f.grant();
      f.setSession(session);
      expect(await f.call()).toEqual({ status: "refused", reason: session.locked ? "paused:locked" : "paused:asleep" });
    } finally { f.close(); }
  },
);

test("a private observation cannot resume a paused lease", async () => {
  const f = computerFixture();
  try {
    f.grant();
    f.policy.pause("desk", "human_input");
    f.policy.turns.set("resident", "turn-2");
    const request = { ...textInput, method: Machine.WireMethod.ScreenObserve, params: { target, screenshot: false } };
    const answer = Machine.ScreenObserveResult.parse({ ...observed, private: true });
    await runEffect(f.capture(request, Effect.succeed(answer)).pipe(Effect.provideService(Core.ExecutorContext, f.executor)));
    expect(await f.call()).toEqual({ status: "refused", reason: "paused:private" });
  } finally { f.close(); }
});

test("detach deadline is cancelled by attach and ends absent leases after 120 seconds", () => {
  const f = computerFixture();
  try {
    f.grant();
    f.policy.watch("desk");
    expect(f.scheduled.size).toBe(0);
    f.setMachines([]);
    f.policy.watch("desk");
    f.policy.watch("desk");
    expect(f.scheduled.size).toBe(1);
    const stale = [...f.scheduled.values()][0];
    if (stale === undefined) throw new Error("detach deadline missing");
    f.setClock(50_100);
    f.policy.attached("desk");
    expect(f.scheduled.size).toBe(0);
    f.policy.watch("desk");
    stale();
    expect(f.policy.store.get("resident", "desk")?.state).toBe("active");
    for (const callback of f.scheduled.values()) callback();
    expect(f.policy.now()).toBe(170_100);
    expect(f.policy.store.get("resident", "desk")).toMatchObject({ state: "ended", endReason: "detached" });
    f.policy.stop("resident");
    f.policy.pause("desk", "human_input");
    f.policy.end("missing", "desk");
    expect(f.stopped).toEqual(["desk"]);
  } finally { f.close(); }
});

test("stale lease writes refuse without overwriting the current revision", () => {
  const f = computerFixture();
  try {
    const lease = f.grant({ apps: "any" });
    f.policy.store.pause("absent", "desk", "takeover");
    expect(f.policy.store.resume("absent", "desk")).toBeUndefined();
    expect(() => f.policy.store.put(lease)).toThrow(Core.ToolRefused);
    f.policy.stop("resident");
    expect(f.policy.store.get("resident", "desk")).toMatchObject({ state: "ended", endReason: "stopped", revision: 2 });
  } finally { f.close(); }
});

test("captured cancellation retains its uncertainty evidence in the ledger", async () => {
  const f = computerFixture();
  const cancelled = { status: "unverifiable", reason: "cancelled", dispatched: "unknown", hint: "re_observe" } as const;
  try {
    f.grant();
    expect(await runEffect(f.capture(textInput, Effect.succeed(cancelled)).pipe(
      Effect.provideService(Core.ExecutorContext, f.executor),
    ))).toEqual(cancelled);
    expect(f.actions.map((row) => row.effect.value)).toContainEqual(expect.objectContaining({ result: cancelled }));
  } finally { f.close(); }
});
