import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createMachineHost } from "../../../machines/test/helpers/native";
import { attachMclient, mclientBinary, mclientEnrollment } from "../../../machines/test/helpers/mclient";
import { eventCollector } from "../../../machines/test/helpers/events";
import { createCodemode } from "./helpers/native";

/**
 * #1275 browser recipe: Chromium runs persistently inside a cell-owned tmux
 * `pty.session`; cells reach it through the `browser(machineId)` prelude helper
 * over CDP. Everything here runs against a real tmux server on a private
 * socket and a real Chromium, so readiness and loss are decided by actual
 * terminal output, never by elapsed time.
 */
const CELL_TIMEOUT_MS = 120_000;
const events = eventCollector();

const sessionOf = (profile: string) =>
  `oni-browser-${createHash("sha256").update(profile).digest("hex").slice(0, 12)}`;

/** Loud prerequisite probe: these tests must fail, not silently pass, without Chromium. */
function chromiumExecutable(): string {
  const probe = Bun.spawnSync([
    "python3",
    "-c",
    "from playwright.sync_api import sync_playwright\np = sync_playwright().start()\nprint(p.chromium.executable_path)\np.stop()",
  ]);
  const path = probe.stdout.toString("utf8").trim();
  if (probe.exitCode !== 0 || !existsSync(path)) {
    throw new Error(
      `browser recipe tests need playwright + Chromium on this host (python -m playwright install chromium): ${probe.stderr.toString("utf8").trim()}`,
    );
  }
  return path;
}

const base = mkdtempSync(join(tmpdir(), "oc-browser-"));
const outside = mkdtempSync(join(tmpdir(), "oc-browser-outside-"));
const profiles = {
  shared: join(base, "shared"),
  headed: join(base, "headed"),
  noDisplay: join(base, "no-display"),
  lost: join(base, "lost"),
  closing: join(base, "closing"),
};
const socketPath = join(tmpdir(), `oc-${crypto.randomUUID()}.sock`);
let mode: ReturnType<typeof createCodemode> | undefined;
let host: Awaited<ReturnType<typeof createMachineHost>> | undefined;
let daemon: Awaited<ReturnType<typeof attachMclient>> | undefined;

/** Narrowed access for tests; a failed beforeAll keeps its own error singular. */
function harness() {
  if (!mode || !host || !daemon) throw new Error("browser harness unavailable: the beforeAll prerequisite failed");
  return { mode, host, daemon };
}

let executable = "";

beforeAll(async () => {
  await mclientBinary();
  executable = chromiumExecutable();
  for (const dir of Object.values(profiles)) mkdirSync(dir);
  host = await createMachineHost({
    listen: { unix: socketPath },
    enrollment: (id) => mclientEnrollment(id),
    events: events.sink,
    now: () => Date.now(),
    callTool: (call) => harness().mode.callTool(call),
  });
  mode = createCodemode({ machines: host, self: "M" });
  daemon = await attachMclient({ host, events, machineId: "M", root: base });
}, 300_000);

afterAll(async () => {
  // When beforeAll failed its prerequisite probe, nothing below was created;
  // optional access keeps that single clear error as the only failure.
  await mode?.close();
  await daemon?.stop();
  await host?.close();
  rmSync(base, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

type Harness = ReturnType<typeof harness>;
function raisedError(result: Awaited<ReturnType<Harness["mode"]["cell"]["run"]>>): string {
  expect(result.status).toBe("raised");
  return result.status === "raised" ? result.error : "";
}

async function listedSessions(): Promise<readonly string[]> {
  const listed = await harness().host.get("M").pty.list();
  expect(listed.status).toBe("ok");
  return listed.status === "ok" ? listed.sessions.map((entry) => entry.name) : [];
}

test(
  "launches Chromium in a pty.session, connects over CDP, and advances past an occupied default port",
  async () => {
    const { mode, host } = harness();
    // Occupying 9222 forces the documented probe-and-advance behavior; if some
    // other process already holds it the launch must advance just the same.
    let occupied: { stop(closeActiveConnections?: boolean): void } | undefined;
    try {
      occupied = Bun.listen({ hostname: "127.0.0.1", port: 9222, socket: {
          data() {
            // The occupier only needs to hold the port; input is irrelevant.
          },
        } });
    } catch {
      occupied = undefined;
    }
    try {
      const result = await mode.cell.run(
        [
          `client = browser("M", profile_dir=${JSON.stringify(profiles.shared)}, executable_path=${JSON.stringify(executable)})`,
          "page = client.context.new_page()",
          'page.goto("data:text/html,<title>oni fixture</title>")',
          "(page.title(), client.port, client.session)",
        ].join("\n"),
        "browser",
        { timeoutMs: CELL_TIMEOUT_MS },
      );
      expect(result.status).toBe("completed");
      if (result.status !== "completed") return;
      expect(result.value).toContain("'oni fixture'");
      const port = Number(/, (\d+), /.exec(result.value ?? "")?.[1]);
      expect(port).toBeGreaterThan(9222);
      // The selected port is printed into and retained by the session output.
      const view = await host.get("M").pty.read(sessionOf(profiles.shared), {});
      expect(view.status).toBe("ok");
      if (view.status !== "ok") return;
      const transcript = Buffer.from(view.data).toString("utf8");
      expect(transcript).toContain(`[oni-browser] cdp-port ${port}`);
      expect(transcript).toContain("DevTools listening on ws://");
    } finally {
      occupied?.stop(true);
    }
  },
  CELL_TIMEOUT_MS,
);
test(
  "reuses the live client for the same machine and profile instead of launching twice",
  async () => {
    const { mode } = harness();
    const result = await mode.cell.run(
      `browser("M", profile_dir=${JSON.stringify(profiles.shared)}, executable_path=${JSON.stringify(executable)}) is client`,
      "browser",
      { timeoutMs: CELL_TIMEOUT_MS },
    );
    expect(result).toMatchObject({ status: "completed", value: "True" });
    expect(await listedSessions()).toEqual([sessionOf(profiles.shared)]);
  },
  CELL_TIMEOUT_MS,
);

test(
  "a Chromium killed behind the client's back surfaces browser_lost with the terminal transcript",
  async () => {
    const { mode, host } = harness();
    // Stop Chromium behind the client's back via the pid retained in the
    // session output (this build ignores CDP Browser.close and hangup signals).
    const view = await host.get("M").pty.read(sessionOf(profiles.shared), {});
    expect(view.status).toBe("ok");
    const transcript = view.status === "ok" ? Buffer.from(view.data).toString("utf8") : "";
    const pid = Number(/\[oni-browser\] chromium-pid (\d+)/.exec(transcript)?.[1]);
    expect(pid).toBeGreaterThan(0);
    process.kill(pid, "SIGKILL");
    // Loss detection is a liveness round trip inside every client accessor, so
    // the very next operation surfaces the typed refusal deterministically.
    const error = raisedError(await mode.cell.run("client.pages", "browser", { timeoutMs: CELL_TIMEOUT_MS }));
    expect(error).toContain("browser_lost");
    expect(error).toContain("--- tmux session output ---");
    expect(error).toContain("[oni-browser] cdp-port");
  },
  CELL_TIMEOUT_MS,
);

test.if(process.platform === "darwin" || Boolean(process.env.DISPLAY))(
  "headless=False launches a headed Chromium and close() ends its session",
  async () => {
    const { mode } = harness();
    const result = await mode.cell.run(
      [
        `headed = browser("M", headless=False, profile_dir=${JSON.stringify(profiles.headed)}, executable_path=${JSON.stringify(executable)})`,
        "connected = headed.is_connected()",
        "headed.close()",
        "connected",
      ].join("\n"),
      "browser",
      { timeoutMs: CELL_TIMEOUT_MS },
    );
    expect(result).toMatchObject({ status: "completed", value: "True" });
    expect(await listedSessions()).not.toContain(sessionOf(profiles.headed));
  },
  CELL_TIMEOUT_MS,
);

test(
  "a profile_dir outside every export refuses with path_escapes_export before Chromium starts",
  async () => {
    const { mode } = harness();
    const error = raisedError(
      await mode.cell.run(`browser("M", profile_dir=${JSON.stringify(join(outside, "profile"))})`, "browser", {
        timeoutMs: CELL_TIMEOUT_MS,
      }),
    );
    expect(error).toContain("path_escapes_export");
    expect(await listedSessions()).not.toContain(sessionOf(join(outside, "profile")));
  },
  CELL_TIMEOUT_MS,
);

test(
  "a missing Chromium executable refuses typed and tears the owned session down (4b)",
  async () => {
    const { mode } = harness();
    const error = raisedError(
      await mode.cell.run(
        [
          "try:",
          `    browser("M", profile_dir=${JSON.stringify(profiles.closing)}, executable_path="/nonexistent/chromium")`,
          "except BrowserLost as lost:",
          "    raise lost",
        ].join("\n"),
        "browser",
        { timeoutMs: CELL_TIMEOUT_MS },
      ),
    );
    expect(error).toContain("browser_lost");
    expect(error).toContain("/nonexistent/chromium");
    expect(error).toContain("python -m playwright install chromium");
    expect(await listedSessions()).not.toContain(sessionOf(profiles.closing));
  },
  CELL_TIMEOUT_MS,
);

test.if(process.platform === "linux")(
  "a headed launch without a usable display refuses typed before readiness and tears the session down",
  async () => {
    const { mode } = harness();
    // The wrapper clears the display variables inside the pty.session, so the
    // headed launch exercises the no-display branch regardless of the runner.
    const wrapper = join(base, "no-display-chromium.sh");
    writeFileSync(wrapper, `#!/bin/sh\nunset DISPLAY WAYLAND_DISPLAY\nexec '${executable}' "$@"\n`, { mode: 0o755 });
    const error = raisedError(
      await mode.cell.run(
        `browser("M", headless=False, profile_dir=${JSON.stringify(profiles.noDisplay)}, executable_path=${JSON.stringify(wrapper)})`,
        "browser",
        { timeoutMs: CELL_TIMEOUT_MS },
      ),
    );
    expect(error).toContain("browser_lost");
    expect(error).toContain("before the DevTools readiness line");
    expect(await listedSessions()).not.toContain(sessionOf(profiles.noDisplay));
  },
  CELL_TIMEOUT_MS,
);

test(
  "a lost browser session is launched afresh instead of reconnected",
  async () => {
    const { mode, host } = harness();
    const session = sessionOf(profiles.lost);
    expect(await host.get("M").pty.open(session, profiles.lost)).toMatchObject({ status: "ok" });
    expect(Bun.spawnSync(["tmux", "kill-session", "-t", `=${session}`]).exitCode).toBe(0);
    const listed = await host.get("M").pty.list();
    expect(listed.status).toBe("ok");
    expect(listed.status === "ok" ? listed.sessions : []).toContainEqual({ name: session, status: "lost" });
    const relaunched = await mode.cell.run(
      [
        `again = browser("M", profile_dir=${JSON.stringify(profiles.lost)}, executable_path=${JSON.stringify(executable)})`,
        "connected = again.is_connected()",
        "again.close()",
        "connected",
      ].join("\n"),
      "browser",
      { timeoutMs: CELL_TIMEOUT_MS },
    );
    expect(relaunched).toMatchObject({ status: "completed", value: "True" });
    expect(await listedSessions()).not.toContain(session);
  },
  CELL_TIMEOUT_MS,
);
