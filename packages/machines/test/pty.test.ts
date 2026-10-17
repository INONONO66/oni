import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { Machine } from "@openomni/protocol";
import { systemCommandRunner } from "../src/commands";
import { MachinesFailure } from "../src/errors";
import { createPtyAdapter, type PtyAdapter } from "../src/pty";
import { startPtyControl, type PtyControl, type PtyControlFactory } from "../src/pty-control";
import { scriptedTmux } from "./helpers/scripted-tmux";
import { run } from "./ipc/helpers/effects";

/**
 * Real-tmux adapter tests (#1273) on a private `-L` socket so the Owner's own
 * tmux server is never touched. The server started here is killed in afterAll.
 */
const SOCKET = `openomni-test-${process.pid}`;
const CONTROL_SESSION = "omo-pty-control";

const tmuxCli = (...args: string[]) => Bun.spawnSync(["tmux", "-L", SOCKET, ...args], { stderr: "pipe" });

afterAll(() => {
  tmuxCli("kill-server");
});

async function openAdapter(generation: string): Promise<PtyAdapter> {
  const adapter = createPtyAdapter({ id: () => generation, runner: systemCommandRunner(), socketName: SOCKET });
  expect(await run(adapter.offeredCapabilities([Machine.WellKnownCapability.ptySession]))).toEqual([
    Machine.WellKnownCapability.ptySession,
  ]);
  return adapter;
}

function okOpen(result: Machine.PtyOpenResult): Extract<Machine.PtyOpenResult, { status: "ok" }> {
  if (result.status !== "ok") throw new Error(`open refused: ${result.reason}`);
  return result;
}

function okRead(result: Machine.PtyReadResult): Extract<Machine.PtyReadResult, { status: "ok" }> {
  if (result.status !== "ok") throw new Error(`read refused: ${result.reason}`);
  return result;
}

async function writeText(adapter: PtyAdapter, name: string, text: string): Promise<void> {
  const written = await run(adapter.write({ name, data: Buffer.from(text, "utf8").toString("base64") }));
  expect(written).toEqual({ status: "ok" });
}

/**
 * Event-driven drain: every round blocks on the adapter's long-poll, no
 * sleeps, until the marker lands or the deadline passes. A round-count bound
 * would depend on how many bytes each wake carries, which a loaded runner
 * decides.
 */
async function readUntil(adapter: PtyAdapter, name: string, cursor: string, marker: string, deadlineMs = 20_000) {
  let seen = "";
  let at = cursor;
  const deadline = Date.now() + deadlineMs;
  while (!seen.includes(marker) && Date.now() < deadline) {
    const view = okRead(await run(adapter.read({ name, cursor: at, waitMs: 2000 })));
    seen += Buffer.from(view.data, "base64").toString("utf8");
    at = view.cursor;
  }
  expect(seen).toContain(marker);
  return { seen, cursor: at };
}

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe("pty.session over real tmux", () => {
  test("open creates one detached named session, same-name open reattaches, close kills only that session", async () => {
    const adapter = await openAdapter("gen-lifecycle");
    okOpen(await run(adapter.open({ name: "alpha", cwd: "/" })));
    expect(tmuxCli("has-session", "-t", "=alpha").exitCode).toBe(0);
    // Detached: no client is attached to the named session itself.
    expect(tmuxCli("list-clients", "-t", "=alpha").stdout.toString()).toBe("");
    okOpen(await run(adapter.open({ name: "alpha", cwd: "/" })));
    const named = tmuxCli("list-sessions", "-F", "#{session_name}").stdout.toString().split("\n");
    expect(named.filter((name) => name === "alpha")).toHaveLength(1);
    okOpen(await run(adapter.open({ name: "omega", cwd: "/" })));
    const listed = await run(adapter.list({}));
    if (listed.status !== "ok") throw new Error(`list refused: ${listed.reason}`);
    expect(listed.sessions).toEqual([
      { name: "alpha", status: "live" },
      { name: "omega", status: "live" },
    ]);
    expect(listed.truncated).toBe(false);
    // The reserved control session is never a user terminal.
    expect(await run(adapter.open({ name: CONTROL_SESSION, cwd: "/" }))).toEqual({
      status: "refused",
      reason: "pty_not_available",
    });
    expect(await run(adapter.close({ name: "omega" }))).toEqual({ status: "ok" });
    expect(tmuxCli("has-session", "-t", "=omega").exitCode).not.toBe(0);
    expect(tmuxCli("has-session", "-t", "=alpha").exitCode).toBe(0);
    expect(await run(adapter.read({ name: "omega" }))).toEqual({ status: "refused", reason: "pty_not_found" });
    await run(adapter.close({ name: "alpha" }));
    await run(adapter.shutdown());
  }, 30_000);

  test("replay and live output share one cursor with no duplicate bytes across a daemon restart", async () => {
    const first = await openAdapter("gen-one");
    const opened = okOpen(await run(first.open({ name: "beta", cwd: "/" })));
    await writeText(first, "beta", "printf 'pre-%s\\n' marker\r");
    const before = await readUntil(first, "beta", opened.cursor, "pre-marker");
    // Live decode delivered the printf result exactly once (the typed command
    // line echoes as `printf 'pre-%s\n' marker`, which never matches).
    expect(count(before.seen, "pre-marker")).toBe(1);
    // Daemon dies, tmux server lives: only the control client goes away.
    await run(first.shutdown());
    expect(tmuxCli("has-session", "-t", "=beta").exitCode).toBe(0);

    const second = await openAdapter("gen-two");
    const reopened = okOpen(await run(second.open({ name: "beta", cwd: "/" })));
    // Scrollback replay: a fresh cursor replays retained history exactly once.
    const replayed = okRead(await run(second.read({ name: "beta", cursor: reopened.cursor })));
    const replay = Buffer.from(replayed.data, "base64").toString("utf8");
    expect(count(replay, "pre-marker")).toBe(1);
    // A cursor minted by the previous daemon generation resumes AFTER the
    // snapshot: the next read returns exactly the subsequent output.
    await writeText(second, "beta", "printf 'post-%s\\n' marker\r");
    const after = await readUntil(second, "beta", before.cursor, "post-marker");
    expect(after.seen).not.toContain("pre-marker");
    expect(count(after.seen, "post-marker")).toBe(1);
    await run(second.close({ name: "beta" }));
    await run(second.shutdown());
  }, 30_000);

  test("resize changes the dimensions the shell observes", async () => {
    const adapter = await openAdapter("gen-resize");
    const opened = okOpen(await run(adapter.open({ name: "gamma", cwd: "/" })));
    await writeText(adapter, "gamma", "stty size\r");
    const initial = await readUntil(adapter, "gamma", opened.cursor, "24 80");
    expect(await run(adapter.resize({ name: "gamma", cols: 120, rows: 40 }))).toEqual({ status: "ok" });
    await writeText(adapter, "gamma", "stty size\r");
    await readUntil(adapter, "gamma", initial.cursor, "40 120");
    await run(adapter.close({ name: "gamma" }));
    await run(adapter.shutdown());
  }, 30_000);

  test("over-cap output returns the bounded suffix, truncated:true, and a cursor past all observed bytes", async () => {
    const adapter = await openAdapter("gen-cap");
    const opened = okOpen(await run(adapter.open({ name: "flood", cwd: "/" })));
    await writeText(adapter, "flood", "yes | head -c 300000; printf 'FLOOD-%s\\n' done\r");
    // A fast producer wakes each long-poll with one arrival's worth of bytes;
    // draining 300000+ bytes therefore takes many immediate rounds.
    await readUntil(adapter, "flood", opened.cursor, "FLOOD-done");
    // One read over the whole retained stream crosses the response cap.
    const capped = okRead(await run(adapter.read({ name: "flood" })));
    expect(capped.truncated).toBe(true);
    expect(Buffer.from(capped.data, "base64").length).toBe(Machine.PTY_READ_MAX_BYTES);
    // The cursor advanced past everything observed: nothing loops back.
    const drained = okRead(await run(adapter.read({ name: "flood", cursor: capped.cursor })));
    expect(drained.data).toBe("");
    expect(drained.truncated).toBe(false);
    await run(adapter.close({ name: "flood" }));
    await run(adapter.shutdown());
  }, 40_000);

  test("tmux server death marks sessions lost, fails operations deterministically, and withdraws the capability until the next attach probe", async () => {
    const adapter = await openAdapter("gen-loss");
    const opened = okOpen(await run(adapter.open({ name: "delta", cwd: "/" })));
    // A read that outlives the server settles as a typed refusal, never hangs.
    const pending = run(adapter.read({ name: "delta", cursor: opened.cursor, waitMs: 10_000 }));
    expect(tmuxCli("kill-server").exitCode).toBe(0);
    expect(await pending).toEqual({ status: "refused", reason: "pty_not_available" });
    expect(await run(adapter.list({}))).toEqual({ status: "refused", reason: "pty_not_available" });
    expect(await run(adapter.open({ name: "delta", cwd: "/" }))).toEqual({
      status: "refused",
      reason: "pty_not_available",
    });
    expect(await run(adapter.write({ name: "delta", data: "" }))).toEqual({
      status: "refused",
      reason: "pty_not_available",
    });
    // The next attach probes PATH again and restores the offer; sessions from
    // the dead server are gone, not silently recreated.
    expect(await run(adapter.offeredCapabilities([Machine.WellKnownCapability.ptySession]))).toEqual([
      Machine.WellKnownCapability.ptySession,
    ]);
    expect(await run(adapter.read({ name: "delta" }))).toEqual({ status: "refused", reason: "pty_not_found" });
    await run(adapter.shutdown());
  }, 30_000);

  test("a reattach paint pass never re-delivers bytes the cursor already returned", async () => {
    const adapter = await openAdapter("gen-paint");
    const opened = okOpen(await run(adapter.open({ name: "paint", cwd: "/" })));
    await writeText(adapter, "paint", "printf 'WAKE-%d\\n' 7342\r");
    const first = await readUntil(adapter, "paint", opened.cursor, "WAKE-7342");
    expect(count(first.seen, "WAKE-7342")).toBe(1);
    // Same-name open is the paint-pass moment: the marker is still visible on
    // the screen, and the reattach must not re-capture it into the cursor
    // stream (PR #1283 CI finding 4: screen repaints re-deliver visible lines;
    // the cursor contract is each retained byte at most once).
    okOpen(await run(adapter.open({ name: "paint", cwd: "/" })));
    const after = okRead(await run(adapter.read({ name: "paint", cursor: first.cursor })));
    expect(Buffer.from(after.data, "base64").toString("utf8")).not.toContain("WAKE-7342");
    await run(adapter.close({ name: "paint" }));
    await run(adapter.shutdown());
  }, 30_000);

  test("a session killed behind the adapter's back fails the next command visibly (%error reply)", async () => {
    const adapter = await openAdapter("gen-error-reply");
    okOpen(await run(adapter.open({ name: "ghost", cwd: "/" })));
    // Another tmux client removes the session; the registry still holds it.
    expect(tmuxCli("kill-session", "-t", "=ghost").exitCode).toBe(0);
    await expect(run(adapter.resize({ name: "ghost", cols: 100, rows: 30 }))).rejects.toMatchObject({
      _tag: "MachinesFailure",
      operation: "pty.command",
    });
    await run(adapter.shutdown());
  }, 30_000);

  test("closing a session whose tmux side already ended removes the record instead of refusing (#1275 close race)", async () => {
    const adapter = await openAdapter("gen-self-exit");
    okOpen(await run(adapter.open({ name: "selfexit", cwd: "/" })));
    // The session ends on its own (the #1275 browser launch line exits its
    // shell once Chromium stops) before close() runs; the registry still holds
    // the record, which pty_list would keep reporting as lost forever if
    // close() refused the teardown.
    expect(tmuxCli("kill-session", "-t", "=selfexit").exitCode).toBe(0);
    expect(await run(adapter.close({ name: "selfexit" }))).toEqual({ status: "ok" });
    const listed = await run(adapter.list({}));
    if (listed.status !== "ok") throw new Error(`list refused: ${listed.reason}`);
    expect(listed.sessions.map((entry) => entry.name)).not.toContain("selfexit");
    await run(adapter.shutdown());
  }, 30_000);

  test("a kill-window failure with the window still alive surfaces the failure and keeps the record (#1293 r1 fail-closed)", async () => {
    // Real tmux server and a real linked window; only the kill-window command
    // is faulted (the transport-loss / command-timeout shape). The window
    // genuinely survives on the server, so the production recheck against
    // list-windows must propagate the failure instead of reporting ok.
    let failKillWindow = false;
    const faultyControl: PtyControlFactory = (opts) =>
      Effect.map(startPtyControl(opts), (ctl): PtyControl => ({
        ...ctl,
        command: (line) =>
          failKillWindow && line.startsWith("kill-window ")
            ? Effect.fail(new MachinesFailure({ operation: "pty.command", cause: "injected transport loss during kill-window" }))
            : ctl.command(line),
      }));
    const adapter = createPtyAdapter({
      id: () => "gen-killwin-fail",
      runner: systemCommandRunner(),
      socketName: SOCKET,
      control: faultyControl,
    });
    expect(await run(adapter.offeredCapabilities([Machine.WellKnownCapability.ptySession]))).toEqual([
      Machine.WellKnownCapability.ptySession,
    ]);
    okOpen(await run(adapter.open({ name: "killwin", cwd: "/" })));
    // A linked window is listed once per session holding it, so compare the
    // unique id set: kill-session legitimately drops the dead session's entry.
    const windowIds = () =>
      new Set(tmuxCli("list-windows", "-a", "-F", "#{window_id}").stdout.toString().trim().split("\n").filter(Boolean));
    const before = windowIds();
    failKillWindow = true;
    // kill-session succeeds (the named session dies), kill-window fails while
    // the linked window survives in the control session: close must fail.
    await expect(run(adapter.close({ name: "killwin" }))).rejects.toMatchObject({
      _tag: "MachinesFailure",
      operation: "pty.command",
    });
    // Fail-closed: the window is really still alive and the record is kept,
    // so the teardown stays retryable instead of being reported done.
    expect(windowIds()).toEqual(before);
    const listed = await run(adapter.list({}));
    if (listed.status !== "ok") throw new Error(`list refused: ${listed.reason}`);
    expect(listed.sessions.map((entry) => entry.name)).toContain("killwin");
    failKillWindow = false;
    expect(await run(adapter.close({ name: "killwin" }))).toEqual({ status: "ok" });
    expect(windowIds().size).toBe(before.size - 1);
    await run(adapter.shutdown());
  }, 30_000);

  test("a session created outside the adapter resolves by name on first use", async () => {
    const adapter = await openAdapter("gen-outside");
    // Start the control client first so discovery has already run.
    okOpen(await run(adapter.open({ name: "anchor", cwd: "/" })));
    expect(tmuxCli("new-session", "-d", "-s", "outsider", "-x", "80", "-y", "24").exitCode).toBe(0);
    // Not in the registry, but on the server: resolve registers it by name.
    const read = okRead(await run(adapter.read({ name: "outsider" })));
    expect(read.truncated).toBe(false);
    expect(await run(adapter.close({ name: "outsider" }))).toEqual({ status: "ok" });
    await run(adapter.close({ name: "anchor" }));
    await run(adapter.shutdown());
  }, 30_000);

  test("a foreign session named outside the protocol grammar stays invisible and typed (#1273 r1 F1)", async () => {
    const adapter = await openAdapter("gen-grammar");
    okOpen(await run(adapter.open({ name: "conforming", cwd: "/" })));
    // A user names a session the protocol grammar forbids (uppercase).
    expect(tmuxCli("new-session", "-d", "-s", "UPPER-Case", "-x", "80", "-y", "24").exitCode).toBe(0);
    const listed = await run(adapter.list({}));
    if (listed.status !== "ok") throw new Error(`list refused: ${listed.reason}`);
    // The host-side wire decode must survive: the result parses as-is.
    expect(Machine.PtyListResult.parse(listed).status).toBe("ok");
    expect(listed.sessions.map((session) => session.name)).toEqual(["conforming"]);
    // Addressing the non-conforming name is a typed refusal, never a decode
    // failure and never a collision with the user's session.
    expect(await run(adapter.open({ name: "UPPER-Case", cwd: "/" }))).toEqual({ status: "refused", reason: "pty_not_found" });
    expect(await run(adapter.read({ name: "UPPER-Case" }))).toEqual({ status: "refused", reason: "pty_not_found" });
    // The user's session was neither registered, linked, nor killed.
    expect(tmuxCli("has-session", "-t", "=UPPER-Case").exitCode).toBe(0);
    expect(tmuxCli("kill-session", "-t", "=UPPER-Case").exitCode).toBe(0);
    await run(adapter.close({ name: "conforming" }));
    await run(adapter.shutdown());
  }, 30_000);

  test("a missing tmux binary withholds the capability and every call refuses pty_not_available", async () => {
    const adapter = createPtyAdapter({
      id: () => "gen-missing",
      runner: systemCommandRunner(),
      tmux: "openomni-test-no-such-tmux",
      socketName: SOCKET,
    });
    expect(await run(adapter.offeredCapabilities([Machine.WellKnownCapability.ptySession, "shell.exec"]))).toEqual([
      "shell.exec",
    ]);
    expect(await run(adapter.open({ name: "nope", cwd: "/" }))).toEqual({
      status: "refused",
      reason: "pty_not_available",
    });
    await run(adapter.shutdown());
  });
});

/**
 * Scripted tmux control server for the fault and #1510 snapshot suites below
 * (`helpers/scripted-tmux.ts`): `facts` answers `display-message` (the pane
 * facts), `now` is the snapshot clock.
 */
function scripted(screen: { readonly facts: string[]; readonly now?: () => number } = { facts: [] }) {
  const { control, runner, lines, faults } = scriptedTmux(screen.facts);
  const adapter = createPtyAdapter({
    id: () => "gen-scripted",
    runner,
    control,
    ...(screen.now === undefined ? {} : { now: screen.now }),
  });
  return { adapter, faults, lines };
}

describe("pty.session control-stream faults (scripted server)", () => {

  // CI runs tmux 3.4 (ubuntu-24.04) while this Mac runs 3.7: the adapter may
  // only speak the 3.4 grammar. This pins every command line the adapter can
  // issue — no 3.5+ control-mode flow control (pause-after, refresh-client -A),
  // no client flags on attach, literal-byte writes as hex send-keys.
  test("the adapter's tmux command grammar stays within the tmux 3.4 flag set", async () => {
    const { adapter, faults, lines } = scripted();
    await run(adapter.offeredCapabilities([Machine.WellKnownCapability.ptySession]));
    const opened = okOpen(await run(adapter.open({ name: "zeta", cwd: "/tmp" })));
    okRead(await run(adapter.read({ name: "zeta", cursor: opened.cursor })));
    await run(adapter.write({ name: "zeta", data: Buffer.from("hi\n", "utf8").toString("base64") }));
    expect(await run(adapter.resize({ name: "zeta", cols: 100, rows: 30 }))).toEqual({ status: "ok" });
    expect(await run(adapter.list({}))).toEqual({
      status: "ok",
      sessions: [{ name: "zeta", status: "live" }],
      truncated: false,
    });
    expect(await run(adapter.close({ name: "zeta" }))).toEqual({ status: "ok" });
    // The control client attaches with -C (a daemon has no tty for -CC) and
    // -A so a daemon restart reattaches the reserved control session.
    expect(faults().argv).toEqual(["tmux", "-C", "new-session", "-A", "-s", "omo-pty-control"]);
    expect(lines).toEqual([
      'list-sessions -F "#{session_name}"',
      'list-sessions -F "#{session_name}"',
      'new-session -d -s zeta -c "/tmp" -x 80 -y 24',
      'list-panes -t =zeta: -F "#{window_id} #{pane_id}"',
      "link-window -s @9 -t omo-pty-control:",
      "capture-pane -p -t %9 -S - -E -",
      "send-keys -t %9 -H 68 69 0a",
      "set-option -w -t =zeta: window-size manual",
      "resize-window -t =zeta: -x 100 -y 30",
      'list-sessions -F "#{session_name}"',
      "kill-session -t =zeta",
      "kill-window -t @9",
    ]);
  });

  test("a malformed control record fails exactly the next read of the affected pane, then streaming resumes", async () => {
    const { adapter, faults } = scripted();
    await run(adapter.offeredCapabilities([Machine.WellKnownCapability.ptySession]));
    const opened = okOpen(await run(adapter.open({ name: "zeta", cwd: "/" })));
    const replay = okRead(await run(adapter.read({ name: "zeta", cursor: opened.cursor })));
    expect(Buffer.from(replay.data, "base64").toString("utf8")).toBe("snapshot\n");
    faults().onOutput("%9", Buffer.from("live-1\n"));
    const live = okRead(await run(adapter.read({ name: "zeta", cursor: replay.cursor })));
    expect(Buffer.from(live.data, "base64").toString("utf8")).toBe("live-1\n");
    faults().onMalformed("%9", "bad octal escape");
    await expect(run(adapter.read({ name: "zeta", cursor: live.cursor }))).rejects.toMatchObject({
      _tag: "MachinesFailure",
      operation: "pty.read",
      cause: "malformed tmux control output: bad octal escape",
    });
    const resumed = okRead(await run(adapter.read({ name: "zeta", cursor: live.cursor })));
    expect(resumed.data).toBe("");
    // An unattributable record cannot name a pane: every session is poisoned.
    faults().onMalformed(undefined, "unframed record");
    const poisoned = await run(Effect.result(adapter.read({ name: "zeta" })));
    expect(poisoned._tag === "Failure" && poisoned.failure instanceof MachinesFailure).toBe(true);
  });

  test("closing a session settles its blocked long-poll read as pty_not_found while the capability stays live", async () => {
    const { adapter } = scripted();
    await run(adapter.offeredCapabilities([Machine.WellKnownCapability.ptySession]));
    const opened = okOpen(await run(adapter.open({ name: "zeta", cwd: "/" })));
    const replay = okRead(await run(adapter.read({ name: "zeta", cursor: opened.cursor })));
    const blocked = run(adapter.read({ name: "zeta", cursor: replay.cursor, waitMs: 10_000 }));
    expect(await run(adapter.close({ name: "zeta" }))).toEqual({ status: "ok" });
    expect(await blocked).toEqual({ status: "refused", reason: "pty_not_found" });
  });

  test("control client exit marks every session lost until a fresh probe", async () => {
    const { adapter, faults } = scripted();
    await run(adapter.offeredCapabilities([Machine.WellKnownCapability.ptySession]));
    okOpen(await run(adapter.open({ name: "zeta", cwd: "/" })));
    faults().onExit();
    expect(await run(adapter.read({ name: "zeta" }))).toEqual({ status: "refused", reason: "pty_not_available" });
  });
});

describe("pty.read source: screen (#1510, scripted server)", () => {
  const PANE_FACTS = 'display-message -p -t %9 "#{cursor_x} #{cursor_y} #{pane_dead} #{pane_pid} #{pane_current_command}"';

  test("a screen read answers the captured rows, cursor, occupant and the injected clock in two 3.4-grammar commands", async () => {
    const facts = ["3 1 0 4242 node"];
    let ticks = 0;
    const clock = () => {
      ticks += 1;
      return 1_700_000_000_000 + ticks;
    };
    const { adapter, lines } = scripted({ facts, now: clock });
    await run(adapter.offeredCapabilities([Machine.WellKnownCapability.ptySession]));
    okOpen(await run(adapter.open({ name: "zeta", cwd: "/" })));
    expect(await run(adapter.read({ name: "zeta", source: "screen" }))).toEqual({
      status: "ok",
      rows: ["snapshot"],
      cursor: { x: 3, y: 1 },
      occupant: { pid: 4242, command: "node" },
      observedAt: 1_700_000_000_001,
    });
    expect(lines.slice(-2)).toEqual(["capture-pane -p -e -t %9", PANE_FACTS]);
    // The process name takes the rest of the line: a command with spaces survives.
    facts[0] = "0 23 0 4242 my prog";
    expect(await run(adapter.read({ name: "zeta", source: "screen" }))).toEqual({
      status: "ok",
      rows: ["snapshot"],
      cursor: { x: 0, y: 23 },
      occupant: { pid: 4242, command: "my prog" },
      observedAt: 1_700_000_000_002,
    });
    // The byte stream is untouched by the snapshot: same cursor, same replay.
    const replay = okRead(await run(adapter.read({ name: "zeta" })));
    expect(Buffer.from(replay.data, "base64").toString("utf8")).toBe("snapshot\n");
  });

  test("a dead pane or a pane without a pid is occupant: null, never a guessed process", async () => {
    const facts = ["0 0 1 4242 bash"];
    const { adapter } = scripted({ facts, now: () => 7 });
    await run(adapter.offeredCapabilities([Machine.WellKnownCapability.ptySession]));
    okOpen(await run(adapter.open({ name: "zeta", cwd: "/" })));
    const dead = await run(adapter.read({ name: "zeta", source: "screen" }));
    expect(dead).toEqual({ status: "ok", rows: ["snapshot"], cursor: { x: 0, y: 0 }, occupant: null, observedAt: 7 });
    facts[0] = "4 2 0 0 ";
    expect(await run(adapter.read({ name: "zeta", source: "screen" }))).toEqual({
      status: "ok",
      rows: ["snapshot"],
      cursor: { x: 4, y: 2 },
      occupant: null,
      observedAt: 7,
    });
  });

  test("malformed pane facts fail the read typed instead of fabricating a snapshot", async () => {
    const facts = ["garbage"];
    const { adapter } = scripted({ facts, now: () => 7 });
    await run(adapter.offeredCapabilities([Machine.WellKnownCapability.ptySession]));
    okOpen(await run(adapter.open({ name: "zeta", cwd: "/" })));
    const invalid = { _tag: "MachinesFailure", operation: "pty.screen", cause: "invalid tmux pane facts" };
    await expect(run(adapter.read({ name: "zeta", source: "screen" }))).rejects.toMatchObject(invalid);
    facts.splice(0, 1, "1 1 0 9 zsh", "1 1 0 9 zsh");
    await expect(run(adapter.read({ name: "zeta", source: "screen" }))).rejects.toMatchObject(invalid);
    facts.splice(0, 2);
    await expect(run(adapter.read({ name: "zeta", source: "screen" }))).rejects.toMatchObject(invalid);
  });

  test("without an injected clock the snapshot fails typed before any tmux command runs", async () => {
    const { adapter, lines } = scripted({ facts: ["1 1 0 9 zsh"] });
    await run(adapter.offeredCapabilities([Machine.WellKnownCapability.ptySession]));
    okOpen(await run(adapter.open({ name: "zeta", cwd: "/" })));
    const issued = lines.length;
    await expect(run(adapter.read({ name: "zeta", source: "screen" }))).rejects.toMatchObject({
      _tag: "MachinesFailure",
      operation: "pty.screen",
      cause: "daemon has no clock to stamp observedAt",
    });
    expect(lines).toHaveLength(issued);
  });

  test("screen reads share the session refusals of the byte stream", async () => {
    const { adapter } = scripted({ facts: ["1 1 0 9 zsh"], now: () => 7 });
    expect(await run(adapter.read({ name: "zeta", source: "screen" }))).toEqual({
      status: "refused",
      reason: "pty_not_available",
    });
    await run(adapter.offeredCapabilities([Machine.WellKnownCapability.ptySession]));
    expect(await run(adapter.read({ name: "zeta", source: "screen" }))).toEqual({
      status: "refused",
      reason: "pty_not_found",
    });
  });
});

describe("pty.control command-timeout FIFO cleanup (#1312)", () => {
  // A scripted control server on a fifo side channel: the TestClock drives the
  // 10s command deadline, the fifo injects a late reply while nothing is
  // pending, and the %output marker proves the decoder consumed it in order.
  test("a timed-out command surrenders its FIFO slot: the late reply is dropped and the next command gets its own reply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "om-ptyctl-"));
    const fifo = join(dir, "late.fifo");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const script = join(dir, "fake-tmux.sh");
    writeFileSync(
      script,
      [
        "#!/bin/bash",
        'printf "%%begin 0 0 0\n%%end 0 0 0\n"',
        'cat "$1" &',
        "while IFS= read -r line; do",
        '  case "$line" in',
        "    silent*) ;;",
        '    *) printf "%%begin 1 1 0\nreply:%s\n%%end 1 1 0\n" "$line" ;;',
        "  esac",
        "done",
      ].join("\n"),
      { mode: 0o755 },
    );
    try {
      await run(
        Effect.gen(function* () {
          const sawLateMarker = yield* Deferred.make<void>();
          const control = yield* startPtyControl({
            argv: ["/bin/bash", script, fifo],
            onOutput: (_paneId, data) => {
              if (data.toString("utf8").includes("LATE-MARKER")) Deferred.doneUnsafe(sawLateMarker, Exit.void);
            },
            onMalformed: () => undefined,
            onExit: () => undefined,
          });
          // The scripted server swallows this command: no reply ever arrives.
          const silent = yield* Effect.forkScoped(Effect.exit(control.command("silent one")));
          yield* Effect.yieldNow;
          yield* TestClock.adjust(10_001);
          const exit = yield* Fiber.join(silent);
          if (Exit.isSuccess(exit)) throw new Error("expected the command to time out");
          expect(Cause.pretty(exit.cause)).toContain("tmux did not answer within the command deadline");
          // The late reply arrives while nothing is pending: it settles no
          // stale entry, and the trailing %output record proves it was decoded.
          yield* Effect.sync(() =>
            writeFileSync(fifo, "%begin 9 9 0\nstale-late\n%end 9 9 0\n%output %7 LATE-MARKER\n"),
          );
          yield* Deferred.await(sawLateMarker);
          // Correlation is intact: the next command settles with its OWN body.
          expect(yield* control.command("probe")).toEqual(["reply:probe"]);
          yield* control.close();
        }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
