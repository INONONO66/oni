import { ChildLifecycleEvidence } from "@openomni/protocol";
import { z } from "zod";
import { packs } from "../../src/bundles/child-activity/dialects/index";
import type { ChildWatch } from "../../src/bundles/child-activity/index";
import { sourceDigest } from "../../src/bundles/child-activity/transcript";

const Fixture = z.object({ line: z.string(), phase: ChildLifecycleEvidence.shape.phase });
const Fixtures = z.object({ live: z.array(Fixture), transcript: z.array(Fixture) });
const selected = packs.find((entry) => entry.live !== undefined && entry.transcript !== undefined);
if (selected === undefined) throw new Error("a correlated source fixture is required");
export const pack = selected;
export const fixtures = Fixtures.parse(
  await Bun.file(`${import.meta.dir}/../../src/bundles/child-activity/dialects/${pack.manifest.id}/test/fixtures.json`).json(),
);
export const identity = { child: "child-redacted", turn: "turn-redacted" };
const location = {
  machine: "self", export: "workspace", path: "/redacted/transcript.jsonl",
  parser: { dialect: pack.manifest.id, version: "1" },
};
export const spec: ChildWatch = {
  ...identity, id: "child-source", sessionId: "parent",
  occupant: { command: pack.manifest.commands[0] ?? "" },
  spool: { ...location, path: "/redacted/spool.jsonl", parser: { dialect: "hook-spool", version: "1" } },
  transcript: location,
};
export function fixture(source: "live" | "transcript", phase: ChildLifecycleEvidence["phase"]): string {
  const entry = fixtures[source].find((value) => value.phase === phase);
  if (entry === undefined) throw new Error(`missing ${source} ${phase} fixture`);
  return entry.line;
}
export function reference(text: string) {
  return {
    ...location,
    generation: { kind: "size-and-prefix-hash" as const, size: Buffer.byteLength(text), prefixSha256: sourceDigest(text) },
    range: { offsetBytes: 0, lengthBytes: Buffer.byteLength(text) },
  };
}
