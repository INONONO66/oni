import { CliError } from "./errors";
import { dirname, join } from "node:path";

/**
 * TS-owned service management: launchd (macOS) and systemd user units
 * (Linux) are generated and driven from this one module — there is no bash
 * band to drift out of sync with the app.
 */

const LAUNCHD_LABEL = "ai.oni.resident";
const SYSTEMD_UNIT = "oni";

export interface DaemonTarget {
  readonly platform: "darwin" | "linux";
  readonly home: string;
  readonly uid: number;
  /** Absolute bun executable, resolved at install time (`process.execPath`). */
  readonly bunPath: string;
  /** Absolute CLI entry the service runs: `<bun> <entry> start`. */
  readonly entryPath: string;
}

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DaemonIo {
  readonly exec: (argv: readonly string[]) => ExecResult;
  readonly writeFile: (path: string, content: string) => void;
  readonly makeDir: (path: string) => void;
  readonly removeFile: (path: string) => void;
  readonly fileExists: (path: string) => boolean;
}

export function unitPath(target: DaemonTarget): string {
  return target.platform === "darwin"
    ? join(target.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`)
    : join(target.home, ".config", "systemd", "user", `${SYSTEMD_UNIT}.service`);
}

function logPath(target: DaemonTarget): string {
  return join(target.home, ".oni", "logs", "oni.log");
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Unit files are line-oriented; a control character in a path is an injection, not a layout. */
function assertUnitSafe(label: string, value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control chars is the point
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new CliError(
      `${label} contains control characters and cannot be written into a service unit`,
    );
  }
  return value;
}

/**
 * systemd quoted-argument escaping: backslash and quote escapes, `%`
 * specifiers doubled, `$` doubled so ExecStart never environment-expands a
 * literal path segment.
 */
function escapeSystemdArg(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/%/g, "%%")
    .replace(/\$/g, "$$$$");
}

export function renderLaunchdPlist(target: DaemonTarget): string {
  assertUnitSafe("bun path", target.bunPath);
  assertUnitSafe("entry path", target.entryPath);
  assertUnitSafe("home path", target.home);
  const log = escapeXml(logPath(target));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${LAUNCHD_LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${escapeXml(target.bunPath)}</string>
\t\t<string>${escapeXml(target.entryPath)}</string>
\t\t<string>start</string>
\t</array>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>WorkingDirectory</key>
\t<string>${escapeXml(target.home)}</string>
\t<key>StandardOutPath</key>
\t<string>${log}</string>
\t<key>StandardErrorPath</key>
\t<string>${log}</string>
</dict>
</plist>
`;
}

export function renderSystemdUnit(target: DaemonTarget): string {
  const bun = escapeSystemdArg(assertUnitSafe("bun path", target.bunPath));
  const entry = escapeSystemdArg(assertUnitSafe("entry path", target.entryPath));
  return `[Unit]
Description=Oni Resident
After=network.target

[Service]
Type=simple
ExecStart="${bun}" "${entry}" start
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=default.target
`;
}

function run(io: DaemonIo, argv: readonly string[]): ExecResult {
  const result = io.exec(argv);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    throw new CliError(`${argv.join(" ")} failed: ${detail}`);
  }
  return result;
}

function launchdDomainTarget(target: DaemonTarget): string {
  return `gui/${target.uid}/${LAUNCHD_LABEL}`;
}

/** (Re)loads the launchd job: a previous generation may be loaded, so bootout is allowed to fail. */
function launchdReload(target: DaemonTarget, io: DaemonIo): void {
  io.exec(["launchctl", "bootout", launchdDomainTarget(target)]);
  run(io, ["launchctl", "bootstrap", `gui/${target.uid}`, unitPath(target)]);
}

/** (Re)loads the service: idempotent, safe to run over an existing install. */
export function daemonInstall(target: DaemonTarget, io: DaemonIo): string {
  const path = unitPath(target);
  if (target.platform === "darwin") {
    // launchd opens the configured log paths itself; missing parents kill the job at load.
    io.makeDir(dirname(logPath(target)));
    io.writeFile(path, renderLaunchdPlist(target));
    launchdReload(target, io);
    return `installed and started (launchd: ${path})`;
  }
  io.writeFile(path, renderSystemdUnit(target));
  run(io, ["systemctl", "--user", "daemon-reload"]);
  run(io, ["systemctl", "--user", "enable", SYSTEMD_UNIT]);
  // restart, not `enable --now`: an already-running previous generation must be replaced.
  run(io, ["systemctl", "--user", "restart", SYSTEMD_UNIT]);
  // Without linger the user manager dies at logout and never starts at
  // boot — the advertised 24/7 contract is unmet, so this failure is hard.
  const linger = io.exec(["loginctl", "enable-linger"]);
  if (linger.code !== 0) {
    throw new CliError(
      `installed and started (systemd user unit: ${path}), but linger could not be enabled — the daemon dies at logout and does not start at boot. Run \`loginctl enable-linger\` and re-run \`oni daemon install\`.`,
    );
  }
  return `installed and started (systemd user unit: ${path}); linger enabled — survives logout and starts at boot`;
}

function proveLaunchdStopped(target: DaemonTarget, io: DaemonIo): void {
  const bootout = io.exec(["launchctl", "bootout", launchdDomainTarget(target)]);
  if (bootout.code === 0) return;
  // Only a specifically recognized not-found answer proves the job is
  // unloaded; permission or IPC failures prove nothing.
  const print = io.exec(["launchctl", "print", launchdDomainTarget(target)]);
  const notLoaded =
    print.code !== 0 && /could not find service/i.test(`${print.stderr}${print.stdout}`);
  if (!notLoaded) {
    throw new CliError("daemon could not be stopped and may still be loaded — unit left installed");
  }
}

function proveSystemdStopped(io: DaemonIo): void {
  const disable = io.exec(["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT]);
  if (disable.code === 0) return;
  // Stop and disable are separate outcomes; each must be proven.
  const state = io.exec(["systemctl", "--user", "is-active", SYSTEMD_UNIT]).stdout.trim();
  if (state !== "inactive" && state !== "failed") {
    throw new CliError(
      `daemon could not be stopped (state: ${state || "unknown"}) — unit left installed`,
    );
  }
  const enabled = io.exec(["systemctl", "--user", "is-enabled", SYSTEMD_UNIT]).stdout.trim();
  if (enabled !== "disabled" && enabled !== "not-found") {
    throw new CliError(
      `daemon stopped but is still enabled (state: ${enabled || "unknown"}) — unit left installed`,
    );
  }
}

export function daemonUninstall(target: DaemonTarget, io: DaemonIo): string {
  const path = unitPath(target);
  if (!io.fileExists(path)) return "not installed";
  // The stop must either succeed or the job must be provably unloaded —
  // transitional states (activating, loaded-but-waiting KeepAlive) are NOT
  // license to delete the unit out from under a live daemon.
  if (target.platform === "darwin") {
    proveLaunchdStopped(target, io);
  } else {
    proveSystemdStopped(io);
  }
  io.removeFile(path);
  if (target.platform === "darwin") return "stopped and uninstalled (launchd)";
  run(io, ["systemctl", "--user", "daemon-reload"]);
  return "stopped and uninstalled (systemd)";
}

export function daemonStart(target: DaemonTarget, io: DaemonIo): string {
  const path = unitPath(target);
  if (!io.fileExists(path)) {
    throw new CliError("not installed — run `oni daemon install` first");
  }
  if (target.platform === "darwin") {
    launchdReload(target, io);
    return "started";
  }
  run(io, ["systemctl", "--user", "start", SYSTEMD_UNIT]);
  return "started";
}

export function daemonStop(target: DaemonTarget, io: DaemonIo): string {
  if (target.platform === "darwin") {
    run(io, ["launchctl", "bootout", launchdDomainTarget(target)]);
    return "stopped";
  }
  run(io, ["systemctl", "--user", "stop", SYSTEMD_UNIT]);
  return "stopped";
}

export function daemonRestart(target: DaemonTarget, io: DaemonIo): string {
  if (target.platform === "darwin") {
    run(io, ["launchctl", "kickstart", "-k", launchdDomainTarget(target)]);
    return "restarted";
  }
  run(io, ["systemctl", "--user", "restart", SYSTEMD_UNIT]);
  return "restarted";
}

export function daemonActive(target: DaemonTarget, io: DaemonIo): boolean {
  if (target.platform === "darwin") {
    const result = io.exec(["launchctl", "print", launchdDomainTarget(target)]);
    return result.code === 0 && result.stdout.includes("state = running");
  }
  const result = io.exec(["systemctl", "--user", "is-active", SYSTEMD_UNIT]);
  return result.stdout.trim() === "active";
}

export function daemonStatus(target: DaemonTarget, io: DaemonIo): string {
  if (!io.fileExists(unitPath(target))) return "not installed";
  return daemonActive(target, io) ? "active" : "inactive";
}
