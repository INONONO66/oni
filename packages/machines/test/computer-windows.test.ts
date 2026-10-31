import { expect, test } from "bun:test";
import { Machine } from "@oni/protocol";
import { Effect } from "effect";
import { ComputerWindows } from "../src/computer-windows";
import { ComputerRelay } from "../src/computer-relay";
import { run } from "./ipc/helpers/effects";

const target = { pid: 42, windowId: 7, epoch: 2 };
const app = { bundleId: "com.example.Editor", path: "/usr/bin/editor" };
const observation = Machine.ScreenObserveResult.parse({
  status: "ok", target, observationId: "o1", lineage: "w42-7-2",
  window: { ...target, app, title: "Editor" }, private: false, complete: true, elements: [],
  screenshot: { captureId: "screenshot", format: "png", width: 1, height: 1, data: "AQ==" },
});
const list = Machine.ScreenListResult.parse({
  status: "ok", displays: [{ display: 1, width: 100, height: 100, scale: 1, primary: true }],
  windows: [{ windowId: "7", pid: 42, app, owner: "Editor", title: "Editor",
    display: 1, bounds: { x: 0, y: 0, width: 10, height: 10 } }],
  truncated: false, observedAt: 1,
});

test("window facts bind capture, observation, pid and target without inventing an app for display coordinates", () => {
  const facts = new ComputerWindows();
  facts.observe(observation);
  expect(facts.resolve({ requestId: "1-1", captureId: "screenshot", text: "a" })).toEqual({ ...target, app });
  expect(facts.resolve({ requestId: "1-2", kind: "click", button: "left", count: 1, at: { observationId: "o1", ref: "AXButton[0]" } })).toEqual({ ...target, app });
  expect(facts.resolve({ pid: 42 })).toEqual({ ...target, app });
  facts.list(list);
  expect(facts.resolve({ target, screenshot: false })?.epoch).toBe(2);
  facts.capture({ target: { kind: "window", windowId: "7" }, encoding: { format: "png" } }, "cap");
  expect(facts.resolve({ requestId: "1-3", kind: "move", at: { captureId: "cap", x: 1, y: 1 } })).toEqual({ ...target, app });
  expect(facts.resolve({ requestId: "1-4", captureId: "cap", text: "a", delivery: "foreground", target }))
    .toEqual({ ...target, app });
  expect(facts.resolve({ requestId: "1-5", captureId: "cap", text: "a", delivery: "foreground", target: { ...target, windowId: 8 } }))
    .toBeUndefined();
  facts.capture({ target: { kind: "display", display: 1 }, encoding: { format: "png" } }, "display");
  expect(facts.resolve({ requestId: "1-4", captureId: "display", text: "a" })).toBeUndefined();
  expect(facts.resolve({ requestId: "1-5", captureId: "display", text: "a", delivery: "foreground", target })).toBeUndefined();
  expect(facts.resolve({ app: { path: "/bin/app" }, activate: false })).toBeUndefined();
});

test("listing removes stale windows only when complete and ignores rows without numeric identity", () => {
  const facts = new ComputerWindows();
  facts.list({ status: "refused", reason: "permission_denied" });
  facts.observe({ status: "refused", reason: "permission_denied" });
  facts.list(list);
  if (list.status !== "ok") throw new Error("fixture must list");
  facts.list({ ...list, windows: [], truncated: true });
  expect(facts.windows.size).toBe(1);
  const row = list.windows[0];
  if (row === undefined) throw new Error("fixture must contain a window");
  const { pid: _pid, app: _app, ...anonymous } = row;
  facts.list({ ...list, windows: [anonymous, { ...row, windowId: "non-numeric" }] });
  expect(facts.windows.size).toBe(0);
  facts.capture({ target: { kind: "window", windowId: "missing" }, encoding: { format: "png" } }, "missing");
  expect(facts.resolve({ requestId: "1-1", kind: "click", button: "left", count: 1, at: { observationId: "o9", ref: "AXButton[0]" } })).toBeUndefined();
});

test("launch binds both bundle identities and executable paths without fabricating a path", () => {
  const facts = new ComputerWindows();
  facts.launch({ app: { bundleId: "com.example.Editor" }, activate: false }, { status: "ok", pid: 42, windows: [target] });
  expect(facts.resolve({ pid: 42 })?.app).toEqual({ bundleId: "com.example.Editor" });
  facts.launch({ app: { path: "/bin/editor" }, activate: false }, { status: "ok", pid: 42, windows: [target] });
  expect(facts.resolve({ pid: 42 })?.app).toEqual({ bundleId: null, path: "/bin/editor" });
  facts.launch({ app: { path: "/bin/other" }, activate: false }, { status: "refused", reason: "excluded" });
  expect(facts.windows.size).toBe(1);
});

test("closed computer relays never start delayed work and preserve errors before closing", async () => {
  const relay = new ComputerRelay();
  expect(await run(relay.run(Effect.succeed("done")))).toBe("done");
  expect(await run(relay.run(Effect.fail("broken")).pipe(Effect.flip))).toBe("broken");
  relay.close();
  let sent = false;
  expect(await run(relay.run(Effect.sync(() => { sent = true; return "late"; })))).toEqual({
    status: "unverifiable", reason: "cancelled", dispatched: "unknown", hint: "re_observe",
  });
  expect(sent).toBe(false);
});
