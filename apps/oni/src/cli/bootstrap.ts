import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Machine } from "@oni/protocol";
import { z } from "zod";
import { HOST_ORIGIN, JOIN_TOKEN_VARIABLE, joinAddress, releasePlatform } from "../composition/machine-install";
import type { DaemonIo, ExecResult } from "./daemon";
import { CliError } from "./errors";

export const BOOTSTRAP_USAGE = "usage: oni machine bootstrap <http(s)://host[:port]> --mode <tailnet|domain> --host-pin <pin> [--token <join token>] [--force]";

/** Mirrors the client's `UpdateError` kinds: one typed refusal per failure path, the message always `<kind>: <detail>`. */
export type BootstrapRefusalKind = "unsupported_platform" | "release_unavailable" | "checksum_mismatch" | "download_failed" | "extract_failed" | "unreadable_pin" | "downgrade_refused";

export class BootstrapRefusal extends Error {
  override readonly name = "BootstrapRefusal";
  constructor(readonly kind: BootstrapRefusalKind, detail: string) {
    super(`${kind}: ${detail}`);
  }
}

export interface BootstrapOptions {
  readonly host: string;
  /** The one mode this machine attaches in (#1837); join refuses a network host without it. */
  readonly mode: Machine.AttachMode;
  /** The host key's pin the operator took from the host (#1842): join verifies the key against it and trusts nothing else. */
  readonly hostPin: string;
  readonly token?: string;
  readonly force?: boolean;
}

export interface BootstrapDeps {
  readonly home: string;
  readonly os: string;
  readonly arch: string;
  readonly io: DaemonIo;
  readonly fetch: (url: string, init: { readonly signal: AbortSignal }) => Promise<Response>;
}

/** A stalled host must not hang the CLI: the manifest answers in seconds, the archive is tens of megabytes. */
const RELEASE_TIMEOUT_MS = 60_000;
const ARCHIVE_TIMEOUT_MS = 600_000;

export interface BootstrapReceipt {
  readonly version: string;
  readonly tag: string | undefined;
  readonly platform: Machine.ReleasePlatform;
  readonly mode: Machine.AttachMode;
  readonly joinArgv: readonly string[];
  readonly tokenPresented: boolean;
  readonly join: ExecResult;
}

/** The client's own `machine-client/pin.json`: the version it is installed at. */
const Pin = z.object({ pinnedVersion: z.string() });

export function parseBootstrapArgs(args: readonly string[]): BootstrapOptions {
  const [host, ...rest] = args;
  if (host === undefined || !HOST_ORIGIN.test(host)) throw new CliError(BOOTSTRAP_USAGE);
  let token: string | undefined;
  let force = false;
  let mode: Machine.AttachMode | undefined;
  let hostPin: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (flag === "--force") {
      force = true;
    } else if (flag === "--token" && value !== undefined) {
      token = value;
      index += 1;
    } else if (flag === "--mode") {
      const parsed = Machine.AttachMode.safeParse(value);
      if (!parsed.success) throw new CliError(BOOTSTRAP_USAGE);
      mode = parsed.data;
      index += 1;
    } else if (flag === "--host-pin" && value !== undefined) {
      hostPin = value;
      index += 1;
    } else {
      throw new CliError(BOOTSTRAP_USAGE);
    }
  }
  if (mode === undefined || hostPin === undefined) throw new CliError(BOOTSTRAP_USAGE);
  return { host: host.replace(/\/$/, ""), mode, hostPin, ...(token === undefined ? {} : { token }), ...(force ? { force } : {}) };
}

async function hostedRelease(host: string, deps: BootstrapDeps): Promise<{ readonly release: Machine.Release; readonly url: string }> {
  const url = `${host}/machine/release`;
  const response = await deps.fetch(url, { signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS) });
  if (!response.ok) throw new BootstrapRefusal("release_unavailable", `${url} answered ${response.status}`);
  const parsed = Machine.Release.safeParse(await response.json());
  if (!parsed.success) throw new BootstrapRefusal("release_unavailable", `${url} is not a release record`);
  return { release: parsed.data, url };
}

function pinnedVersion(home: string): string | undefined {
  const path = join(home, ".oni", "machine-client", "pin.json");
  if (!existsSync(path)) return undefined;
  const pin = Pin.safeParse(JSON.parse(readFileSync(path, "utf-8")));
  if (!pin.success) throw new BootstrapRefusal("unreadable_pin", path);
  return pin.data.pinnedVersion;
}

function olderVersion(candidate: string, installed: string): boolean {
  const left = candidate.split(".").map(Number);
  const right = installed.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const x = left[index] ?? 0;
    const y = right[index] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

async function verifiedArchive(url: string, artifact: Machine.ReleaseArtifact, deps: BootstrapDeps): Promise<Uint8Array> {
  const response = await deps.fetch(url, { signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS) });
  if (!response.ok) throw new BootstrapRefusal("download_failed", `${url} answered ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== artifact.bytes || sha256 !== artifact.sha256) throw new BootstrapRefusal("checksum_mismatch", url);
  return bytes;
}

/** Unpacked beside the client's own version stages, never on a `noexec` tmpfs. */
function stageBinary(archive: Uint8Array, home: string, io: DaemonIo): { readonly directory: string; readonly binary: string } {
  const client = join(home, ".oni", "machine-client");
  io.makeDir(client);
  const directory = mkdtempSync(join(client, "bootstrap-"));
  const archivePath = join(directory, "mclient.tar.gz");
  writeFileSync(archivePath, archive);
  const tar = io.exec(["tar", "-xzf", archivePath, "-C", directory, "mclient"]);
  if (tar.code !== 0) {
    rmSync(directory, { recursive: true, force: true });
    throw new BootstrapRefusal("extract_failed", `tar ${archivePath}: ${tar.stderr.trimEnd()}`);
  }
  const binary = join(directory, "mclient");
  chmodSync(binary, 0o755);
  return { directory, binary };
}

/**
 * One command on a fresh machine: the host's `/machine/release`
 * answer names the archive for this platform and the SHA-256 it must carry;
 * a mismatch stops before anything is written. The verified binary is
 * staged and runs `mclient join` from there: join's own update path is the
 * only writer of `~/.oni/bin/mclient`, so a rerun on a joined machine keeps
 * its pin and binary, and a failed join changes nothing. A host release
 * older than the machine's pin is refused unless `--force` says so. Join
 * dials the address the mode selects (#1837) and verifies the host against
 * the operator's pin; it takes `--yes` because the CLI runs it without a
 * terminal for the prompt, and the explicit pin is the operator's approval.
 */
export async function runBootstrap(options: BootstrapOptions, deps: BootstrapDeps): Promise<BootstrapReceipt> {
  const platform = releasePlatform(deps.os, deps.arch);
  if (platform === undefined) throw new BootstrapRefusal("unsupported_platform", `${deps.os}-${deps.arch}`);
  const { release, url } = await hostedRelease(options.host, deps);
  const pinned = pinnedVersion(deps.home);
  if (pinned !== undefined && options.force !== true && olderVersion(release.version, pinned)) {
    throw new BootstrapRefusal("downgrade_refused", `the host's ${release.version} is older than the pinned ${pinned} (pass --force)`);
  }
  const artifact = release.artifacts[platform];
  if (artifact === undefined) throw new BootstrapRefusal("release_unavailable", `no ${platform} artifact in the host's release`);
  const archiveUrl = new URL(artifact.url, url).toString();
  const archive = await verifiedArchive(archiveUrl, artifact, deps);
  const staged = stageBinary(archive, deps.home, deps.io);
  try {
    const joinArgv = [staged.binary, "join", joinAddress(options.host, options.mode), "--mode", options.mode, "--host-pin", options.hostPin, "--yes"];
    const join = options.token === undefined ? deps.io.exec(joinArgv) : deps.io.exec(joinArgv, { [JOIN_TOKEN_VARIABLE]: options.token });
    return { version: release.version, tag: release.tag, platform, mode: options.mode, joinArgv, tokenPresented: options.token !== undefined, join };
  } finally {
    rmSync(staged.directory, { recursive: true, force: true });
  }
}

export async function bootstrapCommand(
  args: readonly string[], deps: BootstrapDeps,
  out: { readonly stdout: (line: string) => void; readonly stderr: (line: string) => void },
): Promise<number> {
  try {
    const receipt = await runBootstrap(parseBootstrapArgs(args), deps);
    out.stdout(`verified ${receipt.tag ?? receipt.version} (${receipt.platform}): mclient join ${receipt.joinArgv[2]} --mode ${receipt.mode}`);
    if (receipt.join.stdout !== "") out.stdout(receipt.join.stdout.trimEnd());
    if (receipt.join.stderr !== "") out.stderr(receipt.join.stderr.trimEnd());
    return receipt.join.code;
  } catch (error) {
    if (error instanceof BootstrapRefusal || error instanceof CliError) {
      out.stderr(error.message);
      return 1;
    }
    throw error;
  }
}
