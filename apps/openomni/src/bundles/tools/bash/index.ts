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
  };
}

/** Long-poll quantum: each round waits for output events, never spins. */
const SESSION_DRAIN_WAIT_MS = 600;
// Bound on rounds, not time. A quiet read is only a long-poll timeout; the
// nonce, not quietness, decides when a command has completed.
const SESSION_DRAIN_ROUNDS = 32;

type SessionTarget = ReturnType<typeof machineTarget>["target"];
type SessionRefusal = { readonly status: "refused"; readonly reason: string };
function refusedSession(result: SessionRefusal): never {
  throw new ToolRefused("bash", result.reason);
}

export class SessionIncomplete extends ToolRefused {
  constructor(stage: "readiness" | "command") {
    super("bash", `session ${stage} did not reach its nonce before the drain round cap`);
    this.name = "SessionIncomplete";
  }
}

type SessionReadPort = (
  cursor: string,
  waitMs: number,
) => Promise<
  | { readonly status: "ok"; readonly data: Uint8Array; readonly cursor: string; readonly truncated: boolean }
  | { readonly status: "refused"; readonly reason: string }
>;
const normalizeTerminalText = (text: string) => text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");

function stripEchoedCommand(text: string, command: string): string {
  const normalized = normalizeTerminalText(text);
  const echoed = `${command}\n`;
  const at = normalized.indexOf(echoed);
  return at < 0 ? normalized : `${normalized.slice(0, at)}${normalized.slice(at + echoed.length)}`;
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

export type SessionMarkerResult = {
  readonly prefix: string;
  readonly suffix: string;
  readonly cursor: string;
  readonly truncated: boolean;
};

export async function readUntilMarker(
  read: SessionReadPort,
  cursor: string,
  marker: string,
  stage: "readiness" | "command",
  onCursor?: (next: string) => void,
): Promise<SessionMarkerResult> {
  let output = "";
  let nextCursor = cursor;
  let truncated = false;
  for (let round = 0; round < SESSION_DRAIN_ROUNDS; round += 1) {
    const view = await read(nextCursor, SESSION_DRAIN_WAIT_MS);
    if (view.status !== "ok") refusedSession(view);
    nextCursor = view.cursor;
    onCursor?.(nextCursor);
    truncated = truncated || view.truncated;
    output += Buffer.from(view.data).toString("utf8");
    const found = markerLine(output, marker);
    if (found !== undefined) return { ...found, cursor: nextCursor, truncated };
  }
  throw new SessionIncomplete(stage);
}

/**
 * First touch of a session in this process: open (reattach-or-create under
 * the daemon's export confinement) and synchronize with the shell using a
 * nonce. Writing the nonce before any command prevents a fresh shell from
 * swallowing the first real command during startup.
 */
async function openSessionCursor(
  target: SessionTarget,
  session: string,
  sink: Buffer[],
  onCursor: (cursor: string) => void,
) {
  const opened = await target.pty.open(session, "/");
  if (opened.status !== "ok") refusedSession(opened);
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const ready = `printf '${nonce}\\n'`;
  const written = await target.pty.write(session, Buffer.from(`${ready}\n`, "utf8"));
  if (written.status !== "ok") refusedSession(written);
  const result = await readUntilMarker(
    (cursor, waitMs) => target.pty.read(session, { cursor, waitMs }),
    opened.cursor,
    nonce,
    "readiness",
    onCursor,
  );
  sink.push(Buffer.from(stripEchoedCommand(result.prefix, ready), "utf8"));
  return { cursor: result.cursor, truncated: result.truncated };
}

async function sessionBash(args: z.output<typeof Input>, ports: FilePorts, cursors: Map<string, string>) {
  const session = args.session ?? "";
  const machine = args.machine ?? "";
  const { target } = machineTarget(machine, "/", ports);
  const key = `${machine}:${session}`;
  const chunks: Buffer[] = [];
  let truncated = false;
  let cursor = cursors.get(key);
  if (cursor === undefined) {
    const openedState = await openSessionCursor(target, session, chunks, (next) => cursors.set(key, next));
    cursor = openedState.cursor;
    truncated = openedState.truncated;
  }
  if (args.command.length > 0) {
    const nonce = crypto.randomUUID().replaceAll("-", "");
    const command = `${args.command}; printf '\\n${nonce}:%s\\n' $?`;
    const written = await target.pty.write(session, Buffer.from(`${command}\n`, "utf8"));
    if (written.status !== "ok") refusedSession(written);
    const result = await readUntilMarker(
      (nextCursor, waitMs) => target.pty.read(session, { cursor: nextCursor, waitMs }),
      cursor,
      `${nonce}:`,
      "command",
      (next) => cursors.set(key, next),
    );
    cursor = result.cursor;
    truncated = truncated || result.truncated;
    chunks.push(Buffer.from(stripEchoedCommand(result.prefix, command), "utf8"));
    const exitCode = Number.parseInt(result.suffix, 10);
    if (!Number.isInteger(exitCode)) throw new SessionIncomplete("command");
    cursors.set(key, cursor);
    return {
      stdout: Buffer.concat(chunks).toString("utf8"),
      stderr: "",
      exitCode,
      signal: null,
      truncated,
    };
  }
  cursors.set(key, cursor);
  return {
    stdout: Buffer.concat(chunks).toString("utf8"),
    stderr: "",
    exitCode: null,
    signal: null,
    truncated,
  };
}

function routeBash(args: z.output<typeof Input>, ports: FilePorts, cursors: Map<string, string>) {
  if (args.session !== undefined) {
    if (args.machine === undefined) throw new ToolRefused("bash", "session requires machine: persistent terminals live on the daemon");
    if (args.cwd !== undefined) throw new ToolRefused("bash", "cwd applies to one-shot commands; sessions open at /");
    return sessionBash(args, ports, cursors);
  }
  if (args.command.length === 0) throw new ToolRefused("bash", "command is required without session");
  return machineBash(args, ports);
}

export function createBashTool(ports: FilePorts) {
  /** Session read positions; the model never sees or manages cursor tokens. */
  const cursors = new Map<string, string>();
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
        return routeBash(args, ports, cursors);
      }),
    render: (_args, value) => JSON.stringify(value),
  });
}
