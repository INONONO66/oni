import { expect, test } from "bun:test";
import { Bundle } from "@oni/agent";
import { Effect } from "effect";
import { appManifest } from "../src/manifest";
import { alarmDefinition } from "./helpers/alarm-definition";
import { APPROVAL_POLICY } from "../src/composition/policy";
import { runEffect } from "./helpers/effect";

test("the approval-policy bundle ships the product literals the core no longer owns (#1309)", () => {
  expect(APPROVAL_POLICY).toEqual({
    responders: ["owner"],
    recentOpen: { limit: 8, windowMs: 3_600_000 },
    defaultExpiryMs: 86_400_000,
    defaultBudget: {
      maxTurns: 24,
      maxToolCalls: 40,
      maxWallTimeMs: 5 * 60 * 1000,
      maxToolRuntimeMs: 2 * 60 * 1000,
    },
  });
});

test("the product manifest composes with the approval-policy provider on by default", async () => {
  const manifest = appManifest({ alarm: await alarmDefinition(), wake: { close: () => undefined }, alarms: () => undefined, tools: () => undefined });
  const generation = Bundle.composeSync(manifest);
  expect(generation.bundles).toContain("approval-policy");
  expect(generation.disabled).toEqual([]);
});

test("composing WITHOUT the approval-policy bundle refuses typed seam_missing — no silent in-core fallback", async () => {
  const manifest = appManifest({ alarm: await alarmDefinition(), wake: { close: () => undefined }, alarms: () => undefined, tools: () => undefined });
  const stripped = Bundle.Manifest.define({
    capabilities: manifest.capabilities,
    bundles: manifest.bundles.filter((bundle) => bundle.name !== "approval-policy"),
    off: [],
  });
  const refused = await runEffect(Effect.flip(Bundle.compose(stripped)));
  expect(refused).toBeInstanceOf(Bundle.ComposeRefused);
  expect(refused.code).toBe("seam_missing");
  expect(refused.name).toBe("send-message");
  expect(refused.detail).toBe("@oni/approval/ApprovalPolicy");
});
