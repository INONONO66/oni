import { claudeCode } from "./claude-code/index.js";
import type { DialectPack } from "./pack.js";

export const packs: readonly DialectPack[] = [claudeCode];

/** An unmatched command is observe-only; the caller must not submit to it. */
export function selectPack(occupant: {
  readonly command: string;
  readonly version?: string;
}): DialectPack | undefined {
  const command = occupant.command.split("/").at(-1);
  return packs.find(
    (pack) =>
      pack.manifest.commands.includes(command ?? "") &&
      (occupant.version === undefined || new RegExp(pack.manifest.versions).test(occupant.version)),
  );
}
