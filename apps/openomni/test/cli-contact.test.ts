/**
 * #1512 `cli:` contact over the machine pty — the pure pieces and the runner
 * over a scripted machine host: address resolution through the declared row,
 * the idle/working/blocked data rule, the declaration door under Owner
 * consent, submit refusal on a blocked child, the stalled-prompt diagnostic
 * through the reconciler's door, the deadline interrupt, and pane cleanup.
 * Every observation the runner acts on is a persisted row built from the
 * dialect fixtures through the pack's own decoders; no vendor payload is
 * written by hand here. The hook appender itself runs under the local
 * POSIX shell with a closed stdin and contested locks.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Core } from "@openomni/agent";
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
import { childState, foldState, NOTHING_SPOKEN, type StateFold, stateInputOf } from "../src/bundles/child-activity/contact/rule";
import { createCliRunner, launchLine, type CliRunnerDeps } from "../src/bundles/child-activity/contact/runner";
import type { DialectPack } from "../src/bundles/child-activity/dialects/pack";
import type { ChildWatch } from "../src/bundles/child-activity/index";
import { type ChildRow, reconcile, type StateReceipt, stateReceipts } from "../src/bundles/child-activity/reconcile";
import { armDelegationDeadline, cliDeadlineChain, DELEGATION_DEADLINE } from "../src/bundles/delegation-policy/index";
import { decodeSpool } from "../src/bundles/child-activity/spool";
import { decodeTranscript } from "../src/bundles/child-activity/transcript";
import { fixture, fixtures, pack, reference } from "./helpers/child-activity";
import { runEffect, testClockRuntime } from "./helpers/effect";
import { testPlane } from "./helpers/ledger";
import { provisionPort } from "./helpers/provision-port";
import { testChannelDeps, testIds } from "./helpers/test-entropy";

const SENDER = "resident-1";
const MACHINE = "m-1";
const DIALECT = "fixture-dialect";

/** The rule's input over a turn's joined receipts, through the incremental fold the runner keeps (r2 L9). */
function stateInput(receipts: readonly StateReceipt[]) {
  return stateInputOf(receipts.reduce<StateFold>((fold, entry) => foldState(fold, { phase: entry.fact.phase, ref: entry.receipt.ref }), NOTHING_SPOKEN));
}

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
  /** The fake child: what happens on the machine when the pane receives these bytes (`name` is the pane). */
  onWrite?: (text: string, name: string) => void;
  /** The pane each successful write reached, in write order, when a test asks for it. */
  targets?: string[];
  /** Scripted daemon refusals. */
  listRefused?: boolean;
  openRefused?: boolean;
  writeRefused?: boolean;
  /** The exit code every exec answers with; `0` when unset. */
  execExit?: number;
  /** The attachment's effective exports with their roots; `work=/work` when unset. */
  exports?: readonly { readonly name: string; readonly path: string }[];
  /** Scripted placement outcomes by machine id; unlisted machines are placed on MACHINE only. */
  placement?: Record<string, ReturnType<MachineHost["place"]>>;
}

function scriptedHost(script: Scripted): Pick<MachineHost, "place" | "get" | "exports"> {
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
        return { status: "completed" as const, stdout: new Uint8Array(), stderr: new Uint8Array(), exitCode: script.execExit ?? 0, signal: null, truncated: false };
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
          if (script.writeRefused === true) return { status: "refused" as const, reason: "pty_not_available" as const };
          const text = Buffer.from(data).toString("utf8");
          script.writes.push(text);
          script.targets?.push(_name);
          script.onWrite?.(text, _name);
          return { status: "ok" as const };
        }),
      read: () => unused,
      screen: () => unused,
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
    exports: () => script.exports ?? [{ name: "work", path: "/work" }],
  };
}

/** The reconciler stand-in: persisted rows per session, one admission door, the paged read, and the committed-action notification. */
function scriptedWatch() {
  const rows = new Map<string, ChildRow[]>();
  const listeners = new Map<string, Set<() => void>>();
  const installs: ChildWatch[] = [];
  const closes: string[] = [];
  const admitted: ChildRow[][] = [];
  /** Every `afterRevision` the runner paged from (r1 L6): the whole history is read once, then only the tail. */
  const scans: number[] = [];
  const knobs: { refuseInstall?: string } = {};
  const push = (sessionId: string, added: readonly ChildRow[]) => {
    rows.set(sessionId, [...(rows.get(sessionId) ?? []), ...added]);
    for (const listener of listeners.get(sessionId) ?? []) listener();
  };
  const ports: CliRunnerDeps["watch"] = {
    install: (spec) =>
      knobs.refuseInstall === undefined ? Effect.sync(() => void installs.push(spec)) : Effect.fail({ reason: knobs.refuseInstall }),
    close: (id) => Effect.sync(() => void closes.push(id)),
    rows: (sessionId, afterRevision) => {
      scans.push(afterRevision);
      const all = rows.get(sessionId) ?? [];
      return { rows: all.slice(afterRevision), revision: all.length };
    },
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
  return { ports, committed, push, installs, closes, admitted, scans, knobs, known: (sessionId: string) => rows.get(sessionId) ?? [] };
}

function declaredContact(id: string, settings: Record<string, string>) {
  const plane = testPlane();
  plane.stores.instances.put({
    id: cliContactRowId(id), provider: "cli", identity: "bot", enabled: true, settings, revision: 0, createdBy: "owner", updatedAt: 1,
  });
  return plane;
}

/** The fake child's launch answer: SessionStart in the spool, admitted for the turn. */
function launchAnswer(script: Scripted, watch: ReturnType<typeof scriptedWatch>, child: string, key: string): void {
  script.files.set(`/work/.openomni/${child}/spool.jsonl`, `${liveLine("SessionStart")}\n`);
  watch.push(SENDER, hookRows(child, key, [liveLine("SessionStart")], watch.known(SENDER)));
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
  const ended = stateReceipts([...rows, ...transcriptRows("c", "t", "terminal", rows)], "c", "t");
  expect(stateInput(ended)).toEqual({ hook: "observed", transcriptTerminal: true });
  expect(stateInput([])).toEqual({ transcriptTerminal: false });
  // r2 L9: the fold is order-independent — a lower hook sequence never replaces a higher one, a transcript terminal
  // stays however the receipts arrive — and a transcript row that is not the terminal changes nothing.
  expect(stateInput([...ended].reverse())).toEqual({ hook: "observed", transcriptTerminal: true });
  expect(stateInput([...stateReceipts(waiting, "c", "t")].reverse())).toEqual({ hook: "waiting", transcriptTerminal: false });
  const requested = stateReceipts(transcriptRows("c", "t", "requested"), "c", "t");
  expect(requested.length).toBeGreaterThan(0);
  expect(stateInput(requested)).toEqual({ transcriptTerminal: false });
  const terminalFold = ended.reduce<StateFold>((fold, entry) => foldState(fold, { phase: entry.fact.phase, ref: entry.receipt.ref }), NOTHING_SPOKEN);
  expect(ended.reduce<StateFold>((fold, entry) => foldState(fold, { phase: entry.fact.phase, ref: entry.receipt.ref }), terminalFold)).toBe(terminalFold);
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

/**
 * One hook invocation under the local shell, bounded by the process watchdog: never a sleep, never an unbounded
 * wait. `exec` makes the hook's shell the watched process itself, so a kill at the bound leaves no orphan waiting on
 * the lock behind the test's back.
 */
async function runHook(shell: string, stdin: "ignore" | Uint8Array, timeoutMs: number) {
  const child = Bun.spawn(["/bin/sh", "-c", `exec ${shell}`], { stdin, stdout: "ignore", stderr: "ignore", timeout: timeoutMs, killSignal: "SIGKILL" });
  await child.exited;
  return { exitCode: child.exitCode, signalCode: child.signalCode };
}

test("#1512 r1 L2/L3: the hook appender appends {} on a closed stdin instead of hanging, and breaks only a lock whose holder is gone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "openomni-hook-"));
  const spool = join(dir, "spool.jsonl");
  const lock = `${spool}.lock`;
  const script = join(dir, "hook.sh");
  // Three 20 ms tries before the holder is checked: the shipped 500 would hold a dead holder's lock for ten seconds here.
  writeFileSync(script, hookScript(spool, 3));
  const lines = () => readFileSync(spool, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { seq: number; event: string; receivedAt: number; payload: object });
  try {
    // A vendor that closed stdin: the event still lands, with the empty payload, and the hook exits.
    expect(await runHook(`sh '${script}' UserPromptSubmit <&-`, "ignore", 3_000)).toEqual({ exitCode: 0, signalCode: null });
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({ seq: 1, event: "UserPromptSubmit", payload: {} });
    expect(typeof lines()[0]?.receivedAt).toBe("number");
    // The payload on stdin is appended verbatim under the next sequence.
    expect(await runHook(`sh '${script}' PreToolUse`, Buffer.from('{"tool_name":"Bash"}'), 3_000)).toEqual({ exitCode: 0, signalCode: null });
    expect(lines().at(-1)).toMatchObject({ seq: 2, event: "PreToolUse", payload: { tool_name: "Bash" } });
    // A lock held by a LIVE process (this one) is never broken: the hook waits until the watchdog ends it.
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), `${process.pid}\n`);
    expect(await runHook(`sh '${script}' Stop <&-`, "ignore", 1_500)).toEqual({ exitCode: null, signalCode: "SIGKILL" });
    expect(lines()).toHaveLength(2);
    expect(readFileSync(join(lock, "pid"), "utf8").trim()).toBe(String(process.pid));
    // A lock whose holder is gone is broken past the bound, and the appender releases its own on exit.
    const gone = Bun.spawn(["/bin/sh", "-c", "exit 0"], { stdout: "ignore", stderr: "ignore" });
    await gone.exited;
    writeFileSync(join(lock, "pid"), `${gone.pid}\n`);
    expect(await runHook(`sh '${script}' Stop <&-`, "ignore", 3_000)).toEqual({ exitCode: 0, signalCode: null });
    expect(lines().at(-1)).toMatchObject({ seq: 3, event: "Stop" });
    expect(() => readFileSync(join(lock, "pid"))).toThrow();
    // A holder that died before recording itself left a lock with no pid: broken past the bound as well.
    mkdirSync(lock);
    expect(await runHook(`sh '${script}' SessionEnd <&-`, "ignore", 3_000)).toEqual({ exitCode: 0, signalCode: null });
    expect(lines().at(-1)).toMatchObject({ seq: 4, event: "SessionEnd" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

test("the runner: launch on first send, one watch per turn, refusals by the data rule, the stalled diagnostic through the door, the deadline interrupt, and pane cleanup", async () => {
  const plane = declaredContact("reviewer", { dialect: DIALECT, machine: MACHINE, cwd: "/work" });
  const script: Scripted = { live: new Set(), files: new Map(), writes: [], execs: [], lease: [] };
  const watch = scriptedWatch();
  const armed: object[] = [];
  const retired: string[] = [];
  const runner = createCliRunner({
    instances: plane.stores.instances,
    machineKnown: (machine) => machine === MACHINE,
    packs: [testPack],
    host: scriptedHost(script),
    watch: watch.ports,
    committed: watch.committed,
    deadline: (input) =>
      Effect.sync(() => {
        armed.push(input);
        return { retire: Effect.sync(() => void retired.push(input.child)) };
      }),
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
        if (text.startsWith("exec ")) launchAnswer(script, watch, "child-1", key);
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
    // r1 L1: the deadline is retired with the terminal — a late fire has nothing to interrupt.
    expect(retired).toEqual(["child-1"]);
    // r1 L5: a replay of the tool call's key returns the admitted pointer and types nothing.
    expect(await runEffect(send("k1"))).toEqual(first);
    expect(script.writes).toHaveLength(3);
    // r1 L1: the ended turn refuses the deadline door typed; no ETX reaches the idle child.
    expect(await runEffect(Effect.flip(runner.interrupt("child-1")))).toEqual({ reason: expect.stringContaining("turn_already_ended"), code: "turn_already_ended" });
    expect(script.writes).toHaveLength(3);

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
    const stalled = await runEffect(Effect.flip(send("k3", 60_000)));
    expect(stalled).toEqual({ reason: "prompt_stalled: no live observation within 20 ms" });
    expect(watch.closes.slice(1)).toEqual(["cli:child-1:k1", "cli:child-1:k3"]);
    expect(script.writes.slice(3)).toEqual(["hello", "\r"]);
    // The stalled diagnostic went through the reconciler's door with the spool reference and no bytes; the pane was
    // retired, and the stall retired its deadline too (r1 L1).
    expect(watch.admitted).toHaveLength(1);
    expect(watch.admitted[0]?.[0]).toMatchObject({
      kind: "child_diagnostic",
      content: { child: "child-1", turn: "k3", ref: { path: spool, range: { offsetBytes: 0, lengthBytes: 0 } }, diagnostic: { code: "prompt_stalled" } },
    });
    expect(script.live.has("cli-reviewer")).toBe(false);
    expect(script.lease).toContain("release");
    expect(retired).toEqual(["child-1", "child-1"]);
    // A replay of the stalled key is the same refusal, with no fresh launch and no letter.
    expect(await runEffect(Effect.flip(send("k3")))).toEqual(stalled);
    expect(script.writes).toHaveLength(5);

    // The next send launches a fresh child; the deadline door interrupts its pane and the waiting send ends `landed`.
    script.onWrite = (text) => {
      if (text.startsWith("exec ")) launchAnswer(script, watch, "child-2", "k4");
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
      script.onWrite = (text, name) => {
        previous?.(text, name);
        if (text === "\r") resolve();
      };
      if (script.writes.includes("\r") && script.writes.filter((write) => write === "\r").length >= 3) resolve();
    });
    // A concurrent send to a running child is busy, and writes nothing; a replay of the running key joins it (r1 L5).
    const writesBefore = script.writes.length;
    expect(await runEffect(Effect.flip(send("k4b")))).toEqual({ reason: "agent_busy: the child's previous turn has not ended" });
    const replayed = runEffect(Effect.flip(send("k4")));
    expect(script.writes).toHaveLength(writesBefore);
    await runEffect(runner.interrupt("child-2"));
    expect(await pending).toEqual({ reason: "deadline expired; the child was interrupted", landed: true });
    expect(await replayed).toEqual({ reason: "deadline expired; the child was interrupted", landed: true });
    expect(script.writes.at(-1)).toBe("\u0003");
    expect(script.writes).toHaveLength(writesBefore + 1);

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
    // r1 L1: terminal resolved, then the deadline door — typed refusal, no ETX written.
    const writesAfterTerminal = script.writes.length;
    expect(await runEffect(Effect.flip(runner.interrupt("child-2")))).toMatchObject({ code: "turn_already_ended" });
    expect(script.writes).toHaveLength(writesAfterTerminal);
    expect(script.writes.at(-1)).toBe("\r");

    // r1 L6: the committed-action rescans paged forward — the whole history was read exactly once, then only the tail.
    expect(watch.scans[0]).toBe(0);
    expect(watch.scans.filter((after) => after === 0)).toHaveLength(1);
    expect(watch.scans.every((after, index) => index === 0 || after >= (watch.scans[index - 1] ?? 0))).toBe(true);

    // Closing the runner drops the pane: its watch, its tmux session, its lease.
    await runEffect(runner.close());
    expect(script.live.size).toBe(0);
    expect(watch.closes.at(-1)).toBe("cli:child-2:k5");
    expect(script.lease.filter((entry) => entry === "release")).toHaveLength(2);
  } finally {
    plane.close();
  }
});

test("#1512 r1 H2: the stall predicate measures new observation — an acknowledgement alone inside the window is not a stall, a silent child is", async () => {
  const plane = declaredContact("reviewer", { dialect: DIALECT, machine: MACHINE, cwd: "/work" });
  const script: Scripted = { live: new Set(), files: new Map(), writes: [], execs: [], lease: [] };
  const watch = scriptedWatch();
  const clock = testClockRuntime();
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
  const send = (key: string) => runner.run({ agent: "reviewer", message: "hello", sender: SENDER, turnId: "t", key });
  /** Resolves on the exact write the fake child saw: the Enter that submits the letter. */
  const enterSeen = () =>
    new Promise<void>((resolve) => {
      const previous = script.onWrite;
      script.onWrite = (text, name) => {
        previous?.(text, name);
        if (text === "\r") resolve();
      };
    });
  try {
    // The child answers the launch with SessionStart, and the letter with UserPromptSubmit alone: one more receipt
    // on the turn's single `observed` fact — the fact count does not grow, the hook sequence does.
    script.onWrite = (text) => {
      if (text.startsWith("exec ")) launchAnswer(script, watch, "child-1", "k1");
      if (text === "\r") watch.push(SENDER, hookRows("child-1", "k1", [liveLine("UserPromptSubmit")], watch.known(SENDER)));
    };
    const submitted = enterSeen();
    const first = clock.run(send("k1"));
    await clock.adjust(1);
    await submitted;
    // The whole stall window passes on the test clock with nothing but the acknowledgement: no stall.
    await clock.adjust(20);
    expect(watch.admitted).toEqual([]);
    expect(script.live.has("cli-reviewer")).toBe(true);
    // The first tool call and the turn's end arrive after the window; the run resolves on the terminal.
    const known = watch.known(SENDER);
    const tools = hookRows("child-1", "k1", [liveLine("PreToolUse"), liveLine("PostToolUse"), liveLine("Stop")], known);
    watch.push(SENDER, tools);
    watch.push(SENDER, transcriptRows("child-1", "k1", "terminal", [...known, ...tools]));
    expect(await first).toEqual({ child: "child-1", turn: "k1", facts: 4 });

    // A child that yields nothing at all within the window is the prompt_stalled diagnostic, and its pane is retired.
    script.onWrite = undefined;
    const silent = enterSeen();
    const second = clock.run(Effect.flip(send("k2")));
    await clock.adjust(1);
    await silent;
    await clock.adjust(20);
    expect(await second).toEqual({ reason: "prompt_stalled: no live observation within 20 ms" });
    expect(watch.admitted[0]?.[0]).toMatchObject({ kind: "child_diagnostic", content: { turn: "k2", diagnostic: { code: "prompt_stalled" } } });
    expect(script.live.has("cli-reviewer")).toBe(false);
  } finally {
    await clock.dispose();
    plane.close();
  }
});

test("#1512 r1 H1: a refusal between pty.open and the launch line retires the pane — session closed, lease released, nothing registered — and the next send launches fresh", async () => {
  const plane = declaredContact("reviewer", { dialect: DIALECT, machine: MACHINE, cwd: "/work" });
  plane.stores.instances.put({ id: cliContactRowId("nested"), provider: "cli", identity: "bot", enabled: true, settings: { dialect: DIALECT, machine: MACHINE, cwd: "/work/deep/project" }, revision: 0, createdBy: "owner", updatedAt: 1 });
  const script: Scripted = { live: new Set(), files: new Map(), writes: [], execs: [], lease: [] };
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
  const attempt = (agent: string, key: string) => runEffect(Effect.flip(runner.run({ agent, message: "hello", sender: SENDER, turnId: "t", key })));
  const releases = () => script.lease.filter((entry) => entry === "release").length;
  try {
    // The live-config exec refused: the pane was open, so it is closed again and its lease released; no watch, no bytes.
    script.execExit = 1;
    expect(await attempt("reviewer", "k1")).toEqual({ reason: "live config directory /work/.openomni/child-1: exit 1" });
    expect(script.live.has("cli-reviewer")).toBe(false);
    expect(releases()).toBe(1);
    expect(watch.installs).toEqual([]);
    expect(script.writes).toEqual([]);
    // The watch install refused after the live config landed: the just-installed watch is closed with the pane.
    script.execExit = undefined;
    watch.knobs.refuseInstall = "not_live";
    expect(await attempt("reviewer", "k2")).toEqual({ reason: "not_live" });
    expect(script.live.has("cli-reviewer")).toBe(false);
    expect(releases()).toBe(2);
    expect(watch.closes).toEqual([]);
    expect(script.writes).toEqual([]);
    // The launch line itself refused by the daemon: the bare shell is not kept either.
    watch.knobs.refuseInstall = undefined;
    script.writeRefused = true;
    expect(await attempt("reviewer", "k3")).toEqual({ reason: "pty.write refused: pty_not_available" });
    expect(script.live.has("cli-reviewer")).toBe(false);
    expect(releases()).toBe(3);
    expect(watch.closes).toEqual(["cli:child-3:k3"]);
    expect(script.writes).toEqual([]);
    // The next send launches fresh: its first write into the pane is the exec launch line, and the letter follows
    // only after the child answered — no bare letter was ever typed into a shell without a launch.
    script.writeRefused = undefined;
    script.onWrite = (text) => {
      if (text.startsWith("exec ")) launchAnswer(script, watch, "child-4", "k4");
      if (text === "\r") {
        const known = watch.known(SENDER);
        const added = hookRows("child-4", "k4", [liveLine("UserPromptSubmit")], known);
        watch.push(SENDER, added);
        watch.push(SENDER, transcriptRows("child-4", "k4", "terminal", [...known, ...added]));
      }
    };
    expect(await runEffect(runner.run({ agent: "reviewer", message: "hello", sender: SENDER, turnId: "t", key: "k4" }))).toEqual({ child: "child-4", turn: "k4", facts: 2 });
    expect(script.writes[0]?.startsWith("exec ")).toBe(true);
    expect(script.writes).toEqual([
      launchLine({ argv: ["claude", "--session-id", "child-4", "--settings", "/work/.openomni/child-4/live.json"], env: {} }),
      "hello",
      "\r",
    ]);
    expect(script.live.has("cli-reviewer")).toBe(true);
    // r1 L4: the spool's export is the longest offered root containing the declared cwd, never a fabricated name.
    script.exports = [{ name: "work", path: "/work" }, { name: "deep", path: "/work/deep" }];
    script.onWrite = (text) => {
      if (text.startsWith("exec ")) {
        script.files.set("/work/deep/project/.openomni/child-5/spool.jsonl", `${liveLine("SessionStart")}\n`);
        watch.push(SENDER, hookRows("child-5", "k5", [liveLine("SessionStart")], watch.known(SENDER)));
      }
      if (text === "\r") {
        const known = watch.known(SENDER);
        const added = hookRows("child-5", "k5", [liveLine("UserPromptSubmit")], known);
        watch.push(SENDER, added);
        watch.push(SENDER, transcriptRows("child-5", "k5", "terminal", [...known, ...added]));
      }
    };
    expect(await runEffect(runner.run({ agent: "nested", message: "hello", sender: SENDER, turnId: "t", key: "k5" }))).toEqual({ child: "child-5", turn: "k5", facts: 2 });
    expect(watch.installs.at(-1)?.spool).toMatchObject({ export: "deep", path: "/work/deep/project/.openomni/child-5/spool.jsonl" });
  } finally {
    await runEffect(runner.close());
    plane.close();
  }
});

test("the runner never writes to a pane it did not launch, and every placement or daemon refusal is a typed reason before any write", async () => {
  const plane = declaredContact("reviewer", { dialect: DIALECT, machine: MACHINE, cwd: "/work" });
  for (const [id, machine] of [["remote", "m-2"], ["stale", "m-3"], ["full", "m-4"]] as const)
    plane.stores.instances.put({ id: cliContactRowId(id), provider: "cli", identity: "bot", enabled: true, settings: { dialect: DIALECT, machine }, revision: 0, createdBy: "owner", updatedAt: 1 });
  plane.stores.instances.put({ id: cliContactRowId("astray"), provider: "cli", identity: "bot", enabled: true, settings: { dialect: DIALECT, machine: MACHINE, cwd: "/elsewhere" }, revision: 0, createdBy: "owner", updatedAt: 1 });
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
    // r1 L4: a cwd outside every offered export is refused typed after placement and before any pane opens; the
    // lease goes straight back.
    script.live.clear();
    expect(await attempt("astray", "k4b")).toEqual({ reason: "cwd /elsewhere is outside every export machine m-1 offers (work=/work)" });
    expect(script.lease).toEqual(["release"]);
    // The daemon's own refusals: no pty surface, a cwd outside the exports (the lease is released again).
    script.listRefused = true;
    expect(await attempt("reviewer", "k5")).toEqual({ reason: "pty.list refused: pty_not_available" });
    script.listRefused = false;
    script.openRefused = true;
    expect(await attempt("reviewer", "k6")).toEqual({ reason: "pty.open refused: path_escapes_export" });
    expect(script.lease).toEqual(["release", "open:cli-reviewer", "release"]);
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
    // Without a committed-action subscription the first wait is a typed refusal, after the launch went out — and the
    // pane it launched is not kept (r1 H1).
    script.live.clear();
    script.onWrite = undefined;
    const silent = createCliRunner({ ...deps, id: testIds("quiet"), committed: () => undefined });
    expect(await runEffect(Effect.flip(silent.run({ agent: "reviewer", message: "hello", sender: SENDER, turnId: "t", key: "k2" })))).toEqual({
      reason: "the observation bus offers no subscription; a cli turn cannot be awaited",
    });
    expect(script.live.has("cli-reviewer")).toBe(false);
  } finally {
    plane.close();
  }
});

/**
 * The entity's arm verb as the alarm plane commits it (`entity-activation.ts`): the chain is `<session>:<purpose>`
 * unless the arm names one, the arm supersedes the chain's latest occurrence, and `Core.alarmDisposition` is the one
 * guard a delivered occurrence meets. Chains and arms are recorded for the assertions.
 */
function chainModel(sessionId: string) {
  const chains = new Map<string, { readonly occurrenceId: string; readonly at: number | null }>();
  const armed: { readonly alarmId: string; readonly occurrenceId: string; readonly supersedes: string | undefined; readonly at: number | null }[] = [];
  let seq = 0;
  const arm: Core.ArmVerb = (input) =>
    Effect.sync(() => {
      const alarmId = input.alarmId ?? `${sessionId}:${input.purpose}`;
      seq += 1;
      const occurrenceId = `${alarmId}:arm:${seq}`;
      armed.push({ alarmId, occurrenceId, supersedes: input.supersedes ?? chains.get(alarmId)?.occurrenceId, at: input.at });
      chains.set(alarmId, { occurrenceId, at: input.at });
      return { alarmId, occurrenceId, armSeq: seq };
    });
  const reads: Core.AlarmChainReads = { latestArm: (alarmId) => chains.get(alarmId), settled: () => false };
  return { arm, reads, armed };
}

test("#1512 r2 M2: each cli child's deadline rides its own chain — the first turn's retire leaves the second deadline armed, and its fire interrupts its own child only", async () => {
  const model = chainModel(SENDER);
  const armFor = (child: string, contact: string) =>
    runEffect(armDelegationDeadline(model.arm, { sessionId: SENDER, turnId: "turn-1", child, contact, at: 70_000 }));
  const first = await armFor("child-1", "cli:reviewer");
  await armFor("child-2", "cli:auditor");
  const [a, b] = model.armed;
  if (a === undefined || b === undefined) throw new Error("two arms expected");
  expect(a).toEqual({ alarmId: cliDeadlineChain(SENDER, "child-1"), occurrenceId: `${cliDeadlineChain(SENDER, "child-1")}:arm:1`, supersedes: undefined, at: 70_000 });
  expect(b).toEqual({ alarmId: cliDeadlineChain(SENDER, "child-2"), occurrenceId: `${cliDeadlineChain(SENDER, "child-2")}:arm:2`, supersedes: undefined, at: 70_000 });
  // The first turn ends: its retire is `at: null` on ITS chain, superseding its own occurrence — the second chain's
  // latest is still the second deadline, so that occurrence runs when it is delivered.
  await runEffect(first.retire);
  expect(model.armed[2]).toEqual({ alarmId: a.alarmId, occurrenceId: `${a.alarmId}:arm:3`, supersedes: a.occurrenceId, at: null });
  expect(Core.alarmDisposition(model.reads, a)).toEqual({ op: "skip", reason: "superseded" });
  expect(Core.alarmDisposition(model.reads, b)).toEqual({ op: "run" });
  // A session child keeps the #1258 session chain, where the second arm supersedes the first.
  await armFor("s-1", "session:s-1");
  await armFor("s-2", "session:s-2");
  const [s1, s2] = model.armed.slice(3);
  expect(s1).toMatchObject({ alarmId: `${SENDER}:${DELEGATION_DEADLINE}`, supersedes: undefined });
  expect(s2).toMatchObject({ alarmId: `${SENDER}:${DELEGATION_DEADLINE}`, supersedes: s1?.occurrenceId });
  // A refused arm or retire is the typed reason, never a thrown ArmRefused.
  const refusing: Core.ArmVerb = () => Effect.fail(new Core.ArmRefused({ code: "not_live" }));
  expect(await runEffect(Effect.flip(armDelegationDeadline(refusing, { sessionId: SENDER, turnId: "t", child: "c", contact: "cli:x", at: 1 })))).toEqual({ reason: "not_live" });
  let arms = 0;
  const refusingRetire: Core.ArmVerb = (input) => {
    arms += 1;
    return arms === 1 ? model.arm(input) : Effect.fail(new Core.ArmRefused({ code: "stale_activation" }));
  };
  const armedOnce = await runEffect(armDelegationDeadline(refusingRetire, { sessionId: SENDER, turnId: "t", child: "c", contact: "cli:x", at: 1 }));
  expect(await runEffect(Effect.flip(armedOnce.retire))).toEqual({ reason: "stale_activation" });

  // The runner side: two contacts on one sender, both turns running; the fire for child-2 writes ETX to ITS pane
  // alone, and child-1's turn runs on to its terminal.
  const plane = declaredContact("reviewer", { dialect: DIALECT, machine: MACHINE, cwd: "/work" });
  plane.stores.instances.put({ id: cliContactRowId("auditor"), provider: "cli", identity: "bot", enabled: true, settings: { dialect: DIALECT, machine: MACHINE, cwd: "/work" }, revision: 0, createdBy: "owner", updatedAt: 1 });
  const script: Scripted = { live: new Set(), files: new Map(), writes: [], execs: [], lease: [], targets: [] };
  const watch = scriptedWatch();
  const deadlines: string[] = [];
  const runner = createCliRunner({
    instances: plane.stores.instances,
    machineKnown: () => true,
    packs: [testPack],
    host: scriptedHost(script),
    watch: watch.ports,
    committed: watch.committed,
    deadline: (input) => Effect.sync(() => {
      deadlines.push(`${input.contact}:${input.child}`);
      return { retire: Effect.void };
    }),
    id: testIds("child"),
    now: () => 0,
  });
  const childOf = (name: string) => (name === "cli-reviewer" ? "child-1" : "child-2");
  const keyOf = (name: string) => (name === "cli-reviewer" ? "k1" : "k2");
  const enters = Promise.withResolvers<void>();
  let entered = 0;
  script.onWrite = (text, name) => {
    if (text.startsWith("exec ")) launchAnswer(script, watch, childOf(name), keyOf(name));
    if (text === "\r") {
      watch.push(SENDER, hookRows(childOf(name), keyOf(name), [liveLine("UserPromptSubmit")], watch.known(SENDER)));
      entered += 1;
      if (entered === 2) enters.resolve();
    }
  };
  try {
    const reviewer = runEffect(runner.run({ agent: "reviewer", message: "hello", sender: SENDER, turnId: "turn-1", key: "k1", deadlineMs: 60_000 }));
    const auditor = runEffect(Effect.flip(runner.run({ agent: "auditor", message: "hello", sender: SENDER, turnId: "turn-1", key: "k2", deadlineMs: 60_000 })));
    await enters.promise;
    expect(deadlines).toEqual(["cli:reviewer:child-1", "cli:auditor:child-2"]);
    expect(script.live).toEqual(new Set(["cli-reviewer", "cli-auditor"]));
    // The fire for child-2: one ETX, into cli-auditor; the waiting send ends `landed`.
    await runEffect(runner.interrupt("child-2"));
    expect(script.writes.filter((write) => write === "\u0003")).toHaveLength(1);
    expect(script.targets?.at(-1)).toBe("cli-auditor");
    expect(await auditor).toEqual({ reason: "deadline expired; the child was interrupted", landed: true });
    // child-1 was not touched: its turn ends on its own terminal, and only then is its deadline door closed.
    const known = watch.known(SENDER);
    watch.push(SENDER, transcriptRows("child-1", "k1", "terminal", known));
    expect(await reviewer).toEqual({ child: "child-1", turn: "k1", facts: 2 });
    expect(await runEffect(Effect.flip(runner.interrupt("child-1")))).toMatchObject({ code: "turn_already_ended" });
    expect(script.writes.filter((write) => write === "\u0003")).toHaveLength(1);
  } finally {
    await runEffect(runner.close());
    plane.close();
  }
});

test("#1512 r2 L8: the turn is ended before the deadline retire's await — an interrupt landing in that window is refused typed and writes no ETX", async () => {
  const plane = declaredContact("reviewer", { dialect: DIALECT, machine: MACHINE, cwd: "/work" });
  const script: Scripted = { live: new Set(), files: new Map(), writes: [], execs: [], lease: [] };
  const watch = scriptedWatch();
  // The retire blocks until the test releases it: the window between the observed terminal and the disarm's end.
  const retiring = Promise.withResolvers<() => void>();
  const runner = createCliRunner({
    instances: plane.stores.instances,
    machineKnown: () => true,
    packs: [testPack],
    host: scriptedHost(script),
    watch: watch.ports,
    committed: watch.committed,
    deadline: () =>
      Effect.succeed({
        retire: Effect.callback<void, never>((resume) => {
          retiring.resolve(() => resume(Effect.void));
        }),
      }),
    id: testIds("child"),
    now: () => 0,
  });
  script.onWrite = (text) => {
    if (text.startsWith("exec ")) launchAnswer(script, watch, "child-1", "k1");
    if (text === "\r") {
      const known = watch.known(SENDER);
      const added = hookRows("child-1", "k1", [liveLine("UserPromptSubmit")], known);
      watch.push(SENDER, added);
      watch.push(SENDER, transcriptRows("child-1", "k1", "terminal", [...known, ...added]));
    }
  };
  try {
    const run = runEffect(runner.run({ agent: "reviewer", message: "hello", sender: SENDER, turnId: "turn-1", key: "k1", deadlineMs: 60_000 }));
    // The retire is in flight: the terminal has been observed and the run has not resolved.
    const release = await retiring.promise;
    const writesAtTerminal = script.writes.length;
    expect(await runEffect(Effect.flip(runner.interrupt("child-1")))).toMatchObject({ code: "turn_already_ended" });
    expect(script.writes).toHaveLength(writesAtTerminal);
    expect(script.writes.at(-1)).toBe("\r");
    release();
    expect(await run).toEqual({ child: "child-1", turn: "k1", facts: 2 });
  } finally {
    await runEffect(runner.close());
    plane.close();
  }
});

test("#1512 r2 L9: the runner retains one turn per child whatever the number of sends, and the rows of turns it does not retain are dropped", async () => {
  const plane = declaredContact("reviewer", { dialect: DIALECT, machine: MACHINE, cwd: "/work" });
  const script: Scripted = { live: new Set(), files: new Map(), writes: [], execs: [], lease: [] };
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
  const send = (key: string) => runner.run({ agent: "reviewer", message: "hello", sender: SENDER, turnId: "t", key });
  /** The fake child answers the launch with SessionStart and every letter with an acknowledgement and the terminal. */
  const answer = (child: string, key: string) => {
    script.onWrite = (text) => {
      if (text.startsWith("exec ")) launchAnswer(script, watch, child, key);
      if (text === "\r") {
        const known = watch.known(SENDER);
        const added = hookRows(child, key, [liveLine("UserPromptSubmit")], known);
        watch.push(SENDER, added);
        watch.push(SENDER, transcriptRows(child, key, "terminal", [...known, ...added]));
      }
    };
  };
  try {
    expect(runner.retained()).toBe(0);
    for (const key of ["k1", "k2", "k3", "k4", "k5", "k6"]) {
      answer("child-1", key);
      expect(await runEffect(send(key))).toEqual({ child: "child-1", turn: key, facts: 2 });
      // One child, one retained turn — the latest — however many sends it has seen.
      expect(runner.retained()).toBe(1);
    }
    // The latest key still replays from the retained turn without typing.
    const writesBefore = script.writes.length;
    expect(await runEffect(send("k6"))).toEqual({ child: "child-1", turn: "k6", facts: 2 });
    expect(script.writes).toHaveLength(writesBefore);
    // Rows of a child this runner did not launch, in the same sender session, are read and dropped: nothing retained.
    watch.push(SENDER, hookRows("stranger", "x1", [liveLine("SessionStart"), liveLine("UserPromptSubmit")], watch.known(SENDER)));
    expect(await runEffect(Effect.flip(runner.interrupt("stranger")))).toEqual({ reason: "no cli child stranger is running" });
    expect(runner.retained()).toBe(1);
    // An older key left the registry with its turn: its replay is a NEW send — the letter is typed again (the
    // scripted child has nothing new to say about a turn it already ended, so the send stalls and the pane retires).
    script.onWrite = undefined;
    expect(await runEffect(Effect.flip(send("k5")))).toEqual({ reason: "prompt_stalled: no live observation within 20 ms" });
    expect(script.writes.slice(writesBefore)).toEqual(["hello", "\r"]);
    expect(runner.retained()).toBe(1);
    // The next send launches a second child: two children, two turns, no more.
    answer("child-2", "k8");
    expect(await runEffect(send("k8"))).toEqual({ child: "child-2", turn: "k8", facts: 2 });
    expect(runner.retained()).toBe(2);
    // The retired child's latest turn still answers the deadline door as ended, not unknown (r1 L1).
    expect(await runEffect(Effect.flip(runner.interrupt("child-1")))).toMatchObject({ code: "turn_already_ended" });
    // The cursor itself is one per sender session: paged forward once from 0, never rescanned.
    expect(watch.scans.filter((after) => after === 0)).toHaveLength(1);
  } finally {
    await runEffect(runner.close());
    plane.close();
  }
});

test("#1512 r2 L10: a letter the daemon refuses after a successful launch ends the turn and retires the pane — the next send launches fresh instead of answering agent_busy; a refusal after bytes landed says so", async () => {
  const plane = declaredContact("reviewer", { dialect: DIALECT, machine: MACHINE, cwd: "/work" });
  const script: Scripted = { live: new Set(), files: new Map(), writes: [], execs: [], lease: [] };
  const watch = scriptedWatch();
  const retired: string[] = [];
  const runner = createCliRunner({
    instances: plane.stores.instances,
    machineKnown: () => true,
    packs: [testPack],
    host: scriptedHost(script),
    watch: watch.ports,
    committed: watch.committed,
    deadline: (input) => Effect.succeed({ retire: Effect.sync(() => void retired.push(input.child)) }),
    id: testIds("child"),
    now: () => 0,
  });
  const send = (key: string) => runner.run({ agent: "reviewer", message: "hello", sender: SENDER, turnId: "t", key, deadlineMs: 60_000 });
  const releases = () => script.lease.filter((entry) => entry === "release").length;
  try {
    // The launch succeeds (SessionStart observed), then the daemon refuses the letter's first write.
    script.onWrite = (text) => {
      if (text.startsWith("exec ")) {
        launchAnswer(script, watch, "child-1", "k1");
        script.writeRefused = true;
      }
    };
    expect(await runEffect(Effect.flip(send("k1")))).toEqual({ reason: "pty.write refused: pty_not_available" });
    // Ended, disarmed, retired: the deadline door refuses typed, the session is closed, the lease released.
    expect(await runEffect(Effect.flip(runner.interrupt("child-1")))).toMatchObject({ code: "turn_already_ended" });
    expect(retired).toEqual(["child-1"]);
    expect(script.live.has("cli-reviewer")).toBe(false);
    expect(releases()).toBe(1);
    // The next send is not `agent_busy`: it launches a fresh child and runs to its terminal.
    script.writeRefused = undefined;
    script.onWrite = (text) => {
      if (text.startsWith("exec ")) launchAnswer(script, watch, "child-2", "k2");
      if (text === "\r") {
        const known = watch.known(SENDER);
        const added = hookRows("child-2", "k2", [liveLine("UserPromptSubmit")], known);
        watch.push(SENDER, added);
        watch.push(SENDER, transcriptRows("child-2", "k2", "terminal", [...known, ...added]));
      }
    };
    expect(await runEffect(send("k2"))).toEqual({ child: "child-2", turn: "k2", facts: 2 });
    expect(script.writes.filter((write) => write.startsWith("exec "))).toHaveLength(2);
    // The text reached the pane and the Enter was refused: the refusal carries `landed`, and the pane is retired
    // all the same — the letter sits unsubmitted in a pane this Resident will not write to again.
    script.onWrite = (text) => {
      if (text === "hello") script.writeRefused = true;
    };
    expect(await runEffect(Effect.flip(send("k3")))).toEqual({ reason: "pty.write refused: pty_not_available", landed: true });
    expect(script.live.has("cli-reviewer")).toBe(false);
    expect(retired).toEqual(["child-1", "child-2", "child-2"]);
  } finally {
    await runEffect(runner.close());
    plane.close();
  }
});
