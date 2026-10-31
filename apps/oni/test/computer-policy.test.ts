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

test("clipboard grants refuse reads without read_write and deny private reads", async () => {
  const f = computerFixture();
  const read = { machineId: "desk", generation: 1, method: Machine.WireMethod.ClipboardRead, params: { formats: ["text" as const] } };
  const write = { machineId: "desk", generation: 1, method: Machine.WireMethod.ClipboardWrite, params: { text: "agent" } };
  try {
    f.grant();
    expect(await f.call(read)).toEqual({ status: "refused", reason: "clipboard_not_granted" });
    expect(await f.call(write)).toEqual({ status: "refused", reason: "clipboard_not_granted" });
    f.grant({ clipboard: "write" });
    expect(await f.call(read)).toEqual({ status: "refused", reason: "clipboard_not_granted" });
    expect(await f.call(write)).toEqual({ status: "ok" });
    f.grant({ clipboard: "read_write" });
    expect(await f.call(read)).toEqual({ status: "ok" });
    f.policy.pause("desk", "private");
    expect(await f.call(read)).toEqual({ status: "refused", reason: "private" });
  } finally { f.close(); }
});

test("clipboard ledger facts retain sizes but exclude read and write contents", async () => {
  const f = computerFixture();
  const read = { machineId: "desk", generation: 1, method: Machine.WireMethod.ClipboardRead, params: { formats: ["text" as const] } };
  const write = { machineId: "desk", generation: 1, method: Machine.WireMethod.ClipboardWrite, params: { text: "write-secret" } };
  try {
    f.grant({ clipboard: "read_write" });
    const readAnswer = await runEffect(f.capture(read, Effect.succeed({ status: "ok", text: "read-secret", changeCount: 2 })).pipe(
      Effect.provideService(Core.ExecutorContext, f.executor),
    ));
    expect(readAnswer).toEqual({ status: "ok", text: "read-secret", changeCount: 2 });
    const writeAnswer = await runEffect(f.capture(write, Effect.succeed({
      status: "ok", changeCount: 3, previous: { changeCount: 2, formats: ["public.utf8-plain-text"], bytes: 11 },
    })).pipe(Effect.provideService(Core.ExecutorContext, f.executor)));
    expect(writeAnswer.status).toBe("ok");
    const serialized = JSON.stringify(f.actions);
    expect(serialized).not.toContain("read-secret");
    expect(serialized).not.toContain("write-secret");
    expect(serialized).toContain('"bytes":11');
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
      expect(await f.call()).toEqual({ status: "refused", reason: `paused:${reason}` });
      const request = { machineId: "desk", generation: 1, method: Machine.WireMethod.ScreenObserve, params: { target, screenshot: false }, binding: { ...target, app } };
      expect(await f.call(request)).toEqual({ status: "refused", reason: `paused:${reason}` });
      f.policy.turns.set("resident", "turn-2");
      expect(await f.call({ ...request, params: { ...request.params, since: "o1" } })).toEqual({ status: "refused", reason: `paused:${reason}` });
      const answer = await runEffect(f.capture(request, Effect.succeed(observed)).pipe(Effect.provideService(Core.ExecutorContext, f.executor)));
      expect(answer).toEqual(observed);
      expect(f.policy.store.get("resident", "desk")).toMatchObject({ state: "active", revision: 3 });
      expect(await f.call()).toEqual({ status: "ok" });
    } finally { f.close(); }
  },
);

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
