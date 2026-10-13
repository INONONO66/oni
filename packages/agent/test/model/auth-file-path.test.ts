import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { resolveAuthFilePath } from "../../src/model/model/loader";

/**
 * The model loader is the llm package's one environment owner. The
 * credential path is a pure function of an injected record, so `auth/storage`
 * can consume it without any ambient read of its own.
 */
describe("resolveAuthFilePath", () => {
  test("Given an override, When resolved, Then it is absolute even from a relative value", () => {
    const path = resolveAuthFilePath({ OPENOMNI_AUTH_FILE: "relative/auth.json" });
    expect(path).toBe(resolve("relative/auth.json"));
    expect(isAbsolute(path)).toBe(true);
  });

  test("Given no override, When resolved, Then the home default applies", () => {
    expect(resolveAuthFilePath({})).toBe(join(homedir(), ".openomni", "auth.json"));
    // An exported-but-empty variable is not a path; the default still applies.
    expect(resolveAuthFilePath({ OPENOMNI_AUTH_FILE: "" })).toBe(
      join(homedir(), ".openomni", "auth.json"),
    );
  });
});
