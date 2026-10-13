import { expect, test } from "bun:test";
import { Bundle, Core } from "@openomni/agent";
import { appManifest } from "../src/manifest";
import { createMonitorTool } from "../src/bundles/alarms/monitor/index";
import { ToolCapabilitySeam } from "../src/bundles/seams";
import { alarmDefinition } from "./helpers/alarm-definition";
import { runEffect } from "./helpers/effect";

test("the manifest is THE product list: tool/action/hook/compaction/alarm capabilities, six bundles, empty off by default", async () => {
  const manifest = appManifest({
    alarm: await alarmDefinition(),
    wake: { close: () => undefined },
    alarms: () => undefined,
  });
  expect(manifest.capabilities.map((capability) => capability.name)).toEqual([
    "tool",
    "action",
    "hook",
    "compaction",
    "alarm",
  ]);
  expect(manifest.bundles.map((bundle) => bundle.name)).toEqual([
    "monitor",
    "cron",
    "hooks-json",
    "send-message",
    "delegation-policy",
    "approval-policy",
  ]);
  expect(manifest.off).toEqual([]);
});

test("the Owner's bundles-off tuple flows through as the manifest off list", async () => {
  const manifest = appManifest({
    alarm: await alarmDefinition(),
    wake: { close: () => undefined },
    alarms: () => undefined,
    off: ["monitor"],
  });
  expect(manifest.off).toEqual(["monitor"]);
});

test("a duplicate off name is refused as typed manifest data, not silently deduped", async () => {
  const alarm = await alarmDefinition();
  expect(() =>
    appManifest({ alarm, wake: { close: () => undefined },
    alarms: () => undefined, off: ["cron", "cron"] }),
  ).toThrow(Bundle.DefineRefused);
});

test('off: ["tool"] composes with a typed cascade: monitor, send-message and delegation-policy disable with because "tool"', async () => {
  const manifest = appManifest({
    alarm: await alarmDefinition(),
    wake: { close: () => undefined },
    alarms: () => undefined,
    off: ["tool"],
  });
  const generation = Bundle.composeSync(manifest);
  expect(generation.disabled).toContainEqual({ name: "tool", because: "tool" });
  expect(generation.disabled).toContainEqual({ name: "monitor", because: "tool" });
  expect(generation.disabled).toContainEqual({ name: "send-message", because: "tool" });
  expect(generation.disabled).toContainEqual({ name: "delegation-policy", because: "tool" });
  expect(generation.rows.map((row) => row.id)).not.toContain("monitor/tool.pre#1");
  expect(generation.rows.filter((row) => row.on === "tool.pre" || row.on === "tool.post")).toEqual([]);
});

test("off: [\"compaction\"] composes with the typed disabled record, not a build break (#1307)", async () => {
  const manifest = appManifest({
    alarm: await alarmDefinition(),
    wake: { close: () => undefined },
    alarms: () => undefined,
    off: ["compaction"],
  });
  const generation = await runEffect(Bundle.compose(manifest));
  expect(generation.disabled).toContainEqual({ name: "compaction", because: "compaction" });
  expect(generation.capabilities).not.toContain("compaction");
});

test("a second bundle declaring the `monitor` tool is the typed duplicate compose refusal (#1308)", async () => {
  const product = appManifest({
    alarm: await alarmDefinition(),
    wake: { close: () => undefined },
    alarms: () => undefined,
  });
  const copy = Bundle.define({
    name: "monitor-copy",
    requires: [ToolCapabilitySeam],
    tools: [Core.eraseTool(createMonitorTool(() => undefined))],
  });
  const manifest = Bundle.Manifest.define({
    capabilities: [...product.capabilities],
    bundles: [...product.bundles, copy],
    off: [],
  });
  try {
    Bundle.composeSync(manifest);
    throw new Error("expected ComposeRefused");
  } catch (error) {
    if (!(error instanceof Bundle.ComposeRefused)) throw error;
    expect(error.code).toBe("duplicate");
    expect(error.detail).toContain("tool monitor");
  }
});
