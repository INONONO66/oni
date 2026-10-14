import { Core } from "@openomni/agent";
const defineTool = Core.defineTool;
const ToolRefused = Core.ToolRefused;
import { z } from "zod";
import { Machine } from "@openomni/protocol";
import { parseLocus } from "../locus/index";
import { defaultMachineOf, fileOperation, type FilePorts } from "../core/filesystem";

const Input = z
  .object({
    command: z.string().describe("Shell command. With session it is typed into the terminal; empty reads pending session output."),
    machine: z.string().min(1).optional(),
    cwd: z
      .string()
      .min(1)
      .optional()
      .describe("Absolute working directory inside an offered export; defaults to /."),
    session: Machine.PtySessionName.optional().describe(
      "Named persistent terminal on the machine. Survives between calls and daemon restarts; same name reattaches.",
    ),
  })
  .strict();

const Output = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  truncated: z.boolean(),
  pending: z.boolean(),
});

/**
 * Every command runs on a machine daemon (#1271): the named machine, or the
 * configured default when `machine` is omitted. There is no process-local
 * execution path; the daemon bounds execution time and confines cwd to its
 * offered exports.
 */
function machineTarget(machine: string, cwd: string, ports: FilePorts) {
  const locus = parseLocus(`${machine}:${cwd}`, { defaultMachine: machine });
  if (locus.machine !== machine || locus.path !== cwd)
    throw new ToolRefused("bash", "expected a plain machine id and an absolute cwd");
  const target = ports.machines?.get(locus.machine);
  if (target === undefined) throw new ToolRefused("bash", "machine host is not configured");
  return { target, cwd: locus.path };
}

async function machineBash(args: z.output<typeof Input>, ports: FilePorts) {
  const { target, cwd } = machineTarget(args.machine ?? defaultMachineOf(ports), args.cwd ?? "/", ports);
  const result = await target.exec(args.command, cwd);
  if (result.status !== "completed")
    throw new ToolRefused("bash", result.status === "refused" ? result.reason : result.status);
  return {
    stdout: Buffer.from(result.stdout).toString("utf8"),
    stderr: Buffer.from(result.stderr).toString("utf8"),
    exitCode: result.exitCode,
    signal: result.signal,
    truncated: result.truncated,
    pending: false,
  };
}

/** Long-poll quantum: each round waits for output events, never spins. */
const SESSION_DRAIN_WAIT_MS = 600;
const SESSION_DRAIN_DEADLINE_MS = 20_000;

type SessionRefusal = { readonly status: "refused"; readonly reason: string };
function refusedSession(result: SessionRefusal): never {
  throw new ToolRefused("bash", result.reason);
}

class SessionInvalidExitCode extends ToolRefused {
  constructor() {
    super("bash", "session command sentinel contained a non-numeric exit code");
    this.name = "SessionInvalidExitCode";
  }
}

class SessionBusy extends ToolRefused {
  constructor() {
    super("bash", "session command is still pending; use an empty command to drain it");
    this.name = "SessionBusy";
  }
}

type SessionReadPort = (
  cursor: string,
  waitMs: number,
) => Promise<
  | { readonly status: "ok"; readonly data: Uint8Array; readonly cursor: string; readonly truncated: boolean }
  | { readonly status: "refused"; readonly reason: string }
>;
// OSC (title, bracketed-paste markers) and CSI (cursor, colour) sequences carry no command output.
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape bytes are the subject
const oscSequence = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape bytes are the subject
const csiSequence = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const normalizeTerminalText = (text: string) =>
  text.replace(oscSequence, "").replace(csiSequence, "").replaceAll("\r", "");

function stripEchoedCommand(text: string, command: string, sentinel: string): string {
  const normalized = normalizeTerminalText(text);
  let cleaned = normalized;
  for (const line of [...(command.length > 0 ? command.split("\n") : []), sentinel]) {
    const at = cleaned.indexOf(`${line}\n`);
    if (at >= 0) cleaned = `${cleaned.slice(0, at)}${cleaned.slice(at + line.length + 1)}`;
    else if (cleaned.endsWith(line)) cleaned = cleaned.slice(0, -line.length);
  }
  return cleaned;
}

/** Holds back a trailing partial line that could still be the echoed command or the sentinel, so it is never delivered twice. */
function deliverablePrefix(text: string, pending: PendingSentinel): string {
  const lastLine = normalizeTerminalText(text).split("\n").at(-1) ?? "";
  const fragment = lastLine.trimStart();
  if (
    fragment.length > 0 &&
    (pending.nonce.startsWith(fragment) ||
      fragment.startsWith(pending.nonce) ||
      pending.command.startsWith(fragment) ||
      pending.sentinel.includes(fragment))
  ) {
    return text.slice(0, text.lastIndexOf("\n") + 1);
  }
  return text;
}

function markerLine(text: string, marker: string): { readonly prefix: string; readonly suffix: string } | undefined {
  const lines = normalizeTerminalText(text).split("\n");
  const line = lines.findIndex(
    (candidate, index) => index < lines.length - 1 && candidate.trimStart().startsWith(marker),
  );
  if (line < 0) return undefined;
  const found = lines[line];
  if (found === undefined) return undefined;
  const markerAt = found.indexOf(marker);
  return { prefix: lines.slice(0, line).join("\n"), suffix: found.slice(markerAt + marker.length) };
}

type SessionMarkerResult = {
  readonly prefix: string;
  readonly suffix: string;
  readonly cursor: string;
  readonly truncated: boolean;
  readonly pending: boolean;
  readonly output: string;
};

async function readUntilMarker(
  read: SessionReadPort,
  cursor: string,
  marker: string,
  previous: string,
  onCursor: (next: string) => void,
): Promise<SessionMarkerResult> {
  let output = previous;
  let nextCursor = cursor;
  let truncated = false;
  const deadline = Date.now() + SESSION_DRAIN_DEADLINE_MS;
  while (Date.now() < deadline) {
    const view = await read(nextCursor, Math.min(SESSION_DRAIN_WAIT_MS, Math.max(1, deadline - Date.now())));
    if (view.status !== "ok") refusedSession(view);
    nextCursor = view.cursor;
    onCursor(nextCursor);
    truncated = truncated || view.truncated;
    output += Buffer.from(view.data).toString("utf8");
    const found = markerLine(output, marker);
    if (found !== undefined) return { ...found, cursor: nextCursor, truncated, pending: false, output };
  }
  return { prefix: output, suffix: "", cursor: nextCursor, truncated, pending: true, output };
}

type PendingSentinel = {
  nonce: string;
  command: string;
  sentinel: string;
  output: string;
  delivered: string;
  readiness: boolean;
  truncated: boolean;
};
type SessionState = { cursor: string; pending?: PendingSentinel };
type SessionTarget = ReturnType<typeof machineTarget>["target"];

/** Writes the command (if any) and a sentinel line whose nonce is split across printf arguments so the echo never contains it. */
async function writeSession(
  target: SessionTarget,
  session: string,
  state: SessionState,
  command: string,
  readiness: boolean,
): Promise<PendingSentinel> {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const half = nonce.length / 2;
  const halves = `'${nonce.slice(0, half)}' '${nonce.slice(half)}'`;
  const sentinel = readiness
    ? `printf '%s%s\\n' ${halves}`
    : `printf '%s%s %s\\n' ${halves} "$?"`;
  const written = await target.pty.write(session, Buffer.from(`${readiness ? "" : `${command}\n`}${sentinel}\n`, "utf8"));
  if (written.status !== "ok") refusedSession(written);
  state.pending = { nonce, command, sentinel, output: "", delivered: "", readiness, truncated: false };
  return state.pending;
}

async function drainSession(target: SessionTarget, session: string, state: SessionState, pending: PendingSentinel) {
  const result = await readUntilMarker(
    (cursor, waitMs) => target.pty.read(session, { cursor, waitMs }),
    state.cursor,
    pending.nonce,
    pending.output,
    (next) => { state.cursor = next; },
  );
  pending.output = result.output;
  pending.truncated ||= result.truncated;
  const prefix = result.pending ? deliverablePrefix(result.prefix, pending) : result.prefix;
  const cleaned = stripEchoedCommand(prefix, pending.command, pending.sentinel);
  const stdout = cleaned.slice(pending.delivered.length);
  pending.delivered = cleaned;
  if (result.pending) return { stdout, stderr: "", exitCode: null, signal: null, truncated: pending.truncated, pending: true };
  state.pending = undefined;
  if (pending.readiness) return { stdout, stderr: "", exitCode: null, signal: null, truncated: pending.truncated, pending: false };
  const suffix = result.suffix.trim();
  if (!/^\d+$/.test(suffix)) throw new SessionInvalidExitCode();
  return { stdout, stderr: "", exitCode: Number(suffix), signal: null, truncated: pending.truncated, pending: false };
}

/**
 * First touch of a session in this process: open (reattach-or-create under
 * the daemon's export confinement) and synchronize with the shell using a
 * readiness nonce, so a fresh shell cannot swallow the first real command.
 * A command whose sentinel has not arrived by the deadline stays pending;
 * later calls keep draining it, and a new command is refused until then.
 */
async function sessionBash(args: z.output<typeof Input>, ports: FilePorts, sessions: Map<string, SessionState>) {
  const session = args.session ?? "";
  const machine = args.machine ?? "";
  const { target } = machineTarget(machine, "/", ports);
  const key = `${machine}:${session}`;
  let state = sessions.get(key);
  const fresh = state === undefined;
  if (state === undefined) {
    const opened = await target.pty.open(session, "/");
    if (opened.status !== "ok") refusedSession(opened);
    state = { cursor: opened.cursor };
    sessions.set(key, state);
    await writeSession(target, session, state, "", true);
  }
  if (state.pending !== undefined && !fresh && args.command.length > 0) throw new SessionBusy();
  let readinessOutput = "";
  let readinessTruncated = false;
  if (state.pending !== undefined) {
    const reading = state.pending.readiness;
    const result = await drainSession(target, session, state, state.pending);
    if (result.pending || !reading || args.command.length === 0) return result;
    readinessOutput = result.stdout;
    readinessTruncated = result.truncated;
  }
  if (args.command.length > 0) {
    const pending = await writeSession(target, session, state, args.command, false);
    const result = await drainSession(target, session, state, pending);
    return { ...result, stdout: readinessOutput + result.stdout, truncated: readinessTruncated || result.truncated };
  }
  const view = await target.pty.read(session, { cursor: state.cursor, waitMs: SESSION_DRAIN_WAIT_MS });
  if (view.status !== "ok") refusedSession(view);
  state.cursor = view.cursor;
  return {
    stdout: normalizeTerminalText(Buffer.from(view.data).toString("utf8")),
    stderr: "",
    exitCode: null,
    signal: null,
    truncated: view.truncated,
    pending: false,
  };
}

function routeBash(args: z.output<typeof Input>, ports: FilePorts, sessions: Map<string, SessionState>) {
  if (args.session !== undefined) {
    if (args.machine === undefined) throw new ToolRefused("bash", "session requires machine: persistent terminals live on the daemon");
    if (args.cwd !== undefined) throw new ToolRefused("bash", "cwd applies to one-shot commands; sessions open at /");
    return sessionBash(args, ports, sessions);
  }
  if (args.command.length === 0) throw new ToolRefused("bash", "command is required without session");
  return machineBash(args, ports);
}

export function createBashTool(ports: FilePorts) {
  /** Session read positions and unfinished sentinel; neither is model-managed. */
  const sessions = new Map<string, SessionState>();
  return defineTool({
    name: "bash",
    description:
      "Run a shell command on a machine daemon: the named machine, or the configured default when machine is omitted. cwd must be an absolute path inside an offered export (default /). Execution time is bounded by the daemon. No persistent cwd state. With machine+session, the command is typed into a named persistent terminal (survives daemon restarts; same session name reattaches) and stdout carries terminal output since the previous call; an empty command just reads.",
    category: "execution",
    sequential: true,
    input: Input,
    output: Output,
    visibility: { model: ["resident", "child"], cell: ["resident", "child"] },
    execute: (args, ctx) =>
      fileOperation("bash", () => {
        ctx.signal.throwIfAborted();
        return routeBash(args, ports, sessions);
      }),
    render: (_args, value) => JSON.stringify(value),
  });
}
