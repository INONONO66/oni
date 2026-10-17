import manifest from "./manifest.json" with { type: "json" };
import { Manifest, type DialectPack } from "../pack.js";
import { launch } from "./launch.js";
import { live } from "./live.js";
import { liveConfig } from "./live-config.js";
import { locate } from "./locate.js";
import { submit } from "./submit.js";
import { transcript } from "./transcript.js";

export const claudeCode: DialectPack = {
  manifest: Manifest.parse(manifest),
  launch,
  live,
  transcript,
  submit,
  locate,
  liveConfig,
};
