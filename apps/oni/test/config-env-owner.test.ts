import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import { ConfigurationError, loadConfig } from "../src/config";

/**
 * #1245: the ambient environment has exactly two owners in this app —
 * `src/config.ts` and `src/cli/env-file.ts`. Everything else receives values
 * as arguments, so a config test can inject a record and a boot test can
 * assert the kek resolution without touching `process.env`.
 */

const KEY_B64 = Buffer.alloc(32, 7).toString("base64");

describe("loadConfig reads the injected env record, not the ambient process", () => {
  test("Given a full record, When loaded, Then every field comes from the record", () => {
    const home = mkdtempSync(join(tmpdir(), "oni-env-owner-"));
    const config = loadConfig(home, {
      ONI_MODEL_PROVIDER: "fake",
      ONI_MODEL_ID: "owner-test",
      ONI_FAST_MODEL_ID: "judge-test",
      ONI_MODEL_API_KEY: "test-key",
      ONI_WS_HOST: "127.0.0.2",
      ONI_WS_PORT: "4123",
      ONI_WS_TOKEN: "owner-token",
      ONI_VAULT_KEY: KEY_B64,
    });
    expect(config.host).toBe("127.0.0.2");
    expect(config.wsPort).toBe(4123);
    expect(config.wsToken).toBe("owner-token");
    expect(config.model).toMatchObject({ provider: "fake", id: "owner-test", fastId: "judge-test" });
    // The kek is resolved exactly once, here: boot wiring and provisioning
    // consume `config.kek` and never resolve the environment again.
    expect(config.kek.kind).toBe("ok");
  });

  test("Given no vault key in record or home, When loaded, Then the kek is locked with the file path", () => {
    const home = mkdtempSync(join(tmpdir(), "oni-env-owner-"));
    const config = loadConfig(home, {
      ONI_MODEL_PROVIDER: "fake",
      ONI_MODEL_ID: "owner-test",
      ONI_MODEL_API_KEY: "test-key",
    });
    expect(config.kek).toEqual({
      kind: "locked",
      reason: `no ONI_VAULT_KEY and no key file at ${join(home, ".oni", "vault.key")}`,
    });
  });

  test("rejects tool output budgets below 200 or above 1 MiB", () => {
    const home = mkdtempSync(join(tmpdir(), "oni-env-owner-"));
    for (const value of ["199", "1048577"]) {
      expect(() =>
        loadConfig(home, {
          ONI_MODEL_PROVIDER: "fake",
          ONI_MODEL_ID: "owner-test",
          ONI_MODEL_API_KEY: "test-key",
          ONI_TOOL_OUTPUT_BUDGET_BYTES: value,
        }),
      ).toThrow(ConfigurationError);
    }
  });
});

describe("the env-owner boundary holds across the source tree", () => {
  test("Given src/, When scanned, Then only the two owner files mention process.env", async () => {
    const root = join(import.meta.dirname, "../src");
    const owners = new Set(["config.ts", "cli/env-file.ts"]);
    const offenders: string[] = [];
    for await (const file of new Glob("**/*.ts").scan({ cwd: root })) {
      if (owners.has(file)) continue;
      if (readFileSync(join(root, file), "utf-8").includes("process.env")) offenders.push(file);
    }
    expect([...offenders].sort()).toEqual([]);
  });
});
