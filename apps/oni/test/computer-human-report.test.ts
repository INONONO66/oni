import { expect, test } from "bun:test";
import { Machine } from "@oni/protocol";
import { computerFixture, target, textInput } from "./helpers/computer";

test("the reported human-input fact extends the quiet window", async () => {
  const f = computerFixture();
  try {
    f.grant();
    f.policy.pause("desk", "human_input");
    f.setClock(2100);
    f.setSession({ locked: false, asleep: false }, { lastAt: 2000, source: "pointer", events: 1 });
    expect(await f.call()).toEqual({
      status: "refused", reason: "paused:human_input", humanActiveMs: 100, retryAfterMs: 9900,
    });
  } finally { f.close(); }
});

test("a live human-input fact pauses a lease even when no event was delivered", async () => {
  const f = computerFixture();
  try {
    f.grant();
    f.setSession({ locked: false, asleep: false }, { lastAt: 100, source: "keyboard", events: 1 });
    expect(await f.call()).toEqual({
      status: "refused", reason: "paused:human_input", humanActiveMs: 0, retryAfterMs: 10000,
    });
    expect(f.policy.store.get("resident", "desk")).toMatchObject({ state: "paused", pauseReason: "human_input" });
  } finally { f.close(); }
});

test("a report-only human-input fact does not block looking", async () => {
  const f = computerFixture();
  try {
    f.grant();
    f.setSession({ locked: false, asleep: false }, { lastAt: 100, source: "keyboard", events: 1 });
    const observe = { ...textInput, method: Machine.WireMethod.ScreenObserve, params: { target, screenshot: false } };
    expect(await f.call(observe)).toEqual({ status: "ok" });
    expect(f.policy.store.get("resident", "desk")).toMatchObject({ state: "paused", pauseReason: "human_input" });
    expect(await f.call()).toMatchObject({ reason: "paused:human_input", retryAfterMs: 10000 });
  } finally { f.close(); }
});
