/**
 * #1512 `cli:` contact over the machine pty — the pure pieces and the runner
 * over a scripted machine host: address resolution through the declared row,
 * the idle/working/blocked data rule, the declaration door under Owner
 * consent, submit refusal on a blocked child, the stalled-prompt diagnostic
 * through the reconciler's door, the deadline interrupt, and pane cleanup.
 * Every observation the runner acts on is a persisted row built from the
 * dialect fixtures through the pack's own decoders; no vendor payload is
 * written by hand here.
 */
import { expect, test } from "bun:test";
import { type LeaseHandle, type MachineHandle, type MachineHost, MachineRefusalError } from "@openomni/machines";
import { Effect } from "effect";
import { executeChannelDeclare, channelDomainRevisions, CHANNEL_DECLARE_INPUT } from "../src/bundles/provision/channels";
import { provisionApproval } from "../src/bundles/provision/execution";
import { declaredChannelProfile } from "../src/channels";
import {
  cliContactRowId,
  cliSessionName,
  resolveCliContact,
  validateCliContactSettings,
} from "../src/bundles/child-activity/contact/declaration";
import { hookCommand, hookScript } from "../src/bundles/child-activity/contact/hook-script";
import { childState, stateInput } from "../src/bundles/child-activity/contact/rule";
import { createCliRunner, launchLine, type CliRunnerDeps } from "../src/bundles/child-activity/contact/runner";
import type { DialectPack } from "../src/bundles/child-activity/dialects/pack";
import type { ChildWatch } from "../src/bundles/child-activity/index";
import { type ChildRow, reconcile, stateReceipts } from "../src/bundles/child-activity/reconcile";
import { decodeSpool } from "../src/bundles/child-activity/spool";
import { decodeTranscript } from "../src/bundles/child-activity/transcript";
import { fixture, fixtures, pack, reference } from "./helpers/child-activity";
import { runEffect } from "./helpers/effect";
import { testPlane } from "./helpers/ledger";
import { provisionPort } from "./helpers/provision-port";
import { testChannelDeps, testIds } from "./helpers/test-entropy";

const SENDER = "resident-1";
const MACHINE = "m-1";
const DIALECT = "fixture-dialect";

/** The shipped pack under a fixture id with a short stall window: the runner is exercised, the vendor is not. */
const testPack: DialectPack = {
  ...pack,
  manifest: { ...pack.manifest, id: DIALECT },
  submit: (text) => ({ ...pack.submit(text), enterDelayMs: 1, stallWindowMs: 20 }),
};

/** The fixture spool line for one vendor event, by the app-owned envelope's `event`. */
function liveLine(event: string): string {
  const entry = fixtures.live.find((candidate) => JSON.parse(candidate.line).event === event);
  if (entry === undefined) throw new Error(`missing live fixture ${event}`);
  return entry.line;
}

/** Rows the reconciler would admit for these spool lines, decoded by the pack. */
function hookRows(child: string, turn: string, lines: readonly string[], known: readonly ChildRow[] = []): ChildRow[] {
  const text = `${lines.join("\n")}\n`;
  const decoded = decodeSpool({ pack: testPack, child, turn, ref: reference(text), chunk: Buffer.from(text), cursor: { lastSeq: -1 } });
  return reconcile(decoded.observations, known);
}

function transcriptRows(child: string, turn: string, phase: "terminal" | "requested", known: readonly ChildRow[] = []): ChildRow[] {
  const text = `${fixture("transcript", phase)}\n`;
  const decoded = decodeTranscript({ pack: testPack, child, turn, ref: reference(text), chunk: Buffer.from(text), observedAt: 5 });
  return reconcile(decoded.observations, known);
}

function fakeLease(machineId: string, log: string[]): LeaseHandle {
  const controller = new AbortController();
  return {
    id: `lease-${log.length}`,
    machineId,
    signal: controller.signal,
    renewWhile: (operation) => operation,
    renewPtyWhile: (operation, session) =>
      Effect.tap(operation, () => Effect.sync(() => void log.push(`${session.op}:${session.name}`))),
    release: () => {
      log.push("release");
      controller.abort();
    },
  };
}

interface Scripted {
  readonly live: Set<string>;
  readonly files: Map<string, string>;
  readonly writes: string[];
  readonly execs: string[];
  readonly lease: string[];
  /** The fake child: what happens on the machine when the pane receives these bytes. */
  onWrite?: (text: string) => void;
  /** Scripted daemon refusals. */
  listRefused?: boolean;
  openRefused?: boolean;
  /** Scripted placement outcomes by machine id; unlisted machines are placed on MACHINE only. */
  placement?: Record<string, ReturnType<MachineHost["place"]>>;
}

function scriptedHost(script: Scripted): Pick<MachineHost, "place" | "get" | "list"> {
  const unused = Effect.die(new Error("unused machine operation"));
  const handle: MachineHandle = {
    fs: {
      read: (path) => {
        const text = script.files.get(path);
        return text === undefined
          ? Effect.fail(new MachineRefusalError({ reason: "not_found", message: `not found: ${path}` }))
          : Effect.succeed({ op: "read" as const, data: Buffer.from(text), bytesRead: Buffer.byteLength(text), size: Buffer.byteLength(text), truncated: false });
      },
      write: (path, data) =>
        Effect.sync(() => {
          script.files.set(path, Buffer.from(data).toString("utf8"));
          return { op: "write" as const, bytesWritten: data.byteLength };
        }),
      list: () => unused,
      stat: () => unused,
    },
    exec: (cmd) =>
      Effect.sync(() => {
        script.execs.push(cmd);
        return { status: "completed" as const, stdout: new Uint8Array(), stderr: new Uint8Array(), exitCode: 0, signal: null, truncated: false };
      }),
    screen: () => unused,
    input: () => unused,
    pty: {
      open: (name) =>
        Effect.sync(() => {
          if (script.openRefused === true) return { status: "refused" as const, reason: "path_escapes_export" as const };
          script.live.add(name);
          return { status: "ok" as const, cursor: "c0" };
        }),
      write: (_name, data) =>
        Effect.sync(() => {
          const text = Buffer.from(data).toString("utf8");
          script.writes.push(text);
          script.onWrite?.(text);
          return { status: "ok" as const };
        }),
      read: () => unused,
      resize: () => unused,
      close: (name) =>
        Effect.sync(() => {
          script.live.delete(name);
          return { status: "ok" as const };
        }),
      list: () =>
        script.listRefused === true
          ? Effect.succeed({ status: "refused" as const, reason: "pty_not_available" as const })
          : Effect.succeed({ status: "ok" as const, sessions: [...script.live].map((name) => ({ name, status: "live" as const })), truncated: false }),
    },
    runCode: () => unused,
    peekCode: () => unused,
  };
  return {
    place: ({ ...request }) => {
      const scripted = "machineId" in request ? script.placement?.[request.machineId] : undefined;
      if (scripted !== undefined) return scripted;
      return "machineId" in request && request.machineId === MACHINE
        ? { kind: "placed", machineId: MACHINE, lease: fakeLease(MACHINE, script.lease) }
        : { kind: "no_member" };
    },
    get: () => handle,
    list: () => [{ machineId: MACHINE, name: "m", allowedCapabilities: ["pty.session"], allowedExports: ["work"], publicKey: "0".repeat(64), enrolledAt: 1, tags: [], capabilities: ["pty.session"], os: "darwin", arch: "arm64" }],
  };
}

/** The reconciler stand-in: persisted rows per session, one admission door, and the committed-action notification. */
function scriptedWatch() {
  const rows = new Map<string, ChildRow[]>();
  const listeners = new Map<string, Set<() => void>>();
  const installs: ChildWatch[] = [];
  const closes: string[] = [];
  const admitted: ChildRow[][] = [];
  const push = (sessionId: string, added: readonly ChildRow[]) => {
    rows.set(sessionId, [...(rows.get(sessionId) ?? []), ...added]);
    for (const listener of listeners.get(sessionId) ?? []) listener();
  };
  const ports: CliRunnerDeps["watch"] = {
    install: (spec) => Effect.sync(() => void installs.push(spec)),
    close: (id) => Effect.sync(() => void closes.push(id)),
    rows: (sessionId) => rows.get(sessionId) ?? [],
    admit: (sessionId, added) =>
      Effect.sync(() => {
        admitted.push([...added]);
        push(sessionId, added);
      }),
  };
  const committed: CliRunnerDeps["committed"] = (sessionId, listener) => {
    const set = listeners.get(sessionId) ?? new Set<() => void>();
    set.add(listener);
    listeners.set(sessionId, set);
    return () => void set.delete(listener);
  };
  return { ports, committed, push, installs, closes, admitted, known: (sessionId: string) => rows.get(sessionId) ?? [] };
}

function declaredContact(id: string, settings: Record<string, string>) {
  const plane = testPlane();
  plane.stores.instances.put({
    id: cliContactRowId(id), provider: "cli", identity: "bot", enabled: true, settings, revision: 0, createdBy: "owner", updatedAt: 1,
  });
  return plane;
}

test("the address resolves a declared row only: unknown dialect, unknown machine, disabled or undeclared rows are typed refusals", () => {
  const plane = declaredContact("reviewer", { dialect: DIALECT, machine: MACHINE, cwd: "/work" });
  plane.stores.instances.put({ id: cliContactRowId("asleep"), provider: "cli", identity: "bot", enabled: false, settings: { dialect: DIALECT, machine: MACHINE }, revision: 0, createdBy: "owner", updatedAt: 1 });
  plane.stores.instances.put({ id: cliContactRowId("elsewhere"), provider: "cli", identity: "bot", enabled: true, settings: { dialect: DIALECT, machine: "m-9" }, revision: 0, createdBy: "owner", updatedAt: 1 });
  plane.stores.instances.put({ id: cliContactRowId("vendorless"), provider: "cli", identity: "bot", enabled: true, settings: { dialect: "nope", machine: MACHINE }, revision: 0, createdBy: "owner", updatedAt: 1 });
  try {
    const deps = { instances: plane.stores.instances, machineKnown: (machine: string) => machine === MACHINE, packs: [testPack] };
    expect(resolveCliContact("reviewer", deps)).toMatchObject({ id: "reviewer", machine: MACHINE, cwd: "/work", session: "cli-reviewer" });
    expect(resolveCliContact("nobody", deps)).toEqual({ reason: "no cli contact nobody is declared" });
    expect(resolveCliContact("asleep", deps)).toEqual({ reason: "cli contact asleep is disabled" });
    expect(resolveCliContact("elsewhere", deps)).toMatchObject({ reason: expect.stringContaining("unknown machine m-9") });
    expect(resolveCliContact("vendorless", deps)).toMatchObject({ reason: expect.stringContaining("unknown dialect nope; registered dialects: fixture-dialect") });
    expect(validateCliContactSettings({ dialect: DIALECT }, { dialects: [DIALECT], machineKnown: () => true })).toContain("cli contact settings must be {dialect, machine, cwd?}");
    expect(validateCliContactSettings({ dialect: DIALECT, machine: MACHINE, cwd: "relative" }, { dialects: [DIALECT], machineKnown: () => true })).toContain("cli contact settings");
    // One contact, one machine, one session name — derived from the id alone and within the pty grammar.
    expect(cliSessionName("reviewer")).toBe("cli-reviewer");
    expect(cliSessionName("a".repeat(80))).toHaveLength(64);
    expect(cliContactRowId("reviewer")).toBe("channel:cli:reviewer");
  } finally {
    plane.close();
  }
});

test("the data rule: hook authority, transcript terminal, the typed screen seam, and unknown when nothing has spoken", () => {
  expect(childState({ hook: "waiting", transcriptTerminal: false })).toBe("blocked");
  expect(childState({ hook: "waiting", transcriptTerminal: true })).toBe("blocked");
  expect(childState({ hook: "terminal", transcriptTerminal: false })).toBe("idle");
  expect(childState({ hook: "observed", transcriptTerminal: true })).toBe("idle");
  for (const hook of ["observed", "requested", "decided", "result"] as const)
    expect(childState({ hook, transcriptTerminal: false })).toBe("working");
  expect(childState({ transcriptTerminal: true })).toBe("idle");
  // The screen seam decides only without file evidence; an unmatched screen is never idle.
  expect(childState({ transcriptTerminal: false, screen: "permission_prompt" })).toBe("blocked");
  expect(childState({ transcriptTerminal: false, screen: "working" })).toBe("working");
  expect(childState({ transcriptTerminal: false, screen: "idle_prompt" })).toBe("idle");
  expect(childState({ hook: "requested", transcriptTerminal: false, screen: "idle_prompt" })).toBe("working");
  expect(childState({ transcriptTerminal: false })).toBe("unknown");
  // From persisted receipts: the latest hook sequence wins (the fixture's Stop is seq 5, its PermissionRequest seq 6),
  // and the transcript terminal is a fact of its own.
  const rows = hookRows("c", "t", [liveLine("PreToolUse"), liveLine("Stop")]);
  const waiting = hookRows("c", "t", [liveLine("Stop"), liveLine("PermissionRequest")]);
  expect(stateInput(stateReceipts(waiting, "c", "t"))).toEqual({ hook: "waiting", transcriptTerminal: false });
  expect(stateInput(stateReceipts(rows, "c", "t"))).toEqual({ hook: "observed", transcriptTerminal: false });
  expect(stateInput(stateReceipts([...rows, ...transcriptRows("c", "t", "terminal", rows)], "c", "t"))).toEqual({ hook: "observed", transcriptTerminal: true });
  expect(stateInput([])).toEqual({ transcriptTerminal: false });
});

test("the declaration door: provider cli lands through channel_add under Owner consent, judged by the contact's door, and the profile mounts no channel for it", async () => {
  const plane = testPlane();
  try {
    const base = provisionPort(plane);
    const machineKnown = (machine: string) => machine === MACHINE;
    const port = { ...base, cli: { declare: (settings: Parameters<typeof validateCliContactSettings>[0]) => validateCliContactSettings(settings, { dialects: [pack.manifest.id], machineKnown }) } };
    const declare = executeChannelDeclare(port, () => 1_000);
    const args = CHANNEL_DECLARE_INPUT.parse({ id: cliContactRowId("reviewer"), provider: "cli", settings: { dialect: pack.manifest.id, machine: MACHINE, cwd: "/work" } });
    const revisions = channelDomainRevisions(port.instances, args.id);
    // A machine is where the Resident's letters go: the declaration is the Owner's call.
    expect(provisionApproval(port)({ operation: { op: "channel_add", args } })).toEqual({ required: true, domainRevisions: { [args.id]: -1 } });
    await expect(declare(args)).rejects.toThrow(/require Owner consent/);
    await expect(declare({ ...args, settings: { dialect: "nope", machine: MACHINE } }, revisions)).rejects.toThrow(/unknown dialect nope/);
    await expect(declare({ ...args, settings: { dialect: pack.manifest.id, machine: "m-9" } }, revisions)).rejects.toThrow(/unknown machine m-9/);
    await expect(declare({ ...args, credential: { token: "x" } }, revisions)).rejects.toThrow(/carry no credential/);
    await expect(declare({ ...args, identity: "owner" }, revisions)).rejects.toThrow(/no Owner-account arm/);
    await expect(executeChannelDeclare(base, () => 1_000)(args, revisions)).rejects.toThrow(/cli contacts are not composed/);
    expect(plane.stores.instances.get(args.id)).toBeUndefined();
    const landed = await declare(args, revisions);
    expect(landed).toMatchObject({ id: args.id, action: "declared" });
    expect(resolveCliContact("reviewer", { instances: plane.stores.instances, machineKnown })).toMatchObject({ id: "reviewer", machine: MACHINE, cwd: "/work", pack });
    const profile = declaredChannelProfile(plane.stores.instances.list(), () => ({ kind: "locked", reason: "unused" }), testChannelDeps());
    expect(profile.rows).toEqual([]);
    expect(profile.statuses).toEqual([{ id: args.id, provider: "cli", state: "ready", detail: "contact row: reached over the machine pty, no channel component" }]);
  } finally {
    plane.close();
  }
});

test("the hook appender is POSIX sh, names its spool quoted, and the pack wires its command per event", () => {
  const script = hookScript("/work/.openomni/c-1/spool.jsonl");
  expect(script.startsWith("#!/bin/sh\n")).toBe(true);
  expect(script).toContain("spool='/work/.openomni/c-1/spool.jsonl'");
  expect(script).toContain('until mkdir "$lock"');
  expect(script).toContain('"seq":%s,"event":"%s","receivedAt":%s,"payload":%s');
  expect(hookCommand("/a b/hook.sh")).toBe("sh '/a b/hook.sh'");
  expect(hookScript("/it's/spool")).toContain("spool='/it'\\''s/spool'");
  expect(launchLine({ argv: ["claude", "--session-id", "s-1"], env: {} })).toBe("exec 'claude' '--session-id' 's-1'\n");
  expect(launchLine({ argv: ["agent"], env: { A: "x y" } })).toBe("exec env A='x y' 'agent'\n");
});

test("the runner: launch on first send, one watch per turn, refusals by the data rule, the stalled diagnostic through the door, the deadline interrupt, and pane cleanup", async () => {
  const plane = declaredContact("reviewer", { dialect: DIALECT, machine: MACHINE, cwd: "/work" });
  const script: Scripted = { live: new Set(), files: new Map(), writes: [], execs: [], lease: [] };
  const watch = scriptedWatch();
  const armed: object[] = [];
  const runner = createCliRunner({
    instances: plane.stores.instances,
    machineKnown: (machine) => machine === MACHINE,
    packs: [testPack],
    host: scriptedHost(script),
    watch: watch.ports,
    committed: watch.committed,
    deadline: (input) => Effect.sync(() => void armed.push(input)),
    id: testIds("child"),
    now: () => 10_000,
  });
  const send = (key: string, deadlineMs?: number) =>
    runner.run({ agent: "reviewer", message: "hello", sender: SENDER, turnId: "turn-1", key, ...(deadlineMs === undefined ? {} : { deadlineMs }) });
  try {
    // An undeclared contact never touches the machine.
    expect(await runEffect(Effect.flip(runner.run({ agent: "nobody", message: "x", sender: SENDER, turnId: "t", key: "k0" })))).toEqual({ reason: "no cli contact nobody is declared" });
    expect(script.writes).toEqual([]);
    // The fake child: a launch answers with its SessionStart in the spool and the reconciler admits it; the submitted
    // letter yields the turn's rows through to the transcript's terminal.
    const spool = "/work/.openomni/child-1/spool.jsonl";
    const respond = (key: string, lines: readonly string[], terminal: boolean) => {
      script.onWrite = (text) => {
        if (text.startsWith("exec ")) {
          script.files.set(spool, `${liveLine("SessionStart")}\n`);
          watch.push(SENDER, hookRows("child-1", key, [liveLine("SessionStart")], watch.known(SENDER)));
        }
        if (text === "\r") {
          const known = watch.known(SENDER);
          const added = hookRows("child-1", key, lines, known);
          watch.push(SENDER, added);
          if (terminal) watch.push(SENDER, transcriptRows("child-1", key, "terminal", [...known, ...added]));
        }
      };
    };
    respond("k1", [liveLine("UserPromptSubmit"), liveLine("PreToolUse"), liveLine("PostToolUse"), liveLine("Stop")], true);
    const first = await runEffect(send("k1", 60_000));
    // Four source-free facts: observed (start, submit and stop collapse), requested, result, terminal.
    expect(first).toEqual({ child: "child-1", turn: "k1", facts: 4 });
    // Place → open under the lease → live config on the machine → spool-only watch → launch → located transcript → full watch.
    expect(script.lease.slice(0, 2)).toEqual(["open:cli-reviewer", "use:cli-reviewer"]);
    expect(script.execs).toEqual(["mkdir -p '/work/.openomni/child-1'"]);
    expect(script.files.get("/work/.openomni/child-1/hook.sh")).toBe(hookScript(spool));
    expect(script.files.get("/work/.openomni/child-1/live.json")).toBe(testPack.liveConfig?.({ hookCommand: hookCommand("/work/.openomni/child-1/hook.sh") }));
    expect(script.writes).toEqual([
      launchLine({ argv: ["claude", "--session-id", "child-1", "--settings", "/work/.openomni/child-1/live.json"], env: {} }),
      "hello",
      "\r",
    ]);
    expect(watch.installs.map((spec) => ({ id: spec.id, turn: spec.turn, spool: spec.spool?.path, transcript: spec.transcript?.path }))).toEqual([
      { id: "cli:child-1:k1", turn: "k1", spool, transcript: undefined },
      { id: "cli:child-1:k1", turn: "k1", spool, transcript: "/redacted/session.jsonl" },
    ]);
    expect(watch.installs[1]).toMatchObject({ sessionId: SENDER, child: "child-1", occupant: { command: "claude" }, spool: { machine: MACHINE, export: "work", parser: { dialect: "hook-spool", version: "1" } }, transcript: { parser: { dialect: DIALECT, version: "1" } } });
    expect(watch.closes).toEqual(["cli:child-1:k1"]);
    expect(armed).toEqual([{ sessionId: SENDER, turnId: "turn-1", child: "child-1", contact: "cli:reviewer", at: 70_000 }]);

    // The second send reuses the pane; a child waiting on a permission request (hook authority, even after the
    // transcript ended the turn) refuses the write as agent_blocked.
    watch.push(SENDER, hookRows("child-1", "k1", [liveLine("PermissionRequest")], watch.known(SENDER)));
    script.onWrite = undefined;
    expect(await runEffect(Effect.flip(send("k2")))).toEqual({ reason: "agent_blocked: the child is waiting on a permission request" });
    expect(script.writes).toHaveLength(3);
    // Decided: the ended turn is idle again, and the next turn opens its own watch after closing k1's.
    const decidedLine = fixtures.live.find((entry) => entry.phase === "decided")?.line;
    if (decidedLine === undefined) throw new Error("missing decided fixture");
    watch.push(SENDER, hookRows("child-1", "k1", [decidedLine], watch.known(SENDER)));
    const stalled = await runEffect(Effect.flip(send("k3")));
    expect(stalled).toEqual({ reason: "prompt_stalled: no live observation within 20 ms" });
    expect(watch.closes.slice(1)).toEqual(["cli:child-1:k1", "cli:child-1:k3"]);
    expect(script.writes.slice(3)).toEqual(["hello", "\r"]);
    // The stalled diagnostic went through the reconciler's door with the spool reference and no bytes; the pane was retired.
    expect(watch.admitted).toHaveLength(1);
    expect(watch.admitted[0]?.[0]).toMatchObject({
      kind: "child_diagnostic",
      content: { child: "child-1", turn: "k3", ref: { path: spool, range: { offsetBytes: 0, lengthBytes: 0 } }, diagnostic: { code: "prompt_stalled" } },
    });
    expect(script.live.has("cli-reviewer")).toBe(false);
    expect(script.lease).toContain("release");

    // The next send launches a fresh child; the deadline door interrupts its pane and the waiting send ends `landed`.
    const spool2 = "/work/.openomni/child-2/spool.jsonl";
    script.onWrite = (text) => {
      if (text.startsWith("exec ")) {
        script.files.set(spool2, `${liveLine("SessionStart")}\n`);
        watch.push(SENDER, hookRows("child-2", "k4", [liveLine("SessionStart")], watch.known(SENDER)));
      }
      if (text === "\r") watch.push(SENDER, hookRows("child-2", "k4", [liveLine("UserPromptSubmit")], watch.known(SENDER)));
    };
    const pending = runEffect(Effect.flip(send("k4")));
    // The letter is in the pane and the turn is running: an interrupt of an unknown child is refused, of this one taken.
    await runEffect(
      Effect.flip(runner.interrupt("child-9")).pipe(Effect.tap((refused) => Effect.sync(() => expect(refused).toEqual({ reason: "no cli child child-9 is running" })))),
    );
    // The submit has landed once the Enter write is recorded; await that state through the writes the fake saw.
    await new Promise<void>((resolve) => {
      const previous = script.onWrite;
      script.onWrite = (text) => {
        previous?.(text);
        if (text === "\r") resolve();
      };
      if (script.writes.includes("\r") && script.writes.filter((write) => write === "\r").length >= 3) resolve();
    });
    // A concurrent send to a running child is busy, and writes nothing.
    const writesBefore = script.writes.length;
    expect(await runEffect(Effect.flip(send("k4b")))).toEqual({ reason: "agent_busy: the child's previous turn has not ended" });
    expect(script.writes).toHaveLength(writesBefore);
    await runEffect(runner.interrupt("child-2"));
    expect(await pending).toEqual({ reason: "deadline expired; the child was interrupted", landed: true });
    expect(script.writes.at(-1)).toBe("\u0003");

    // After our own interrupt the pane is idle for the next turn, which runs to its terminal.
    script.onWrite = (text) => {
      if (text === "\r") {
        const known = watch.known(SENDER);
        const added = hookRows("child-2", "k5", [liveLine("UserPromptSubmit")], known);
        watch.push(SENDER, added);
        watch.push(SENDER, transcriptRows("child-2", "k5", "terminal", [...known, ...added]));
      }
    };
    expect(await runEffect(send("k5"))).toEqual({ child: "child-2", turn: "k5", facts: 2 });

    // Closing the runner drops the pane: its watch, its tmux session, its lease.
    await runEffect(runner.close());
    expect(script.live.size).toBe(0);
    expect(watch.closes.at(-1)).toBe("cli:child-2:k5");
    expect(script.lease.filter((entry) => entry === "release")).toHaveLength(2);
  } finally {
    plane.close();
  }
});

test("the runner never writes to a pane it did not launch, and every placement or daemon refusal is a typed reason before any write", async () => {
  const plane = declaredContact("reviewer", { dialect: DIALECT, machine: MACHINE, cwd: "/work" });
  for (const [id, machine] of [["remote", "m-2"], ["stale", "m-3"], ["full", "m-4"]] as const)
    plane.stores.instances.put({ id: cliContactRowId(id), provider: "cli", identity: "bot", enabled: true, settings: { dialect: DIALECT, machine }, revision: 0, createdBy: "owner", updatedAt: 1 });
  const script: Scripted = {
    live: new Set(["cli-reviewer"]), files: new Map(), writes: [], execs: [], lease: [],
    placement: {
      "m-3": { kind: "all_stale" },
      "m-4": { kind: "machine_saturated", machineId: "m-4", reason: "slots", slots: 1, inFlight: 1 },
    },
  };
  const watch = scriptedWatch();
  const runner = createCliRunner({
    instances: plane.stores.instances,
    machineKnown: () => true,
    packs: [testPack],
    host: scriptedHost(script),
    watch: watch.ports,
    committed: watch.committed,
    id: testIds("child"),
    now: () => 0,
  });
  const attempt = (agent: string, key: string) => runEffect(Effect.flip(runner.run({ agent, message: "x", sender: SENDER, turnId: "t", key })));
  try {
    expect(await attempt("reviewer", "k1")).toEqual({
      reason: "pane cli-reviewer on m-1 has an occupant this Resident did not launch; attaching by observation is not in this increment",
    });
    expect(await attempt("remote", "k2")).toEqual({ reason: "machine m-2 is not attached" });
    expect(await attempt("stale", "k3")).toEqual({ reason: "machine m-3 is stale" });
    expect(await attempt("full", "k4")).toEqual({ reason: "machine_saturated: m-4 (slots)" });
    // The daemon's own refusals: no pty surface, a cwd outside the exports (the lease is released again).
    script.live.clear();
    script.listRefused = true;
    expect(await attempt("reviewer", "k5")).toEqual({ reason: "pty.list refused: pty_not_available" });
    script.listRefused = false;
    script.openRefused = true;
    expect(await attempt("reviewer", "k6")).toEqual({ reason: "pty.open refused: path_escapes_export" });
    expect(script.lease).toEqual(["open:cli-reviewer", "release"]);
    expect(script.writes).toEqual([]);
    expect(watch.installs).toEqual([]);
  } finally {
    plane.close();
  }
});

test("a launch whose first live line names no transcript keeps the spool-only watch, and a bus without subscription cannot await a turn", async () => {
  const plane = declaredContact("reviewer", { dialect: DIALECT, machine: MACHINE, cwd: "/work" });
  const script: Scripted = { live: new Set(), files: new Map(), writes: [], execs: [], lease: [] };
  const watch = scriptedWatch();
  const deps: CliRunnerDeps = {
    instances: plane.stores.instances,
    machineKnown: () => true,
    packs: [testPack],
    host: scriptedHost(script),
    watch: watch.ports,
    committed: watch.committed,
    id: testIds("child"),
    now: () => 0,
  };
  try {
    const spool = "/work/.openomni/child-1/spool.jsonl";
    script.onWrite = (text) => {
      // The child's first live event is not the one that carries the transcript location.
      if (text.startsWith("exec ")) {
        script.files.set(spool, `${liveLine("UserPromptSubmit")}
`);
        watch.push(SENDER, hookRows("child-1", "k1", [liveLine("UserPromptSubmit")], watch.known(SENDER)));
      }
      if (text === "\r") {
        const known = watch.known(SENDER);
        watch.push(SENDER, hookRows("child-1", "k1", [liveLine("PreToolUse")], known));
        watch.push(SENDER, hookRows("child-1", "k1", [liveLine("SessionEnd")], watch.known(SENDER)));
      }
    };
    expect(await runEffect(createCliRunner(deps).run({ agent: "reviewer", message: "hello", sender: SENDER, turnId: "t", key: "k1" }))).toEqual({ child: "child-1", turn: "k1", facts: 3 });
    expect(watch.installs).toHaveLength(1);
    expect(watch.installs[0]?.transcript).toBeUndefined();
    // Without a committed-action subscription the first wait is a typed refusal, after the launch went out.
    script.live.clear();
    script.onWrite = undefined;
    const silent = createCliRunner({ ...deps, id: testIds("quiet"), committed: () => undefined });
    expect(await runEffect(Effect.flip(silent.run({ agent: "reviewer", message: "hello", sender: SENDER, turnId: "t", key: "k2" })))).toEqual({
      reason: "the observation bus offers no subscription; a cli turn cannot be awaited",
    });
  } finally {
    plane.close();
  }
});
