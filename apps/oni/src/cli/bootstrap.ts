import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Machine } from "@oni/protocol";
import { HOST_ORIGIN, joinHost, releasePlatform } from "../composition/machine-install";
import type { DaemonIo, ExecResult } from "./daemon";
import { CliError } from "./errors";

export const BOOTSTRAP_USAGE = "usage: oni machine bootstrap <http(s)://host[:port]> [--token <join token>]";

export interface BootstrapOptions {
  readonly host: string;
  readonly token?: string;
}

export interface BootstrapDeps {
  readonly home: string;
  readonly os: string;
  readonly arch: string;
  readonly io: DaemonIo;
  readonly fetch: (url: string) => Promise<Response>;
}

export interface BootstrapReceipt {
  readonly binary: string;
  readonly tag: string | undefined;
  readonly platform: Machine.ReleasePlatform;
  readonly joinArgv: readonly string[];
  readonly join: ExecResult;
}

export function parseBootstrapArgs(args: readonly string[]): BootstrapOptions {
  const [host, ...rest] = args;
  if (host === undefined || !HOST_ORIGIN.test(host)) throw new CliError(BOOTSTRAP_USAGE);
  if (rest.length === 0) return { host };
  const [flag, token, ...extra] = rest;
  if (flag !== "--token" || token === undefined || extra.length > 0) throw new CliError(BOOTSTRAP_USAGE);
  return { host, token };
}

async function hostedRelease(host: string, deps: BootstrapDeps): Promise<{ readonly release: Machine.Release; readonly url: string }> {
  const url = `${host}/machine/release`;
  const response = await deps.fetch(url);
  if (!response.ok) throw new CliError(`release unavailable at ${url}`);
  const parsed = Machine.Release.safeParse(await response.json());
  if (!parsed.success) throw new CliError(`invalid release record at ${url}`);
  return { release: parsed.data, url };
}

async function verifiedArchive(url: string, artifact: Machine.ReleaseArtifact, deps: BootstrapDeps): Promise<Uint8Array> {
  const response = await deps.fetch(url);
  if (!response.ok) throw new CliError(`download failed: ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== artifact.bytes || sha256 !== artifact.sha256) throw new CliError(`checksum_mismatch: ${url}`);
  return bytes;
}

function installBinary(archive: Uint8Array, home: string, io: DaemonIo): string {
  const stage = mkdtempSync(join(tmpdir(), "oni-bootstrap-"));
  try {
    const archivePath = join(stage, "mclient.tar.gz");
    writeFileSync(archivePath, archive);
    const tar = io.exec(["tar", "-xzf", archivePath, "-C", stage, "mclient"]);
    if (tar.code !== 0) throw new CliError(`tar ${archivePath} failed: ${tar.stderr}`);
    const directory = join(home, ".oni", "bin");
    io.makeDir(directory);
    const staged = join(directory, "mclient.staged");
    copyFileSync(join(stage, "mclient"), staged);
    chmodSync(staged, 0o755);
    const binary = join(directory, "mclient");
    renameSync(staged, binary);
    return binary;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * One command on a fresh machine (#1838): the host's `/machine/release`
 * answer names the archive for this platform and the SHA-256 it must carry;
 * a mismatch stops before anything is written. The binary is installed to
 * `~/.oni/bin/mclient` (0755) and runs `mclient join`, which stages the same
 * verified release, records the pin and installs the service.
 */
export async function runBootstrap(options: BootstrapOptions, deps: BootstrapDeps): Promise<BootstrapReceipt> {
  const platform = releasePlatform(deps.os, deps.arch);
  if (platform === undefined) throw new CliError(`unsupported platform: ${deps.os}-${deps.arch}`);
  const { release, url } = await hostedRelease(options.host, deps);
  const artifact = release.artifacts[platform];
  if (artifact === undefined) throw new CliError(`no ${platform} artifact in the host's release`);
  const archiveUrl = new URL(artifact.url, url).toString();
  const archive = await verifiedArchive(archiveUrl, artifact, deps);
  const binary = installBinary(archive, deps.home, deps.io);
  const joinArgv = [binary, "join", joinHost(options.host), ...(options.token === undefined ? [] : ["--token", options.token])];
  return { binary, tag: release.tag, platform, joinArgv, join: deps.io.exec(joinArgv) };
}

export async function bootstrapCommand(
  args: readonly string[], deps: BootstrapDeps,
  out: { readonly stdout: (line: string) => void; readonly stderr: (line: string) => void },
): Promise<number> {
  try {
    const receipt = await runBootstrap(parseBootstrapArgs(args), deps);
    out.stdout(`installed ${receipt.binary} (${receipt.tag ?? "untagged"}, ${receipt.platform})`);
    if (receipt.join.stdout !== "") out.stdout(receipt.join.stdout.trimEnd());
    if (receipt.join.stderr !== "") out.stderr(receipt.join.stderr.trimEnd());
    return receipt.join.code;
  } catch (error) {
    out.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
