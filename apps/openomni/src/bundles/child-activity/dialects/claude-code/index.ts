import manifest from "./manifest.json" with { type: "json" };
import { Manifest, type DialectPack } from "../pack.js";
import { launch } from "./launch.js";
import { live } from "./live.js";
import { submit } from "./submit.js";
import { transcript } from "./transcript.js";

export const claudeCode: DialectPack = {
  manifest: Manifest.parse(manifest),
  launch,
  live,
  transcript,
  submit,
};
