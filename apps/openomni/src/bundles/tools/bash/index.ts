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
// Bound on rounds, not time: non-empty reads return immediately, so a busy
// terminal spends the cap fast and returns what it has; the loop only ends
// early once the terminal stays quiet for a whole long-poll round.
const SESSION_DRAIN_ROUNDS = 32;

type SessionTarget = ReturnType<typeof machineTarget>["target"];
type SessionRefusal = { readonly status: "refused"; readonly reason: string };
function refusedSession(result: SessionRefusal): never {
  throw new ToolRefused("bash", result.reason);
}

/**
 * First touch of a session in this process: open (reattach-or-create under
 * the daemon's export confinement) and consume the first read. A fresh shell
 * swallows bytes typed during startup, so the opening read long-polls for the
 * first prompt bytes; on reattach it returns the scrollback snapshot instead,
 * which is exactly the context worth showing once.
 */
async function openSessionCursor(target: SessionTarget, session: string, sink: Buffer[]) {
  const opened = await target.pty.open(session, "/");
  if (opened.status !== "ok") refusedSession(opened);
  const first = await target.pty.read(session, { cursor: opened.cursor, waitMs: 2000 });
  if (first.status !== "ok") refusedSession(first);
  sink.push(Buffer.from(first.data));
  return { cursor: first.cursor, truncated: first.truncated };
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
    const openedState = await openSessionCursor(target, session, chunks);
    cursor = openedState.cursor;
    truncated = openedState.truncated;
  }
  if (args.command.length > 0) {
    const written = await target.pty.write(session, Buffer.from(`${args.command}\n`, "utf8"));
    if (written.status !== "ok") refusedSession(written);
  }
  // Drain until the terminal goes quiet for one round; each round blocks on
  // the daemon's long-poll, so there is no timing-based polling here.
  for (let round = 0; round < SESSION_DRAIN_ROUNDS; round += 1) {
    const view = await target.pty.read(session, { cursor, waitMs: SESSION_DRAIN_WAIT_MS });
    if (view.status !== "ok") refusedSession(view);
    cursor = view.cursor;
    truncated = truncated || view.truncated;
    if (view.data.length === 0) break;
    chunks.push(Buffer.from(view.data));
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
