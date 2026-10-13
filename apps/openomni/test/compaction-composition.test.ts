import { expect, test } from "bun:test";
import { Bundle } from "@openomni/agent";
import { Effect } from "effect";
import { appManifest } from "../src/manifest";
import { alarmDefinition } from "./helpers/alarm-definition";
import { runEffect } from "./helpers/effect";

async function productManifest() {
  return appManifest({ alarm: await alarmDefinition(), wake: { close: () => undefined }, alarms: () => undefined });
}

test("the product manifest composes compaction with its summarizer provider on by default", async () => {
  const generation = Bundle.composeSync(await productManifest());
  expect(generation.capabilities).toContain("compaction");
  expect(generation.bundles).toContain("compaction-summarizer");
  expect(generation.bundles).toContain("compaction-strategy");
  expect(generation.disabled).toEqual([]);
});

test("compaction on WITHOUT a summarizer provider refuses typed seam_missing: the cut-only fallback is never the default", async () => {
  const manifest = await productManifest();
  const stripped = Bundle.Manifest.define({
    capabilities: manifest.capabilities,
    bundles: manifest.bundles.filter((bundle) => bundle.name !== "compaction-summarizer"),
    off: [],
  });
  const refused = await runEffect(Effect.flip(Bundle.compose(stripped)));
  expect(refused).toBeInstanceOf(Bundle.ComposeRefused);
  expect(refused.code).toBe("seam_missing");
  expect(refused.name).toBe("compaction-strategy");
  expect(refused.detail).toBe("@openomni/openomni/CompactionSummarizerSeam");
});
