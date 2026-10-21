import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MachinesFailure } from "@oni/machines";
import { Effect } from "effect";
import { attachConfiguredMachine } from "../src/cli/machine";
import { acquireEffect, closeAcquiredEffects } from "./helpers/effect";

afterAll(closeAcquiredEffects);

test("an unreadable configuration file fails typed before any daemon attach", async () => {
  const outcome = await acquireEffect(
    Effect.flip(attachConfiguredMachine(join(tmpdir(), "missing-1272-config.json"), () => "id-1")),
  );
  expect(outcome).toBeInstanceOf(MachinesFailure);
  expect((outcome as MachinesFailure).operation).toBe("configuration.read");
});

test("a configuration that violates the schema fails typed at decode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-machine-attach-"));
  try {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ socketPath: "" }));
    const outcome = await acquireEffect(Effect.flip(attachConfiguredMachine(path, () => "id-2")));
    expect(outcome).toBeInstanceOf(MachinesFailure);
    expect((outcome as MachinesFailure).operation).toBe("configuration.decode");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
