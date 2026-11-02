/**
 * Agent-session conformance (#1629 P4): the prebuilt `mclient` debug binary
 * against the TypeScript machine host over a temporary Unix socket, with the
 * client's terminals on a private tmux server (`TMUX_TMPDIR` under the
 * fixture) and `claude` on PATH resolving to a fixture script.
 *
 * The run proves, in order, on one project (the client's single export):
 * the recorded claude-code transcript streams in source order and the same
 * cursor always yields the same page; a corrupt line becomes a typed
 * `corrupt` record per failure kind and an oversized line, or one line with
 * more records than a page holds, becomes a `truncated` record; the
 * transcript saved as plain file bytes plus its cursor and written back
 * after the client was killed and re-admitted resumes the SAME session id
 * from the saved cursor (never from byte zero), while a forged cursor or
 * one from another generation is refused (#1779); a launched claude-code
 * session opens at its prompt, before any transcript exists, tails as an
 * empty page at the origin until the first sent turn writes the transcript
 * (#1807); and a permission hook raised for that session is allowed only by
 * an explicit host grant, is refused `timeout` when the host's decision
 * misses its deadline, and the decision that arrives after that deadline
 * cannot turn into a grant. Waits are bus events, process exits, file
 * watches or the host decider's own signals under a bounded timeout;
 * nothing sleeps or polls.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Deferred, Effect } from "effect";
import { type BusEvent, Machine } from "../../../packages/protocol/src/index.js";
import {
  createMachineHost,
  createMemoryGenerationStore,
  type MachineHandle,
  MachineRefusalError,
} from "../../../packages/machines/src/index.js";
import { acquire, run } from "../../../packages/machines/test/ipc/helpers/effects.js";
import { permissionModule } from "./permission.js";

const CLI = "claude-code";
const FIXTURES = resolve(import.meta.dir, "../../../clients/machine-client/tests/fixtures/agent/claude");
const RECORDED = join(FIXTURES, "session.jsonl");
const LAUNCHED = join(FIXTURES, "launched.jsonl");
const SESSION = "0b6f6c55-6a4e-4c39-9d0e-6b1f3c1e2a7d";
/** Past the client's 256 KiB page so the line can never end inside one read. */
const OVERSIZED_BYTES = 300 * 1024;
/** More text parts on one line than one page carries. */
const WIDE_PARTS = Machine.AGENT_SESSION_MAX_RECORDS + 8;
/** The decision deadline under test; the host refuses `timeout` past it. */
const PERMISSION_DEADLINE_MS = 250;
const ALLOW_REQUEST = "call-allow";
const LATE_REQUEST = "call-late";
const HOOK_BLOCK_EXIT = 2;

/**
 * The `claude` the client launches, shaped like the real one: it shows its
 * prompt hint (styled, so the marker is split by escape sequences on the
 * wire) and waits for input; only the first turn writes the transcript,
 * whole, under the session id it was given; then it idles on stdin.
 */
const FAKE_CLAUDE = `#!/bin/sh
id=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --session-id) id=$2; shift 2 ;;
    *) shift ;;
  esac
done
printf '\\033[2m?\\033[0m\\033[2m for shortcuts\\033[0m\\r\\n'
read line || exit 0
dir="$HOME/.claude/projects/$(pwd -P | tr -c 'A-Za-z0-9\\n' '-' | tr -d '\\n')"
mkdir -p "$dir"
cat "$ONI_CONFORMANCE_LAUNCHED" > "$dir/$id.jsonl.part"
mv "$dir/$id.jsonl.part" "$dir/$id.jsonl"
echo transcript-written
exec cat > /dev/null
`;

export interface AgentFixture {
  readonly binary: string;
  readonly home: string;
  readonly root: string;
  readonly socket: string;
  readonly config: string;
  readonly env: Record<string, string | undefined>;
}

interface Attached {
  kill(signal: "SIGKILL"): void;
  readonly exited: Promise<number>;
}

interface EventLog {
  readonly sink: BusEvent.Sink;
  next(event: { readonly name: string }): Promise<void>;
}

/** The P3 runner's own helpers, injected so the two modules never import each other. */
export interface Harness<Client extends Attached> {
  check(condition: boolean, message: string): asserts condition;
  record(line: string): void;
  within<A>(promise: Promise<A>, label: string): Promise<A>;
  enroll(setup: AgentFixture): Promise<Machine.Enrollment>;
  eventLog(): EventLog;
  attach(setup: AgentFixture, attached: Promise<void>): Promise<Client>;
  stop(client: Client, detached: Promise<void>): Promise<void>;
  refusal(effect: Effect.Effect<object, MachineRefusalError | Error>): Promise<string>;
}

type Sessions = NonNullable<MachineHandle["agentSession"]>;
type Records = readonly Machine.AgentTranscriptRecord[];
type Page = Extract<Machine.AgentSessionTailResult, { status: "ok" }>;

/** The transcript as the bytes on disk plus the cursor to resume from: no bundle store, no checkpoint. */
interface Saved {
  readonly path: string;
  readonly bytes: Buffer;
  readonly cursor: Machine.AgentSessionCursor;
}

interface Signal {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function signal(): Signal {
  const { promise, resolve: done } = Promise.withResolvers<void>();
  return { promise, resolve: () => done() };
}

/** Resolves once `path` exists; the watch is live before the caller acts. */
function appearance(path: string): Promise<void> {
  const directory = resolve(path, "..");
  mkdirSync(directory, { recursive: true });
  const { promise, resolve: done, reject } = Promise.withResolvers<void>();
  const watcher = watch(directory, (_event, name) => {
    if (name === basename(path) && existsSync(path)) {
      watcher.close();
      done();
    }
  });
  watcher.on("error", (error) => {
    watcher.close();
    reject(error);
  });
  return promise;
}

function same(left: object, right: object): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function output(child: {
  readonly exited: Promise<number>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
}): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

export function agentConformance<Client extends Attached>(
  harness: Harness<Client>,
): (setup: AgentFixture) => Promise<void> {
  const check: Harness<Client>["check"] = harness.check;
  const { record, within } = harness;

  /** Write an executable through a `/bin/sh` child, never a descriptor this process holds. */
  async function script(path: string, text: string): Promise<void> {
    const writer = Bun.spawn(["/bin/sh", "-c", 'cat > "$1" && chmod 700 "$1"', "sh", path], {
      stdin: new Blob([text]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const written = await within(output(writer), "fixture script writer");
    check(written.code === 0, `writing ${path} exited ${written.code}: ${written.stderr}`);
  }

  async function tail(sessions: Sessions, request: Machine.AgentSessionTailRequest): Promise<Page> {
    const page = await run(sessions.tail(request));
    check(page.status === "ok", `tail answered ${JSON.stringify(page)}`);
    return page;
  }

  async function streamsInOrder(sessions: Sessions, project: string, transcript: string): Promise<Page> {
    const opened = await run(sessions.open({ project, cli: CLI, sessionId: SESSION }));
    check(
      opened.status === "ok" && opened.cursor.sessionId === SESSION && opened.cursor.byteOffset === 0,
      `open adopted answered ${JSON.stringify(opened)}`,
    );
    const first = await tail(sessions, { sessionId: SESSION });
    check(
      same(first.records, [
        { kind: "turn", role: "user", text: "hello" },
        { kind: "tool_call", callId: "call-1", name: "read", input: '{"path":"README.md"}' },
        { kind: "tool_result", callId: "call-1", output: "contents", failed: false },
      ]),
      `recorded transcript streamed ${JSON.stringify(first.records)}`,
    );
    check(
      !first.hasMore && first.cursor.byteOffset === readFileSync(transcript).length,
      `first page ends at ${first.cursor.byteOffset}, hasMore=${first.hasMore}`,
    );
    const again = await tail(sessions, { cursor: opened.cursor });
    check(same(again, first), "the origin cursor yielded a different page");
    const idle = await tail(sessions, { cursor: first.cursor });
    check(idle.records.length === 0 && same(idle.cursor, first.cursor), "the end cursor moved without new bytes");
    const listed = await run(sessions.list({ project }));
    check(
      listed.status === "ok" && listed.sessions.some((session) => session.sessionId === SESSION),
      `list misses the adopted session: ${JSON.stringify(listed)}`,
    );
    record(
      `claude-code transcript adopted as ${SESSION}: 3 records in source order, cursor ${first.cursor.byteOffset} stable on re-read`,
    );
    return first;
  }

  function damagedLines(): Buffer {
    const wide = {
      type: "assistant",
      message: {
        role: "assistant",
        content: Array.from({ length: WIDE_PARTS }, (_, index) => ({ type: "text", text: `part-${index}` })),
      },
    };
    return Buffer.concat([
      Buffer.from([0xff, 0xfe, 0x0a]),
      Buffer.from('{"type":\n'),
      Buffer.from('{"type":"mystery"}\n'),
      Buffer.from(`${"x".repeat(OVERSIZED_BYTES)}\n`),
      Buffer.from(`${JSON.stringify(wide)}\n`),
      Buffer.from('{"type":"user","message":{"role":"user","content":"after"}}\n'),
    ]);
  }

  async function typedDamage(sessions: Sessions, transcript: string, from: Page): Promise<{ readonly resume: Page; readonly rest: Records }> {
    writeFileSync(transcript, damagedLines(), { flag: "a" });
    const corrupt = await tail(sessions, { cursor: from.cursor });
    check(
      same(
        corrupt.records.map((entry) => (entry.kind === "corrupt" ? entry.reason : entry.kind)),
        ["invalid_encoding", "invalid_shape", "unsupported_record"],
      ) && corrupt.hasMore,
      `corrupt page ${JSON.stringify(corrupt.records)} hasMore=${corrupt.hasMore}`,
    );
    const oversized = await tail(sessions, { cursor: corrupt.cursor });
    const [cut] = oversized.records;
    check(
      oversized.records.length === 1 && cut?.kind === "truncated" && cut.originalBytes === OVERSIZED_BYTES + 1,
      `oversized line answered ${JSON.stringify(oversized.records.map((entry) => entry.kind))}`,
    );
    const wide = await tail(sessions, { cursor: oversized.cursor });
    check(
      wide.records.length === Machine.AGENT_SESSION_MAX_RECORDS &&
        wide.records.at(-1)?.kind === "truncated" &&
        wide.records.slice(0, -1).every((entry) => entry.kind === "turn"),
      `wide line answered ${wide.records.length} records ending ${wide.records.at(-1)?.kind}`,
    );
    const after = await tail(sessions, { cursor: wide.cursor });
    check(
      same(after.records, [{ kind: "turn", role: "user", text: "after" }]) && !after.hasMore,
      `stream after the damage answered ${JSON.stringify(after.records)}`,
    );
    record(
      `damaged lines typed: corrupt invalid_encoding/invalid_shape/unsupported_record, truncated ${OVERSIZED_BYTES + 1}-byte line, ${WIDE_PARTS}-part line cut to ${Machine.AGENT_SESSION_MAX_RECORDS} ending truncated`,
    );
    return { resume: oversized, rest: [...wide.records, ...after.records] };
  }

  function saveSession(home: string, transcript: string, cursor: Machine.AgentSessionCursor): Saved {
    const path = transcript.slice(home.length + 1);
    const bytes = readFileSync(transcript);
    record(`saved ${path} as ${bytes.length} plain bytes, cursor byte ${cursor.byteOffset}`);
    return { path, bytes, cursor };
  }

  function importSession(home: string, saved: Saved): void {
    mkdirSync(resolve(home, saved.path, ".."), { recursive: true });
    writeFileSync(join(home, saved.path), saved.bytes);
  }

  async function resumes(sessions: Sessions, project: string, saved: Saved, rest: Records): Promise<void> {
    const reopened = await run(sessions.open({ project, cli: CLI, sessionId: SESSION }));
    check(
      reopened.status === "ok" && reopened.cursor.sessionId === SESSION && reopened.cursor.generation === saved.cursor.generation,
      `reopen after import answered ${JSON.stringify(reopened)}`,
    );
    const wide = await tail(sessions, { cursor: saved.cursor });
    const after = await tail(sessions, { cursor: wide.cursor });
    check(
      saved.cursor.byteOffset > 0 && same([...wide.records, ...after.records], rest),
      `resume from byte ${saved.cursor.byteOffset} streamed ${JSON.stringify(wide.records.slice(0, 2))}`,
    );
    const forged = await run(sessions.tail({ cursor: { ...saved.cursor, recordHash: "0".repeat(64) } }));
    check(forged.status === "refused" && forged.reason === "invalid_cursor", `forged cursor answered ${JSON.stringify(forged)}`);
    const stale = await harness.refusal(sessions.tail({ cursor: { ...saved.cursor, generation: saved.cursor.generation + 1 } }));
    check(stale === "stale_generation", `cursor from another generation refused ${stale}`);
    record(
      `after kill + re-admission the imported ${SESSION} resumed from byte ${saved.cursor.byteOffset}, not 0; forged cursor invalid_cursor, foreign-generation cursor stale_generation`,
    );
  }

  async function hook(setup: AgentFixture, sessionId: string, requestId: string) {
    const input = JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: sessionId,
      tool_use_id: requestId,
      tool_name: "Bash",
      tool_input: { command: "true" },
    });
    const child = Bun.spawn([setup.binary, "hook", "permission", "--cli", CLI], {
      env: setup.env,
      stdin: new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
    });
    return await within(output(child), `permission hook ${requestId}`);
  }

  async function opensAtPrompt(sessions: Sessions, setup: AgentFixture, project: string): Promise<string> {
    const launched = await run(sessions.open({ project, cli: CLI }));
    check(launched.status === "ok" && launched.cursor.sessionId !== SESSION, `launch answered ${JSON.stringify(launched)}`);
    const sessionId = launched.cursor.sessionId;
    const transcript = join(setup.home, ".claude", "projects", project.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
    check(!existsSync(transcript), `open waited for the transcript ${transcript} instead of the prompt`);
    const empty = await tail(sessions, { sessionId });
    check(
      empty.records.length === 0 && !empty.hasMore && same(empty.cursor, launched.cursor),
      `tail before the first turn answered ${JSON.stringify(empty)}`,
    );
    const appeared = appearance(transcript);
    const sent = await run(sessions.send({ sessionId, text: "go" }));
    check(sent.status === "ok", `send at the prompt answered ${JSON.stringify(sent)}`);
    await within(appeared, "transcript written by the first turn");
    const first = await tail(sessions, { cursor: empty.cursor });
    check(same(first.records, [{ kind: "turn", role: "user", text: "launched" }]), `launched transcript ${JSON.stringify(first.records)}`);
    record(
      `launched ${sessionId} opened at its prompt with no transcript: tail was an empty page at byte 0; after send the transcript appeared and tailed 1 record from that cursor`,
    );
    return sessionId;
  }

  async function permissionBridge(sessions: Sessions, setup: AgentFixture, sessionId: string, decisions: Decider): Promise<void> {
    const allowed = await hook(setup, sessionId, ALLOW_REQUEST);
    check(
      allowed.code === 0 && allowed.stdout.includes('"permissionDecision":"allow"'),
      `explicit grant answered exit ${allowed.code}: ${allowed.stdout}${allowed.stderr}`,
    );
    const pending = hook(setup, sessionId, LATE_REQUEST);
    await within(decisions.asked.promise, "host decider asked");
    const blocked = await pending;
    check(
      blocked.code === HOOK_BLOCK_EXIT && blocked.stdout === "" && blocked.stderr.includes("permission refused (timeout)"),
      `timed-out request answered exit ${blocked.code}: ${blocked.stdout}${blocked.stderr}`,
    );
    await within(decisions.interrupted.promise, "decider interrupted at the deadline");
    const delivered = await run(Deferred.succeed(decisions.late, { status: "allowed", sessionId, requestId: LATE_REQUEST }));
    check(delivered, "the late grant had already been consumed");
    const stopped = await run(sessions.stop({ sessionId }));
    check(stopped.status === "ok", `stop answered ${JSON.stringify(stopped)}`);
    record(
      `launched ${sessionId}: explicit grant allowed (hook exit 0); decision past ${PERMISSION_DEADLINE_MS} ms refused timeout (hook exit ${HOOK_BLOCK_EXIT}), decider interrupted, the late allow reached no waiter`,
    );
  }

  interface Decider {
    readonly asked: Signal;
    readonly interrupted: Signal;
    readonly late: Deferred.Deferred<Machine.AgentPermissionDecision>;
    decide(machineId: string, request: Machine.AgentPermissionRequest): Effect.Effect<Machine.AgentPermissionDecision>;
  }

  async function decider(): Promise<Decider> {
    const asked = signal();
    const interrupted = signal();
    const late = await run(Deferred.make<Machine.AgentPermissionDecision>());
    const allow = (request: Machine.AgentPermissionRequest): Machine.AgentPermissionDecision => ({
      status: "allowed",
      sessionId: request.sessionId,
      requestId: request.requestId,
    });
    return {
      asked,
      interrupted,
      late,
      decide: (_machineId, request) =>
        request.requestId === ALLOW_REQUEST
          ? Effect.succeed(allow(request))
          : Effect.sync(asked.resolve).pipe(
              Effect.andThen(Deferred.await(late)),
              Effect.onInterrupt(() => Effect.sync(interrupted.resolve)),
            ),
    };
  }

  return async (base) => {
    const scratch = resolve(base.home, "..");
    const bin = join(scratch, "bin");
    mkdirSync(bin);
    await script(join(bin, "claude"), FAKE_CLAUDE);
    // The launched CLI runs in a login shell, whose /etc/profile may reorder
    // the inherited PATH (macOS path_helper puts /etc/paths.d entries such as
    // a package manager's bin first); the fixture home's profile puts the
    // fixture bin back in front so `claude` is the script above, never an
    // installed one.
    writeFileSync(join(base.home, ".profile"), `PATH='${bin}':$PATH\nexport PATH\n`);
    await permissionModule({ check, record, script }, scratch);
    const setup: AgentFixture = {
      ...base,
      env: {
        ...base.env,
        PATH: `${bin}:${base.env.PATH ?? ""}`,
        SHELL: "/bin/sh",
        // A private tmux server: panes inherit this fixture's HOME and PATH,
        // never a long-lived default server started under another environment.
        TMUX_TMPDIR: scratch,
        ONI_CONFORMANCE_LAUNCHED: LAUNCHED,
      },
    };
    // The receipt from the ordinary join is enrolled unmodified.
    const enrollment: Machine.Enrollment = await harness.enroll(setup);
    check(
      enrollment.allowedCapabilities.includes("agent.session"),
      `join did not enroll agent.session: ${JSON.stringify(enrollment.allowedCapabilities)}`,
    );
    const events = harness.eventLog();
    const decisions = await decider();
    const acquired = await acquire(
      createMachineHost({
        listen: { unix: setup.socket },
        id: () => `conformance-${crypto.randomUUID()}`,
        dispatcherBound: 64,
        enrollment: (id) => (id === enrollment.machineId ? enrollment : undefined),
        generations: createMemoryGenerationStore(),
        events: events.sink,
        now: Date.now,
        callTool: () => Effect.fail(new MachineRefusalError({ reason: "host_tool_missing", message: "conformance host has no tool port" })),
        decideAgentPermission: decisions.decide,
        agentPermissionDeadlineMs: PERMISSION_DEADLINE_MS,
      }),
    );
    const host = acquired.value;
    try {
      const client = await harness.attach(setup, events.next(Machine.Events.Attached));
      const [info] = host.list();
      check(info?.capabilities.includes("agent.session") === true, `agent.session not negotiated: ${JSON.stringify(info?.capabilities)}`);
      const sessions = host.get(info.machineId).agentSession;
      check(sessions !== undefined, "host handle has no agentSession");
      const project = setup.root;
      const transcript = join(setup.home, ".claude", "projects", project.replace(/[^A-Za-z0-9]/g, "-"), `${SESSION}.jsonl`);
      mkdirSync(resolve(transcript, ".."), { recursive: true });
      writeFileSync(transcript, readFileSync(RECORDED));
      const end = await streamsInOrder(sessions, project, transcript);
      const { resume, rest } = await typedDamage(sessions, transcript, end);
      const saved = saveSession(setup.home, transcript, resume.cursor);
      await harness.stop(client, events.next(Machine.Events.Detached));
      rmSync(join(setup.home, ".claude"), { recursive: true, force: true });
      rmSync(join(setup.home, ".oni", "machine-client", "agent-sessions.json"), { force: true });
      importSession(setup.home, saved);
      await harness.attach(setup, events.next(Machine.Events.Attached));
      check(host.list()[0]?.generation === saved.cursor.generation, "the reconnect was not re-admitted on the cursor's generation");
      await resumes(sessions, project, saved, rest);
      const launched = await opensAtPrompt(sessions, setup, project);
      await permissionBridge(sessions, setup, launched, decisions);
    } finally {
      await acquired.close();
      await output(Bun.spawn(["tmux", "kill-server"], { env: setup.env, stdout: "pipe", stderr: "pipe" }));
    }
  };
}
