import { expect, test } from "bun:test";
import { Bundle, Core } from "@oni/agent";
import { canonicalDigest } from "@oni/protocol";
import { appManifest, toolCapability } from "../src/manifest";
import { compactionSummarizerBundle } from "../src/bundles/compaction/index";
import { createMonitorTool } from "../src/bundles/alarms/monitor/index";
import { CompactionSummarizerPort, ToolCapabilityPort } from "../src/bundles/seams";
import { alarmDefinition } from "./helpers/alarm-definition";
import { runEffect } from "./helpers/effect";

test("app port identifiers preserve persisted keys and the legacy manifest hash preimage", () => {
  const toolKey = "@oni/oni/ToolCapabilitySeam";
  const summarizerKey = "@oni/oni/CompactionSummarizerSeam";
  const manifest = Bundle.Manifest.define({
    capabilities: [toolCapability],
    bundles: [
      compactionSummarizerBundle(),
      Bundle.define({
        name: "consumer",
        requires: [ToolCapabilityPort, CompactionSummarizerPort],
      }),
    ],
  });
  const generation = Bundle.composeSync(manifest);
  expect(Buffer.from(ToolCapabilityPort.key)).toEqual(Buffer.from(toolKey));
  expect(Buffer.from(CompactionSummarizerPort.key)).toEqual(Buffer.from(summarizerKey));
  expect(generation.hash).toBe(canonicalDigest({
    capabilities: [{
      name: "tool", requires: [], seam: toolKey, kinds: [], inputs: [],
      points: ["tool.pre", "tool.post"], purposes: [], handlers: ["kernel/budget-clamp"],
    }],
    bundles: [
      {
        name: "compaction-summarizer", requires: [], provides: [summarizerKey],
        tools: [], rows: [], handlers: [], purposes: [],
      },
      {
        name: "consumer", requires: [toolKey, summarizerKey], provides: [],
        tools: [], rows: [], handlers: [], purposes: [],
      },
    ],
    off: [],
    disabled: [],
  }));
});

test("the manifest is THE product list: tool/action/hook/compaction/alarm capabilities, eight bundles, empty off by default", async () => {
  const manifest = appManifest({
    alarm: await alarmDefinition(),
    wake: { close: () => undefined },
    alarms: () => undefined, tools: () => undefined,
  });
  expect(manifest.capabilities.map((capability) => capability.name)).toEqual([
    "tool",
    "action",
    "hook",
    "compaction",
    "alarm",
  ]);
  expect(manifest.bundles.map((bundle) => bundle.name)).toEqual([
    "file",
    "bash",
    "eval",
    "monitor",
    "cron",
    "hooks-json",
    "delegation-policy",
    "approval-policy",
    "send-message",
    "provision",
    "completion",
    "compaction-summarizer",
    "compaction-strategy",
  ]);
  expect(manifest.off).toEqual([]);
});

test("the Owner's bundles-off tuple flows through as the manifest off list", async () => {
  const manifest = appManifest({
    alarm: await alarmDefinition(),
    wake: { close: () => undefined },
    alarms: () => undefined, tools: () => undefined,
    off: ["monitor"],
  });
  expect(manifest.off).toEqual(["monitor"]);
});

test("a duplicate off name is refused as typed manifest data, not silently deduped", async () => {
  const alarm = await alarmDefinition();
  expect(() =>
    appManifest({ alarm, wake: { close: () => undefined },
    alarms: () => undefined, tools: () => undefined, off: ["cron", "cron"] }),
  ).toThrow(Bundle.DefineRefused);
});

test('off: ["tool"] composes with a typed cascade: monitor, send-message and delegation-policy disable with because "tool"', async () => {
  const manifest = appManifest({
    alarm: await alarmDefinition(),
    wake: { close: () => undefined },
    alarms: () => undefined, tools: () => undefined,
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
    alarms: () => undefined, tools: () => undefined,
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
    alarms: () => undefined, tools: () => undefined,
  });
  const copy = Bundle.define({
    name: "monitor-copy",
    requires: [ToolCapabilityPort],
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
