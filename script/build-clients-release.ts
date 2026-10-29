/**
 * Packages built mclient binaries into the release record a host pins
 * clients to (#1696): one `mclient-<platform>.tar.gz` per platform holding
 * `mclient` at its root, a `.sha256` sidecar beside each archive, and
 * `release.json` beside them.
 *
 *   bun run script/build-clients-release.ts [--release PATH] [--base-url URL] [--version V] [<platform>=<binary> ...]
 *
 * With no `<platform>=<binary>` argument the host platform's
 * `clients/target/release/mclient` is packaged. Without `--base-url` the
 * artifact urls are relative to the record.
 */
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { Machine } from "../packages/protocol/src/index.js";

const CLIENTS = new URL("../clients/", import.meta.url).pathname;

export class ClientReleaseError extends Error {
  readonly name = "ClientReleaseError";
}

export interface ClientReleaseInput {
  readonly release: string;
  readonly version: string;
  readonly baseUrl?: string;
  readonly binaries: readonly (readonly [Machine.ReleasePlatform, string])[];
}

export function hostPlatform(os: string, arch: string): Machine.ReleasePlatform {
  if (os === "darwin") return "darwin-universal";
  if (os === "linux" && arch === "x64") return "linux-x86_64";
  if (os === "linux" && arch === "arm64") return "linux-arm64";
  throw new ClientReleaseError(`no release platform for ${os}-${arch}`);
}

function platformBinary(argument: string): readonly [Machine.ReleasePlatform, string] {
  const [platform, binary] = argument.split("=", 2);
  const known = Machine.releasePlatforms.find((candidate) => candidate === platform);
  if (known === undefined || !binary) throw new ClientReleaseError(`expected <platform>=<binary>, got ${argument}`);
  return [known, binary];
}

function archive(platform: Machine.ReleasePlatform, binary: string, directory: string, baseUrl?: string): Machine.ReleaseArtifact {
  const name = `mclient-${platform}.tar.gz`;
  const staging = mkdtempSync(join(tmpdir(), "mclient-release-"));
  try {
    copyFileSync(binary, join(staging, "mclient"));
    chmodSync(join(staging, "mclient"), 0o755);
    const tar = Bun.spawnSync(["tar", "-czf", join(directory, name), "-C", staging, "mclient"], { stderr: "pipe" });
    if (tar.exitCode !== 0) throw new ClientReleaseError(`tar ${name} failed: ${tar.stderr.toString()}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  const bytes = readFileSync(join(directory, name));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(join(directory, `${name}.sha256`), `${sha256}  ${name}\n`);
  return { name, bytes: bytes.length, sha256, url: baseUrl === undefined ? name : `${baseUrl.replace(/\/$/, "")}/${name}` };
}

export function buildClientRelease(input: ClientReleaseInput): Machine.Release {
  const directory = dirname(input.release);
  mkdirSync(directory, { recursive: true });
  const release = Machine.Release.parse({
    version: input.version,
    contractVersion: Machine.contractVersion,
    artifacts: Object.fromEntries(
      input.binaries.map(([platform, binary]) => [platform, archive(platform, binary, directory, input.baseUrl)]),
    ),
  });
  writeFileSync(input.release, `${JSON.stringify(release, null, 2)}\n`);
  return release;
}

export function workspaceVersion(manifest: string): string {
  const version = /^\[workspace\.package\][^[]*?^version = "([^"]+)"/m.exec(manifest)?.[1];
  if (version === undefined) throw new ClientReleaseError("clients/Cargo.toml has no [workspace.package] version");
  return version;
}

export function main(argv: readonly string[]): Machine.Release {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { release: { type: "string" }, "base-url": { type: "string" }, version: { type: "string" } },
  });
  const release = buildClientRelease({
    release: values.release ?? join(CLIENTS, "release.json"),
    version: values.version ?? workspaceVersion(readFileSync(join(CLIENTS, "Cargo.toml"), "utf-8")),
    ...(values["base-url"] === undefined ? {} : { baseUrl: values["base-url"] }),
    binaries: positionals.length > 0 ? positionals.map(platformBinary) : [[hostPlatform(process.platform, process.arch), join(CLIENTS, "target", "release", "mclient")]],
  });
  console.log(`release ${release.version}: ${Object.keys(release.artifacts).join(", ")} -> ${basename(values.release ?? "release.json")}`);
  return release;
}

if (import.meta.main) main(Bun.argv.slice(2));
