import { runEffect } from "../helpers/native";
import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Auth } from "../../src/auth";

const testAuthRoot = join(tmpdir(), "oni-auth-storage-");

async function withTestAuthFile<T>(fn: (filepath: string, dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(testAuthRoot);
  const filepath = join(dir, "auth.json");
  try {
    return await fn(filepath, dir);
  } finally {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}

describe("Auth Storage", () => {
  it.each([
    { name: "should write API auth to auth.json", provider: "anthropic", key: "sk-ant" },
    { name: "should work with API key auth type", provider: "openai", key: "sk-xxx" },
  ])("$name", async ({ provider, key }) => {
    await withTestAuthFile(async (filepath) => {
      await runEffect(Auth.set(provider, { type: "api", key }, { id: () => "tmp-api", authFilePath: filepath }));
      const stored = await runEffect(Auth.get(provider, filepath));
      expect(stored).toBeDefined();
      expect(stored?.type).toBe("api");
      if (stored?.type !== "api") throw new Error("expected API auth");
      expect(stored?.key).toBe(key);
    });
  });

  it("should return stored value with correct Zod type", async () => {
    await withTestAuthFile(async (filepath) => {
      await runEffect(Auth.set("anthropic", {
        type: "proxy",
        baseURL: "http://localhost:8317/v1",
        apiKey: "proxy-key",
      }, { id: () => "tmp-proxy", authFilePath: filepath }));
      const stored = await runEffect(Auth.get("anthropic", filepath));
      expect(stored).toBeDefined();
      expect(stored?.type).toBe("proxy");
      if (stored?.type !== "proxy") throw new Error("expected proxy auth");
      expect(stored?.baseURL).toBe("http://localhost:8317/v1");
      expect(stored?.apiKey).toBe("proxy-key");
    });
  });

  it("should return undefined for nonexistent key", async () => {
    await withTestAuthFile(async (filepath) => {
      expect(await runEffect(Auth.get("nonexistent", filepath))).toBeUndefined();
    });
  });

  it("preserves both credentials when set calls overlap", async () => {
    await withTestAuthFile(async (filepath) => {
      await Promise.all([
        runEffect(Auth.set("anthropic", { type: "api", key: "sk-ant" }, { id: () => "tmp-a", authFilePath: filepath })),
        runEffect(Auth.set("openai", { type: "api", key: "sk-openai" }, { id: () => "tmp-b", authFilePath: filepath })),
      ]);

      expect(await runEffect(Auth.all(filepath))).toEqual({
        anthropic: { type: "api", key: "sk-ant" },
        openai: { type: "api", key: "sk-openai" },
      });
    });
  });

  it("retains every credential when writers in separate processes overlap", async () => {
    await withTestAuthFile(async (filepath) => {
      const writers = 96;
      const storage = resolve(import.meta.dir, "../../src/auth/storage.ts");
      const script = `import { Effect } from "effect"; import { Auth } from ${JSON.stringify(storage)};
const key = process.env.AUTH_KEY ?? "";
await Effect.runPromise(Auth.set(key, { type: "api", key: "sk-" + key }, { id: () => key, authFilePath: process.env.AUTH_FILE ?? "" }));`;
      const children = Array.from({ length: writers }, (_, index) =>
        Bun.spawn([process.execPath, "-e", script], {
          cwd: resolve(import.meta.dir, "../.."),
          env: { ...process.env, AUTH_KEY: `writer-${index}`, AUTH_FILE: filepath },
          stdout: "ignore",
          stderr: "pipe",
        }));
      const exits = await Promise.all(children.map(async (child) => ({ code: await child.exited, stderr: await new Response(child.stderr).text() })));
      expect(exits.filter((exit) => exit.code !== 0)).toEqual([]);

      const stored = await runEffect(Auth.all(filepath));
      console.log(`auth cross-process writers: ${Object.keys(stored).length}/${writers} keys retained`);
      expect(stored).toEqual(Object.fromEntries(Array.from({ length: writers }, (_, index) =>
        [`writer-${index}`, { type: "api", key: `sk-writer-${index}` }])));
      expect(existsSync(`${filepath}.lock`)).toBe(false);
    });
  }, 60_000);

  it("reclaims a lock abandoned by a writer that died while holding it", async () => {
    await withTestAuthFile(async (filepath) => {
      mkdirSync(`${filepath}.lock`);
      const abandoned = new Date(Date.now() - 60_000);
      utimesSync(`${filepath}.lock`, abandoned, abandoned);

      await runEffect(Auth.set("anthropic", { type: "api", key: "sk-ant" }, { id: () => "tmp-stale", authFilePath: filepath }));

      expect(await runEffect(Auth.all(filepath))).toEqual({ anthropic: { type: "api", key: "sk-ant" } });
      expect(existsSync(`${filepath}.lock`)).toBe(false);
    });
  });

  it("surfaces a lock-directory failure other than contention as a typed write error", async () => {
    await withTestAuthFile(async (_filepath, dir) => {
      const blocked = join(dir, "blocker", "auth.json");
      await Bun.write(join(dir, "blocker"), "a file where the credential directory belongs");

      await expect(runEffect(Auth.set("anthropic", { type: "api", key: "sk-ant" }, { id: () => "tmp-blocked", authFilePath: blocked }))).rejects.toMatchObject({
        _tag: "TransportFailure",
      });
    });
  });

  it("should return all entries", async () => {
    await withTestAuthFile(async (filepath) => {
      await runEffect(Auth.set("anthropic", { type: "proxy", baseURL: "http://localhost:8317/v1" }, { id: () => "tmp-1", authFilePath: filepath }));
      await runEffect(Auth.set("openai", { type: "api", key: "sk-xxx" }, { id: () => "tmp-2", authFilePath: filepath }));
      const all = await runEffect(Auth.all(filepath));
      expect(Object.keys(all).length).toBe(2);
      expect(all.anthropic).toBeDefined();
      expect(all.openai).toBeDefined();
      expect(all.anthropic?.type).toBe("proxy");
      expect(all.openai?.type).toBe("api");
    });
  });

  it("should silently skip invalid data in auth.json", async () => {
    await withTestAuthFile(async (filepath) => {
      await Bun.write(
        filepath,
        JSON.stringify({
          valid: { type: "api", key: "sk-valid" },
          invalid: { type: "unknown", data: "bad" },
        }),
      );
      const all = await runEffect(Auth.all(filepath));
      expect(Object.keys(all).length).toBe(1);
      expect(all.valid).toBeDefined();
      expect(all.invalid).toBeUndefined();
    });
  });

  it("fails loudly on a malformed auth file instead of reading it as empty", async () => {
    await withTestAuthFile(async (filepath) => {
      await Bun.write(filepath, "{ this is not json");
      await expect(runEffect(Auth.all(filepath))).rejects.toThrow("auth file is not valid JSON");
      await expect(runEffect(Auth.get("anthropic", filepath))).rejects.toThrow("auth file is not valid JSON");
      await expect(runEffect(Auth.set("anthropic", { type: "api", key: "sk-new" }, { id: () => "tmp-new", authFilePath: filepath }))).rejects.toThrow(
        "auth file is not valid JSON",
      );
      expect(await Bun.file(filepath).text()).toBe("{ this is not json");
    });
  });

  it("fails loudly when the auth file is valid JSON but not an object", async () => {
    await withTestAuthFile(async (filepath) => {
      await Bun.write(filepath, "null");
      await expect(runEffect(Auth.all(filepath))).rejects.toThrow("auth file is not a JSON object");
    });
  });

  it("should silently skip legacy token auth data", async () => {
    await withTestAuthFile(async (filepath) => {
      await Bun.write(
        filepath,
        JSON.stringify({
          legacy: { type: "oauth", refresh: "r", access: "a", expires: 999 },
        }),
      );
      const all = await runEffect(Auth.all(filepath));
      expect(all.legacy).toBeUndefined();
    });
  });

  it("creates a missing nested credential directory", async () => {
    await withTestAuthFile(async (_filepath, dir) => {
      const nested = join(dir, "nested", "auth.json");

      await runEffect(Auth.set("anthropic", { type: "api", key: "sk-ant" }, { id: () => "tmp-ant", authFilePath: nested }));

      expect(await Bun.file(nested).json()).toEqual({
        anthropic: { type: "api", key: "sk-ant" },
      });
    });
  });

  it("removes the plaintext temp file when the atomic rename fails", async () => {
    await withTestAuthFile(async (filepath, dir) => {
      // A directory cannot be replaced by the credential temp file, forcing
      // the rename failure after the temp file has been written.
      mkdirSync(filepath);
      await Bun.write(join(filepath, "sentinel"), "keep");

      await expect(runEffect(Auth.set("anthropic", { type: "api", key: "sk-ant" }, { id: () => "tmp-ant", authFilePath: filepath }))).rejects.toMatchObject({
        _tag: "TransportFailure",
        message: expect.stringContaining("EISDIR"),
      });

      expect(readdirSync(dir).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
      expect(await Bun.file(join(filepath, "sentinel")).text()).toBe("keep");
    });
  });

  it("reads and writes only the injected path, whatever the environment says", async () => {
    await withTestAuthFile(async (filepath, dir) => {
      const previousAuthFile = process.env.ONI_AUTH_FILE;
      process.env.ONI_AUTH_FILE = join(dir, "elsewhere.json");
      try {
        await runEffect(Auth.set("anthropic", { type: "api", key: "sk-ant" }, { id: () => "tmp-env", authFilePath: filepath }));
        expect(await runEffect(Auth.get("anthropic", filepath))).toEqual({ type: "api", key: "sk-ant" });
        expect(existsSync(join(dir, "elsewhere.json"))).toBe(false);
      } finally {
        if (previousAuthFile === undefined) delete process.env.ONI_AUTH_FILE;
        else process.env.ONI_AUTH_FILE = previousAuthFile;
      }
    });
  });

  it("should set auth.json file with 0o600 permissions", async () => {
    await withTestAuthFile(async (filepath) => {
      await runEffect(Auth.set("anthropic", { type: "api", key: "sk-ant" }, { id: () => "tmp-ant", authFilePath: filepath }));
      const mode = (await Bun.file(filepath).stat())?.mode ?? 0;
      expect(mode & 0o777).toBe(0o600);
    });
  });
});

describe("Auth.reference", () => {
  it("is a stable non-secret handle", () => {
    const info = { type: "api", key: "sk-live-very-secret" } as const;
    const reference = Auth.reference(info);
    expect(reference).toEqual(Auth.reference({ ...info }));
    expect(reference.type).toBe("api");
    expect(reference.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(reference)).not.toContain(info.key);
    expect(Auth.reference({ type: "api", key: "other" }).fingerprint).not.toBe(
      reference.fingerprint,
    );
  });
});
