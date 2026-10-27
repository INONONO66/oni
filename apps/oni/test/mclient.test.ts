import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnMclient } from "../src/composition/mclient";
import { acquireEffect, closeAcquiredEffects } from "./helpers/effect";

const roots: string[] = [];
afterEach(async () => {
  await closeAcquiredEffects();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function binary(source: string) {
  const root = mkdtempSync(join(tmpdir(), "oni-mclient-signal-"));
  roots.push(root);
  const path = join(root, "client");
  writeFileSync(path, `#!/bin/sh\n${source}\n`);
  chmodSync(path, 0o755);
  return { root, path, config: join(root, "config") };
}

async function runningChild(source: string) {
  const fixture = binary(`${source}\nprintf ready > "$3.ready"\nexec sleep 30`);
  const ready = Promise.withResolvers<void>();
  const watcher = watch(fixture.root, (_event, name) => {
    if (name === "config.ready") ready.resolve();
  });
  try {
    const child = await acquireEffect(spawnMclient(fixture.config, fixture.path));
    await ready.promise;
    return child;
  } finally {
    watcher.close();
  }
}

test("an absent process group resolves an EPERM signal after the survivor probe", async () => {
  const fixture = binary("exit 0");
  const error = Object.assign(new Error("EPERM"), { code: "EPERM" });
  const kill = spyOn(process, "kill").mockImplementation(() => {
    throw error;
  });
  try {
    const child = await acquireEffect(spawnMclient(fixture.config, fixture.path));
    expect(await child.exited).toBe(0);
    expect(kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
  } finally {
    kill.mockRestore();
  }
});

test("a live process group preserves the original EPERM signal error", async () => {
  const child = await runningChild("");
  const error = Object.assign(new Error("EPERM"), { code: "EPERM" });
  const kill = spyOn(process, "kill").mockImplementation(() => {
    throw error;
  });
  try {
    await expect(child.stop()).rejects.toBe(error);
    expect(kill).toHaveBeenCalledWith(-child.pid, "SIGTERM");
  } finally {
    kill.mockRestore();
    await child.stop();
  }
});

test("a missing process group resolves an ESRCH signal without probing", async () => {
  const fixture = binary("exit 0");
  const error = Object.assign(new Error("ESRCH"), { code: "ESRCH" });
  const kill = spyOn(process, "kill").mockImplementation(() => {
    throw error;
  });
  try {
    const child = await acquireEffect(spawnMclient(fixture.config, fixture.path));
    expect(await child.exited).toBe(0);
    expect(kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
  } finally {
    kill.mockRestore();
  }
});

test("the stop deadline SIGKILLs a client that ignores SIGTERM", async () => {
  const child = await runningChild("trap '' TERM");
  const kill = spyOn(process, "kill");
  try {
    await child.stop();
    expect(kill).toHaveBeenCalledWith(-child.pid, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
    expect(await child.exited).toBe(137);
  } finally {
    kill.mockRestore();
  }
}, 5000);
