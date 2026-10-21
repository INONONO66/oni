import { afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { Bus } from "./bus";

/** Owns teardown for file-backed storage fixtures registered by the calling suite. */
export function storageDirectories(resetBus = false): string[] {
  const directories: string[] = [];
  afterEach(() => {
    if (resetBus) Bus.reset();
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });
  return directories;
}
