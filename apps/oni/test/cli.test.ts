import { describe, expect, spyOn, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach } from "bun:test";
import type { CliDeps } from "../src/cli/commands";
import { CliError } from "../src/cli/errors";
import { runCli } from "../src/cli/commands";
import { ONI_VERSION } from "../src/version";
import type { DaemonIo, DaemonTarget, ExecResult } from "../src/cli/daemon";
import {
  daemonActive,
  daemonInstall,
  daemonRestart,
  daemonStart,
  daemonStatus,
  daemonStop,
  daemonUninstall,
  renderLaunchdPlist,
  renderSystemdUnit,
  unitPath,
} from "../src/cli/daemon";
import {
  applyEnvFile,
  mergeEnvFile,
  parseEnvFile,
  renderEnvFile,
  writeEnvFile,
} from "../src/cli/env-file";
import { parseWsPort } from "../src/config";
import { runDoctor } from "../src/cli/doctor";
import { processEntryPath } from "../src/process-entry-path";
import type { DoctorPorts } from "../src/cli/doctor";
import { createCliDeps, main } from "../src/cli/main";
import { createAppLedger } from "./helpers/ledger";
import { testClock } from "./helpers/test-entropy";
import { gatherOnboarding } from "../src/cli/onboard";
import { doctorStatuses, failedSystemdStop } from "./helpers/cli-fixtures";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "oni-cli-"));
  directories.push(dir);
  return dir;
}

describe("env file", () => {
  test("parse: comments, blanks, quotes, and duplicate keys (last wins)", () => {
    const parsed = parseEnvFile(
      [
        "# comment",
        "",
        "ONI_MODEL_ID=first",
        'ONI_MODEL_ID="second"',
        "ONI_MODEL_API_KEY='sk-123='",
        "export ONI_WS_PORT=4001",
        "not a line",
        "lowercase=skipped",
      ].join("\r\n"),
    );
    expect(parsed.get("ONI_MODEL_ID")).toBe("second");
    expect(parsed.get("ONI_MODEL_API_KEY")).toBe("sk-123=");
    expect(parsed.get("ONI_WS_PORT")).toBe("4001");
    expect(parsed.has("lowercase")).toBe(false);
    expect(parsed.size).toBe(3);
  });

  test("render round-trips through parse and rejects line breaks", () => {
    // Values the parser would unquote must survive a write->read cycle intact.
    const entries = [
      { key: "ONI_WS_PORT", value: "3000" },
      { key: "ONI_MODEL_API_KEY", value: '"secret"' },
      { key: "ONI_MODEL_ID", value: "'quoted'" },
    ];
    const parsed = parseEnvFile(renderEnvFile(entries));
    for (const entry of entries) {
      expect(parsed.get(entry.key)).toBe(entry.value);
    }
    expect(() => renderEnvFile([{ key: "A", value: "x\ny" }])).toThrow("line breaks");
    expect(() => renderEnvFile([{ key: "bad key", value: "x" }])).toThrow("invalid env key");
  });

  test("write replaces a symlink at the destination instead of following it", () => {
    const dir = tempDir();
    const victim = join(dir, "victim");
    const path = join(dir, "env");
    writeFileSync(victim, "untouched");
    symlinkSync(victim, path);
    writeEnvFile(path, [{ key: "ONI_MODEL_ID", value: "m" }]);
    expect(readFileSync(victim, "utf-8")).toBe("untouched");
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe("ONI_MODEL_ID=m\n");
  });

  test("write creates parents and enforces 0600 on overwrite", () => {
    const path = join(tempDir(), "nested", "env");
    writeEnvFile(path, [{ key: "ONI_MODEL_ID", value: "one" }]);
    writeEnvFile(path, [{ key: "ONI_MODEL_ID", value: "two" }]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf-8")).toBe("ONI_MODEL_ID=two\n");
  });

  test("failed replacement removes its temporary file", () => {
    const path = tempDir();
    expect(() => writeEnvFile(path, [{ key: "ONI_MODEL_ID", value: "m" }])).toThrow();
    expect(
      readdirSync(dirname(path)).filter((name) => name.startsWith(`${basename(path)}.`)),
    ).toEqual([]);
  });

  test("merge preserves explicit empty values and does not mutate process env", () => {
    const env = { ONI_MODEL_ID: "", ONI_WS_PORT: undefined };
    expect(
      Object.fromEntries(mergeEnvFile("ONI_MODEL_ID=file\nONI_WS_PORT=4000", env)),
    ).toEqual({
      ONI_MODEL_ID: "",
      ONI_WS_PORT: "4000",
    });
    expect(env).toEqual({ ONI_MODEL_ID: "", ONI_WS_PORT: undefined });
  });

  test("apply fills only unset keys; process env wins; missing file is a no-op", () => {
    const path = join(tempDir(), "env");
    writeEnvFile(path, [
      { key: "ONI_MODEL_ID", value: "from-file" },
      { key: "ONI_WS_PORT", value: "4000" },
    ]);
    const env: Record<string, string | undefined> = { ONI_MODEL_ID: "from-process" };
    applyEnvFile(path, env);
    expect(env.ONI_MODEL_ID).toBe("from-process");
    expect(env.ONI_WS_PORT).toBe("4000");
    applyEnvFile(join(tempDir(), "absent"), env);
    expect(env.ONI_WS_PORT).toBe("4000");
  });
});

interface FakeIo extends DaemonIo {
  readonly commands: string[][];
  readonly files: Map<string, string>;
  readonly dirs: string[];
}

function fakeIo(respond: (argv: readonly string[]) => ExecResult): FakeIo {
  const commands: string[][] = [];
  const files = new Map<string, string>();
  const dirs: string[] = [];
  return {
    commands,
    files,
    dirs,
    exec: (argv) => {
      commands.push([...argv]);
      return respond(argv);
    },
    writeFile: (path, content) => files.set(path, content),
    removeFile: (path) => files.delete(path),
    makeDir: (path) => dirs.push(path),
    fileExists: (path) => files.has(path),
  };
}

const ok: ExecResult = { code: 0, stdout: "", stderr: "" };

const darwinTarget: DaemonTarget = {
  platform: "darwin",
  home: "/Users/owner",
  uid: 501,
  bunPath: "/opt/bun",
  entryPath: "/pkg/dist/app/main.js",
};

const linuxTarget: DaemonTarget = { ...darwinTarget, platform: "linux", home: "/home/owner" };

describe("daemon units", () => {
  test("launchd plist carries bun+entry+supervise, KeepAlive, and log paths", () => {
    const plist = renderLaunchdPlist(darwinTarget);
    expect(plist).toContain("<string>/opt/bun</string>");
    expect(plist).toContain("<string>/pkg/dist/app/main.js</string>");
    expect(plist).toContain("<string>supervise</string>");
    expect(plist).toContain("<key>KeepAlive</key>\n\t<true/>");
    expect(plist).toContain("<string>/Users/owner/.oni/logs/oni.log</string>");
  });

  test("systemd unit quotes ExecStart paths and restarts on failure", () => {
    const unit = renderSystemdUnit(linuxTarget);
    expect(unit).toContain('ExecStart="/opt/bun" "/pkg/dist/app/main.js" supervise\nExecReload="/opt/bun" "/pkg/dist/app/main.js" deploy --reload\n');
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=default.target");
  });

  test("systemd unit escapes %, quotes, and backslashes; control chars are rejected", () => {
    const hostile: DaemonTarget = {
      ...linuxTarget,
      bunPath: '/opt/we"ird/bun',
      entryPath: "/pkg/100%/back\\slash/main.js",
    };
    const unit = renderSystemdUnit(hostile);
    expect(unit).toContain(
      'ExecStart="/opt/we\\"ird/bun" "/pkg/100%%/back\\\\slash/main.js" supervise',
    );
    // `$` must never reach systemd unescaped: ExecStart environment-expands it.
    const curly = "{X}";
    const dollar = renderSystemdUnit({ ...linuxTarget, entryPath: `/pkg/$VER/$${curly}/main.js` });
    expect(dollar).toContain(`"/pkg/$$VER/$$${curly}/main.js"`);
    expect(dollar).not.toContain("/pkg/$VER");
    expect(() => renderSystemdUnit({ ...linuxTarget, entryPath: "/pkg\nExecStart=/evil" })).toThrow(
      "control characters",
    );
    expect(() => renderLaunchdPlist({ ...darwinTarget, bunPath: "/opt\nbun" })).toThrow(
      "control characters",
    );
  });

  test("darwin install creates the log dir, writes the plist, boots out the old generation, bootstraps", () => {
    const io = fakeIo(() => ok);
    const message = daemonInstall(darwinTarget, io);
    // launchd opens the configured log paths itself; the dir must exist first.
    expect(io.dirs).toEqual(["/Users/owner/.oni/logs"]);
    expect(io.files.has(unitPath(darwinTarget))).toBe(true);
    expect(io.commands).toEqual([
      ["launchctl", "bootout", "gui/501/ai.oni.resident"],
      ["launchctl", "bootstrap", "gui/501", unitPath(darwinTarget)],
    ]);
    expect(message).toContain("launchd");
  });

  test("linux install reloads, enables, restarts (replacing a running old generation), enables linger", () => {
    const io = fakeIo(() => ok);
    const message = daemonInstall(linuxTarget, io);
    expect(io.files.get(unitPath(linuxTarget))).toContain("ExecStart=");
    expect(io.commands).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "oni"],
      ["systemctl", "--user", "restart", "oni"],
      ["loginctl", "enable-linger"],
    ]);
    expect(message).toContain("linger enabled");
  });

  test("linux install fails hard when linger cannot be enabled", () => {
    // Exit 0 with an unmet 24/7 contract is a lie; the unit stays installed
    // and running, but the command must fail with remediation.
    const io = fakeIo((argv) =>
      argv[0] === "loginctl" ? { code: 1, stdout: "", stderr: "denied" } : ok,
    );
    expect(() => daemonInstall(linuxTarget, io)).toThrow("linger could not be enabled");
    expect(io.files.has(unitPath(linuxTarget))).toBe(true);
  });

  test("install surfaces the failing command with stderr", () => {
    const io = fakeIo((argv) =>
      argv[1] === "bootstrap" ? { code: 5, stdout: "", stderr: "Bootstrap failed" } : ok,
    );
    expect(() => daemonInstall(darwinTarget, io)).toThrow("Bootstrap failed");
  });

  test("uninstall on a clean host reports not installed and runs nothing", () => {
    const io = fakeIo(() => ok);
    expect(daemonUninstall(linuxTarget, io)).toBe("not installed");
    expect(io.commands).toEqual([]);
  });

  test("uninstall removes the unit after a successful stop", () => {
    const io = fakeIo(() => ok);
    io.files.set(unitPath(linuxTarget), "unit");
    expect(daemonUninstall(linuxTarget, io)).toContain("uninstalled");
    expect(io.files.has(unitPath(linuxTarget))).toBe(false);
    expect(io.commands).toEqual([
      ["systemctl", "--user", "disable", "--now", "oni"],
      ["systemctl", "--user", "daemon-reload"],
    ]);
  });

  test("uninstall after a failed stop proceeds only when inactive AND disabled are proven", () => {
    const io = fakeIo(
      failedSystemdStop(
        { code: 3, stdout: "inactive\n", stderr: "" },
        { code: 1, stdout: "disabled\n", stderr: "" },
      ),
    );
    io.files.set(unitPath(linuxTarget), "unit");
    expect(daemonUninstall(linuxTarget, io)).toContain("uninstalled");
  });

  test("uninstall keeps the unit when the process stopped but the enable symlink survived", () => {
    // A dangling enable symlink resurrects the service on reinstall; a
    // failed disable is not success just because the process is inactive.
    const io = fakeIo(
      failedSystemdStop(
        { code: 3, stdout: "inactive\n", stderr: "" },
        { code: 0, stdout: "enabled\n", stderr: "" },
        "could not remove default.target.wants",
      ),
    );
    io.files.set(unitPath(linuxTarget), "unit");
    expect(() => daemonUninstall(linuxTarget, io)).toThrow("still enabled");
    expect(io.files.has(unitPath(linuxTarget))).toBe(true);
  });

  test("uninstall keeps the unit when the stop fails and the state is transitional", () => {
    // `activating` is not `inactive`: deleting the unit here orphans a
    // daemon that is actively coming up.
    const io = fakeIo(failedSystemdStop({ code: 0, stdout: "activating\n", stderr: "" }));
    io.files.set(unitPath(linuxTarget), "unit");
    expect(() => daemonUninstall(linuxTarget, io)).toThrow("could not be stopped");
    expect(io.files.has(unitPath(linuxTarget))).toBe(true);
  });

  test.each([
    { code: 0, stdout: "state = waiting", stderr: "" },
    { code: 1, stdout: "", stderr: "Operation not permitted" },
  ])("darwin uninstall retains the plist without proof of unload: %j", (query) => {
    const io = fakeIo((argv) => {
      if (argv[1] === "bootout") return { code: 5, stdout: "", stderr: "busy" };
      if (argv[1] === "print") return query;
      return ok;
    });
    io.files.set(unitPath(darwinTarget), "plist");
    expect(() => daemonUninstall(darwinTarget, io)).toThrow("may still be loaded");
    expect(io.files.has(unitPath(darwinTarget))).toBe(true);
  });

  test("darwin uninstall proceeds when the job is specifically not found", () => {
    const io = fakeIo((argv) => {
      if (argv[1] === "bootout") return { code: 3, stdout: "", stderr: "No such process" };
      if (argv[1] === "print")
        return {
          code: 113,
          stdout: "",
          stderr: 'Could not find service "ai.oni.resident" in domain for uid: 501',
        };
      return ok;
    });
    io.files.set(unitPath(darwinTarget), "plist");
    expect(daemonUninstall(darwinTarget, io)).toContain("uninstalled");
    expect(io.files.has(unitPath(darwinTarget))).toBe(false);
  });

  test("stop failure propagates (launchctl bootout on unloaded service)", () => {
    const io = fakeIo(() => ({ code: 3, stdout: "", stderr: "No such process" }));
    expect(() => daemonStop(darwinTarget, io)).toThrow("No such process");
  });

  test("start, stop, and restart dispatch both platform service commands", () => {
    for (const [target, expected] of [
      [darwinTarget, ["launchctl", "kickstart", "-k", "gui/501/ai.oni.resident"]],
      [linuxTarget, ["systemctl", "--user", "restart", "oni"]],
    ] as const) {
      const io = fakeIo(() => ok);
      io.files.set(unitPath(target), "unit");
      expect(daemonStart(target, io)).toBe("started");
      expect(daemonStop(target, io)).toBe("stopped");
      expect(daemonRestart(target, io)).toBe("restarted");
      expect(io.commands.at(-1)).toEqual([...expected]);
    }
  });

  test("status and activity read launchctl print state", () => {
    const running = fakeIo((argv) =>
      argv[1] === "print" ? { code: 0, stdout: "state = running", stderr: "" } : ok,
    );
    running.files.set(unitPath(darwinTarget), "plist");
    expect(daemonStatus(darwinTarget, running)).toBe("active");
    const stopped = fakeIo(() => ({ code: 113, stdout: "", stderr: "" }));
    stopped.files.set(unitPath(darwinTarget), "plist");
    expect(daemonStatus(darwinTarget, stopped)).toBe("inactive");
    expect(
      daemonActive(
        linuxTarget,
        fakeIo(() => ({ code: 3, stdout: "inactive\n", stderr: "" })),
      ),
    ).toBe(false);
    expect(
      daemonActive(
        linuxTarget,
        fakeIo(() => ({ code: 0, stdout: "active\n", stderr: "" })),
      ),
    ).toBe(true);
  });
});

describe("onboarding", () => {
  function scriptedAsk(answers: Record<string, string>) {
    return (question: string): Promise<string> => {
      const match = Object.entries(answers).find(([prefix]) => question.startsWith(prefix));
      return Promise.resolve(match?.[1] ?? "");
    };
  }

  test("gathers model config and leaves channel provisioning to declarations", async () => {
    const entries = await gatherOnboarding(
      scriptedAsk({
        "Model id": "claude-x",
        "Model API key": "sk-1",
      }),
    );
    expect(entries).toEqual([
      { key: "ONI_MODEL_PROVIDER", value: "anthropic" },
      { key: "ONI_MODEL_ID", value: "claude-x" },
      { key: "ONI_MODEL_API_KEY", value: "sk-1" },
      { key: "ONI_WS_PORT", value: "3000" },
    ]);
  });

  test("rejects a missing API key, a non-numeric port, and port 0", async () => {
    await expect(gatherOnboarding(scriptedAsk({ "Model id": "m" }))).rejects.toThrow(
      "Model API key is required",
    );
    await expect(
      gatherOnboarding(
        scriptedAsk({ "Model id": "m", "Model API key": "k", "WebSocket port": "http" }),
      ),
    ).rejects.toThrow("integer");
    await expect(
      gatherOnboarding(
        scriptedAsk({ "Model id": "m", "Model API key": "k", "WebSocket port": "0" }),
      ),
    ).rejects.toThrow("1 to 65535");
  });

  test.each(["1", "80", "65535"])("onboarding accepts decimal port %s", async (port) => {
    const entries = await gatherOnboarding(
      scriptedAsk({
        "Model id": "m",
        "Model API key": "k",
        "WebSocket port": port,
      }),
    );
    expect(entries.find((entry) => entry.key === "ONI_WS_PORT")?.value).toBe(port);
  });

  test.each([
    "1e2",
    "0x50",
    "+80",
    "80.0",
    "65536",
    "invalid",
    "0",
  ])("onboarding rejects non-decimal or out-of-range port %s with the original error contract", async (port) => {
    const result = gatherOnboarding(
      scriptedAsk({
        "Model id": "m",
        "Model API key": "k",
        "WebSocket port": port,
      }),
    );
    await expect(result).rejects.toMatchObject({
      constructor: CliError,
      name: "CliError",
      message: "WebSocket port must be an integer from 1 to 65535",
    });
  });

  test("secret prompts are flagged so the terminal never echoes them", async () => {
    const secretQuestions: string[] = [];
    await gatherOnboarding((question, options) => {
      if (options?.secret) secretQuestions.push(question);
      if (question.startsWith("Model id")) return Promise.resolve("m");
      if (question.startsWith("Model API key")) return Promise.resolve("k");
      return Promise.resolve("");
    });
    expect(secretQuestions).toEqual(["Model API key"]);
  });
});

describe("doctor", () => {
  const healthyPorts: DoctorPorts = {
    bunVersion: "1.3.0",
    envFilePresent: true,
    effectiveEnv: new Map([
      ["ONI_MODEL_PROVIDER", "anthropic"],
      ["ONI_MODEL_ID", "m"],
      ["ONI_MODEL_API_KEY", "k"],
      ["ONI_WS_PORT", "4123"],
    ]),
    unitInstalled: true,
    daemonActive: true,
    lingerEnabled: undefined,
    probeHealth: () => Promise.resolve(true),
  };

  test.each(["DISCORD_BOT_TOKEN", "TELEGRAM_BOT_TOKEN", "GITHUB_WEBHOOK_SECRET"])(
    "legacy channel credential %s fails doctor",
    async (key) => {
      const report = await runDoctor({
        ...healthyPorts,
        effectiveEnv: new Map([...healthyPorts.effectiveEnv, [key, "legacy"]]),
      });
      expect(report.ok).toBe(false);
      expect(doctorStatuses(report).get("channel config")).toBe("fail");
    },
  );

  test("all green: ok verdict and the configured port is probed", async () => {
    let probed = 0;
    const report = await runDoctor({
      ...healthyPorts,
      probeHealth: (port) => {
        probed = port;
        return Promise.resolve(true);
      },
    });
    expect(report.ok).toBe(true);
    expect(probed).toBe(4123);
    expect(report.checks.map((check) => check.status)).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
    ]);
  });

  test("missing env file only warns; absent model config fails; silent health warns", async () => {
    const report = await runDoctor({
      bunVersion: "1.3.0",
      envFilePresent: false,
      effectiveEnv: new Map(),
      unitInstalled: false,
      daemonActive: false,
      lingerEnabled: undefined,
      probeHealth: () => Promise.resolve(false),
    });
    expect(report.ok).toBe(false);
    const byName = doctorStatuses(report);
    expect(byName.get("env file")).toBe("warn");
    expect(byName.get("model config")).toBe("fail");
    expect(byName.get("daemon")).toBe("warn");
    expect(byName.get("health")).toBe("warn");
  });

  test("exported environment alone satisfies model config without an env file", async () => {
    const report = await runDoctor({
      ...healthyPorts,
      envFilePresent: false,
      unitInstalled: false,
      daemonActive: false,
    });
    const byName = new Map(report.checks.map((check) => [check.name, check.status]));
    expect(byName.get("env file")).toBe("warn");
    expect(byName.get("model config")).toBe("pass");
  });

  test("a blank required value fails exactly like a missing one", async () => {
    const report = await runDoctor({
      ...healthyPorts,
      effectiveEnv: new Map([
        ["ONI_MODEL_PROVIDER", "anthropic"],
        ["ONI_MODEL_ID", "m"],
        ["ONI_MODEL_API_KEY", "   "],
      ]),
    });
    const byName = new Map(report.checks.map((check) => [check.name, check.status]));
    expect(byName.get("model config")).toBe("fail");
  });

  test("an installed but inactive daemon fails diagnostics", async () => {
    const report = await runDoctor({ ...healthyPorts, daemonActive: false });
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === "daemon")?.status).toBe("fail");
  });

  test("installed daemon without linger warns", async () => {
    const report = await runDoctor({ ...healthyPorts, lingerEnabled: false });
    const byName = new Map(report.checks.map((check) => [check.name, check.status]));
    expect(byName.get("linger")).toBe("warn");
    expect(report.ok).toBe(true);
  });

  test("unsupported onboarding provider is refused before credentials", async () => {
    let prompts = 0;
    await expect(
      gatherOnboarding(async () => {
        prompts += 1;
        return "unsupported";
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(prompts).toBe(1);
  });

  test("active daemon with unreachable health is a failure", async () => {
    const report = await runDoctor({
      ...healthyPorts,
      effectiveEnv: new Map([["ONI_MODEL_PROVIDER", "anthropic"]]),
      probeHealth: () => Promise.resolve(false),
    });
    expect(report.ok).toBe(false);
    const byName = doctorStatuses(report);
    expect(byName.get("model config")).toBe("fail");
    expect(byName.get("health")).toBe("fail");
  });

  test("an ephemeral port skips the probe and warns instead of failing an active daemon", async () => {
    let probes = 0;
    const report = await runDoctor({
      ...healthyPorts,
      effectiveEnv: new Map([...healthyPorts.effectiveEnv, ["ONI_WS_PORT", "0"]]),
      probeHealth: () => {
        probes += 1;
        return Promise.resolve(false);
      },
    });
    expect(report.checks.find((check) => check.name === "health")).toEqual({
      name: "health",
      status: "warn",
      detail: "ephemeral WS port (ONI_WS_PORT=0) — health probe skipped",
    });
    expect(report.ok).toBe(true);
    expect(probes).toBe(0);
  });

  test("a port the daemon would refuse to bind fails with the config parser's verdict", async () => {
    let probes = 0;
    const report = await runDoctor({
      ...healthyPorts,
      effectiveEnv: new Map([...healthyPorts.effectiveEnv, ["ONI_WS_PORT", "70000"]]),
      probeHealth: () => {
        probes += 1;
        return Promise.resolve(true);
      },
    });
    expect(() => parseWsPort("70000")).toThrow(
      expect.objectContaining({ data: { code: "invalid_ws_port", message: "ONI_WS_PORT must be an integer from 0 to 65535" } }),
    );
    expect(report.checks.find((check) => check.name === "health")).toEqual({
      name: "health",
      status: "fail",
      detail: "ONI_WS_PORT must be an integer from 0 to 65535",
    });
    expect(report.ok).toBe(false);
    expect(probes).toBe(0);
  });

  test("an unset port probes the same default the daemon binds", async () => {
    const effectiveEnv = new Map(healthyPorts.effectiveEnv);
    effectiveEnv.delete("ONI_WS_PORT");
    let probed = 0;
    const report = await runDoctor({
      ...healthyPorts,
      effectiveEnv,
      probeHealth: (port) => {
        probed = port;
        return Promise.resolve(true);
      },
    });
    expect(probed).toBe(parseWsPort(undefined));
    expect(report.ok).toBe(true);
  });
});

describe("oni messaging (#1600 lane R4)", () => {
  test("reads the catalog the env file names: no catalog is a plain refusal, a declared row is reported with its sealed credential", async () => {
    const home = tempDir();
    const deps = createCliDeps(home);
    await expect(deps.messagingFacts()).rejects.toThrow("no catalog at");
    const out: string[] = [];
    const err: string[] = [];
    const cli: CliDeps = { ...deps, stdout: (line) => out.push(line), stderr: (line) => err.push(line) };
    expect(await runCli(["messaging"], cli)).toBe(1);
    expect(err[0]).toContain("nothing is declared yet");
    const catalogPath = join(home, ".oni", "catalog.sqlite");
    mkdirSync(join(home, ".oni"), { recursive: true });
    writeFileSync(join(home, ".oni", "env"), `ONI_CATALOG_PATH=${catalogPath}\n`);
    const plane = createAppLedger({ now: testClock(), catalogPath });
    try {
      plane.stores.instances.put({
        id: "channel:telegram:main",
        provider: "telegram",
        identity: "bot",
        enabled: true,
        settings: {},
        credentialRef: "secret:telegram-main",
        grant: { defaultTier: "manager" },
        revision: 0,
        createdBy: "owner",
        updatedAt: 1,
      });
    } finally {
      plane.close();
    }
    const before = statSync(catalogPath).mtimeMs;
    const facts = await deps.messagingFacts();
    // Read-only: the daemon's catalog file is not touched by the report.
    expect(statSync(catalogPath).mtimeMs).toBe(before);
    expect(facts.instances.map((instance) => instance.id)).toEqual(["channel:telegram:main"]);
    expect(facts.persons).toEqual([]);
    // No vault row was sealed for the credential ref: the report says so and exits 1.
    expect([...facts.sealed]).toEqual([]);
    expect(await runCli(["messaging"], cli)).toBe(1);
    expect(out).toContain("  channel:telegram:main [bot] enabled, credential secret:telegram-main MISSING from the vault, tier manager");
    expect(out).toContain("  READ  every sender on telegram reaches the Resident at tier manager");
  });

  test("channel add dispatches through the command table: the verb alone is the usage, --print shows the declaration the prompts built", async () => {
    const home = tempDir();
    const out: string[] = [];
    const err: string[] = [];
    const cli: CliDeps = { ...createCliDeps(home), stdout: (line) => out.push(line), stderr: (line) => err.push(line), ask: () => Promise.resolve("tg-token") };
    expect(await runCli(["channel"], cli)).toBe(1);
    expect(err).toEqual(["usage: oni channel add <platform> [flags] | oni channel history <instance-id> <chat-id> [--before <cursor>] [--limit <1..100>]"]);
    expect(await runCli(["channel", "add", "telegram", "--tier", "manager", "--print"], cli)).toBe(0);
    expect(out).toEqual([JSON.stringify({ id: "channel:telegram:main", provider: "telegram", identity: "bot", grant: { defaultTier: "manager" }, credential: { token: "tg-token" } })]);
    expect(await runCli(["channel", "add"], cli)).toBe(1);
    expect(err.at(-1)).toContain("usage: oni channel add");
    // Through the dispatch, the login deps' socket is the one that declares; no daemon is reported as such.
    expect(await runCli(["channel", "add", "telegram"], { ...cli, login: { ...cli.login, declare: () => Promise.reject(new CliError("no daemon at ws://127.0.0.1:3000/ws")) } })).toBe(1);
    expect(err.slice(-2)).toEqual(["no daemon at ws://127.0.0.1:3000/ws", "nothing was sealed; start the daemon and run channel add again"]);
  });
});

describe("cli entry point", () => {
  test("returns the dispatch exit status without terminating an importer", async () => {
    const stdout = spyOn(console, "log").mockImplementation(() => undefined);
    const stderr = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await main(["not-a-command"])).toBe(1);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});

describe("cli dispatch", () => {
  function deps(overrides: Partial<CliDeps> = {}): {
    readonly deps: CliDeps;
    readonly out: string[];
    readonly err: string[];
  } {
    const out: string[] = [];
    const err: string[] = [];
    const io = fakeIo(() => ok);
    return {
      out,
      err,
      deps: {
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
        target: darwinTarget,
        io,
        envPath: "/Users/owner/.oni/env",
        startApp: () => Promise.resolve(),
        attachMachine: async () => 0,
        ask: () => Promise.resolve(""),
        writeEnv: () => undefined,
        login: {
          logins: {
            slack: () => Promise.reject(new Error("no slack login in this test")),
            discord: () => Promise.reject(new Error("no discord login in this test")),
            instagram: () => Promise.reject(new Error("no instagram login in this test")),
            kakaotalk: () => Promise.reject(new Error("no kakaotalk login in this test")),
            telegram: () => Promise.reject(new Error("no telegram login in this test")),
          },
          declare: () => Promise.reject(new Error("no daemon in this test")),
          id: () => "request-1",
        },
        messagingFacts: () => Promise.reject(new Error("no catalog in this test")),
        supervise: async () => 7,
        deploy: {
          supervisorReachable: () => false,
          stage: () => Promise.reject(new Error("no staging in this test")),
          token: () => undefined,
          send: () => Promise.reject(new Error("no supervisor in this test")),
          stdout: (line) => out.push(line),
          stderr: (line) => err.push(line),
        },
        channelHistory: {
          id: () => "request-1",
          read: () => Promise.reject(new Error("no history in this test")),
        },
        doctorPorts: () =>
          Promise.resolve({
            bunVersion: "1.3.0",
            envFilePresent: false,
            effectiveEnv: new Map<string, string>(),
            unitInstalled: false,
            daemonActive: false,
            lingerEnabled: undefined,
            probeHealth: () => Promise.resolve(false),
          }),
        follow: () => Promise.resolve(0),
        ...overrides,
      },
    };
  }

  test("machine attach validates arity and forwards the config without starting the Resident", async () => {
    const seen: string[] = [];
    const { deps: cli } = deps({
      attachMachine: async (path) => {
        seen.push(path);
        return 7;
      },
    });
    expect(await runCli(["machine"], cli)).toBe(1);
    expect(await runCli(["machine", "attach"], cli)).toBe(1);
    expect(await runCli(["machine", "attach", "config.json", "extra"], cli)).toBe(1);
    expect(await runCli(["machine", "attach", "config.json"], cli)).toBe(7);
    expect(seen).toEqual(["config.json"]);
  });

  test("login dispatches to the sign-in with the login deps; --print declares nothing", async () => {
    const { deps: cli, out, err } = deps();
    const discord = {
      ...cli.login,
      logins: {
        ...cli.login.logins,
        discord: async ({ showQr }: { showQr: (url: string) => void }) => {
          showQr("https://discord.com/ra/qr");
          return { token: "user-token" };
        },
      },
    };
    expect(await runCli(["login", "discord", "--print"], { ...cli, login: discord })).toBe(0);
    expect(out).toEqual([
      "Open Discord on your phone and scan: https://discord.com/ra/qr",
      "Signed in to Discord",
      JSON.stringify({ provider: "discord", identity: "owner", credential: { token: "user-token" } }),
    ]);
    expect(await runCli(["login", "telegram"], cli)).toBe(1);
    expect(err.at(-1)).toBe("Telegram login is not configured");
  });

  test("supervise, --version and deploy dispatch; a missing supervisor answers supervisor_unavailable without staging", async () => {
    const { deps: cli, out, err } = deps();
    expect(await runCli(["supervise"], cli)).toBe(7);
    expect(await runCli(["--version"], cli)).toBe(0);
    expect(out).toEqual([ONI_VERSION]);
    expect(await runCli(["deploy", "oni.tgz"], cli)).toBe(1);
    expect(err).toEqual([JSON.stringify({ ok: false, class: "supervisor_unavailable", step: "request" })]);
  });

  test("unknown command prints usage and exits 1", async () => {
    const { deps: cli, err } = deps();
    expect(await runCli(["bogus"], cli)).toBe(1);
    expect(err[0]).toBe("unknown command: bogus");
    expect(err[1]).toContain("Usage:");
  });

  test("bare invocation shows usage with exit 0", async () => {
    const { deps: cli, out } = deps();
    expect(await runCli([], cli)).toBe(0);
    expect(out[0]).toContain("oni daemon <verb>");
  });

  test("daemon requires a known verb", async () => {
    const { deps: cli, err } = deps();
    expect(await runCli(["daemon", "explode"], cli)).toBe(1);
    expect(err[0]).toContain("usage: oni daemon");
  });

  test("a successful daemon verb prints the handler's message with exit 0", async () => {
    const { deps: cli, out, err } = deps();
    expect(await runCli(["daemon", "status"], cli)).toBe(0);
    expect(out).toEqual(["not installed"]);
    expect(err).toEqual([]);
  });

  test("daemon verb errors become stderr + exit 1, not a crash", async () => {
    const { deps: cli, err } = deps();
    expect(await runCli(["daemon", "start"], cli)).toBe(1);
    expect(err[0]).toContain("not installed");
  });

  test("dispatches start and both platform log followers", async () => {
    let started = 0;
    const followed: string[][] = [];
    const { deps: darwin } = deps({
      startApp: () => {
        started += 1;
        return Promise.resolve();
      },
      follow: (argv) => {
        followed.push([...argv]);
        return Promise.resolve(7);
      },
    });
    expect(await runCli(["start"], darwin)).toBe(0);
    expect(await runCli(["logs"], darwin)).toBe(7);

    const { deps: linux } = deps({
      target: linuxTarget,
      follow: (argv) => {
        followed.push([...argv]);
        return Promise.resolve(8);
      },
    });
    expect(await runCli(["logs"], linux)).toBe(8);
    expect(started).toBe(1);
    expect(followed).toEqual([
      ["tail", "-n", "50", "-F", "/Users/owner/.oni/logs/oni.log"],
      ["journalctl", "--user", "-u", "oni", "-f"],
    ]);
  });

  test("onboard writes collected answers and confirms an overwrite", async () => {
    const writes: Parameters<CliDeps["writeEnv"]>[0][] = [];
    const answers = ["y", "", "model", "key", "", "", "", ""];
    const { deps: cli } = deps({
      ask: () => Promise.resolve(answers.shift() ?? ""),
      writeEnv: (entries) => writes.push(entries),
    });
    cli.io.writeFile(cli.envPath, "existing");

    expect(await runCli(["onboard"], cli)).toBe(0);
    expect(writes).toHaveLength(1);
  });

  test("onboard declines to overwrite an existing env file without consent", async () => {
    const writes: Parameters<CliDeps["writeEnv"]>[0][] = [];
    const { deps: cli, out } = deps({
      writeEnv: (entries) => writes.push(entries),
      ask: () => Promise.resolve("n"),
    });
    cli.io.writeFile(cli.envPath, "ONI_MODEL_ID=x\n");
    expect(await runCli(["onboard"], cli)).toBe(0);
    expect(writes).toEqual([]);
    expect(out[0]).toBe("keeping the existing env file");
  });

  test("doctor exit code follows the report verdict", async () => {
    const { deps: cli } = deps();
    expect(await runCli(["doctor"], cli)).toBe(1);
  });
});

describe("processEntryPath", () => {
  test("probes the JavaScript sibling, then the source entry", () => {
    const dir = tempDir();
    const base = pathToFileURL(join(dir, "main.js")).href;
    const bundled = join(dir, "process-entry.js");
    writeFileSync(bundled, "");
    expect(processEntryPath(base)).toBe(bundled);
    rmSync(bundled);
    expect(processEntryPath(base)).toBe(join(dir, "process-entry.ts"));
  });
});
