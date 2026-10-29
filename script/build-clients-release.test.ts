import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Machine } from "../packages/protocol/src/index.js";
import { ClientReleaseError, hostPlatform, main, workspaceVersion } from "./build-clients-release";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "clients-release-"));
  directories.push(directory);
  return directory;
}

test("packages each platform binary with a digest sidecar and a schema-valid record", () => {
  const directory = scratch();
  writeFileSync(join(directory, "linux"), "linux binary");
  chmodSync(join(directory, "linux"), 0o644);
  writeFileSync(join(directory, "darwin"), "darwin binary");
  const release = join(directory, "out", "release.json");
  const built = main([
    "--release", release, "--version", "1.2.3", "--base-url", "https://example.test/r/",
    `linux-x86_64=${join(directory, "linux")}`, `darwin-universal=${join(directory, "darwin")}`,
  ]);
  expect(Machine.Release.parse(JSON.parse(readFileSync(release, "utf-8")))).toEqual(built);
  expect(built.version).toBe("1.2.3");
  expect(built.contractVersion).toBe(Machine.contractVersion);
  expect(Object.keys(built.artifacts).sort()).toEqual(["darwin-universal", "linux-x86_64"]);
  const artifact = built.artifacts["linux-x86_64"];
  const bytes = readFileSync(join(directory, "out", "mclient-linux-x86_64.tar.gz"));
  expect(artifact).toEqual({
    name: "mclient-linux-x86_64.tar.gz",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    url: "https://example.test/r/mclient-linux-x86_64.tar.gz",
  });
  expect(readFileSync(join(directory, "out", "mclient-linux-x86_64.tar.gz.sha256"), "utf-8"))
    .toBe(`${artifact?.sha256}  mclient-linux-x86_64.tar.gz\n`);
  const listing = Bun.spawnSync(["tar", "-tzf", join(directory, "out", "mclient-linux-x86_64.tar.gz")]);
  expect(listing.stdout.toString()).toBe("mclient\n");
  const permissions = Bun.spawnSync(["tar", "-tvzf", join(directory, "out", "mclient-linux-x86_64.tar.gz")]);
  expect(permissions.exitCode).toBe(0);
  expect(permissions.stdout.toString().split(/\s+/)[0]).toBe("-rwxr-xr-x");
});

test("artifact urls stay relative and the version defaults to the clients workspace", () => {
  const directory = scratch();
  writeFileSync(join(directory, "bin"), "binary");
  const built = main(["--release", join(directory, "release.json"), `linux-arm64=${join(directory, "bin")}`]);
  expect(built.artifacts["linux-arm64"]?.url).toBe("mclient-linux-arm64.tar.gz");
  expect(built.version).toBe(workspaceVersion(readFileSync(new URL("../clients/Cargo.toml", import.meta.url), "utf-8")));
});

test("malformed arguments and failed archives are typed refusals", () => {
  const directory = scratch();
  const release = join(directory, "release.json");
  for (const argument of ["windows=x", "linux-x86_64", "linux-x86_64="])
    expect(() => main(["--release", release, "--version", "1", argument])).toThrow(ClientReleaseError);
  expect(() => main(["--release", release, "--version", "1", `linux-x86_64=${join(directory, "absent")}`])).toThrow();
});

test("host platforms map to release keys", () => {
  expect(hostPlatform("darwin", "arm64")).toBe("darwin-universal");
  expect(hostPlatform("linux", "x64")).toBe("linux-x86_64");
  expect(hostPlatform("linux", "arm64")).toBe("linux-arm64");
  expect(() => hostPlatform("win32", "x64")).toThrow(new ClientReleaseError("no release platform for win32-x64"));
});

test("the version comes from the clients workspace manifest", () => {
  expect(workspaceVersion('[workspace]\nmembers = []\n\n[workspace.package]\nedition = "2021"\nversion = "0.4.0"\n')).toBe("0.4.0");
  expect(() => workspaceVersion('[package]\nversion = "1"\n')).toThrow(ClientReleaseError);
});
