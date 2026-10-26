/** Drives the shipped permission module in-process: only an exit-0 verdict lets a tool call through. */
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const MODULE = resolve(import.meta.dir, "../../../clients/machine-client/src/agent/permission.ts");
/** Larger than any pipe buffer, so a client that never reads it fails the write. */
const FLOOD = "x".repeat(4 * 1024 * 1024);

const FIXTURE_MCLIENT = `#!/bin/sh
printf '%s\\n' "$*" > "$ONI_FIXTURE_ARGS"
case "$ONI_FIXTURE_MODE" in
  allow) cat > "$ONI_FIXTURE_STDIN"; exit 0 ;;
  deny) cat > /dev/null; echo "denied by the host" >&2; exit 2 ;;
  silent) cat > /dev/null; exit 3 ;;
  killed) cat > /dev/null; kill -TERM $$ ;;
  unread) exit 4 ;;
  hang) cat > /dev/null; exec tail -f /dev/null ;;
esac
exit 9
`;

interface Block {
  readonly block: true;
  readonly reason: string;
}

type Handler = (event: object, ctx: object) => Promise<Block | undefined>;

interface Probe {
  check(condition: boolean, message: string): asserts condition;
  record(line: string): void;
  script(path: string, text: string): Promise<void>;
}

const EVENT = { toolCallId: "call-1", toolName: "bash", input: { command: "true" } };
const CONTEXT = { sessionManager: { getSessionId: () => "session-1" } };

async function load(): Promise<Handler> {
  const module: { default: (api: { on(name: string, handler: Handler): void }) => void } = await import(MODULE);
  let registered: Handler | undefined;
  module.default({
    on: (name, handler) => {
      if (name === "tool_call") registered = handler;
    },
  });
  if (registered === undefined) throw new Error("the permission module registered no tool_call handler");
  return registered;
}

async function withEnv<A>(values: Record<string, string | undefined>, body: () => Promise<A>): Promise<A> {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const apply = (entries: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(values);
  try {
    return await body();
  } finally {
    apply(saved);
  }
}

export async function permissionModule(probe: Probe, scratch: string): Promise<void> {
  const directory = join(scratch, "permission-module");
  mkdirSync(directory);
  const program = join(directory, "mclient");
  await probe.script(program, FIXTURE_MCLIENT);
  const args = join(directory, "args");
  const stdin = join(directory, "stdin");
  const handler = await load();
  const ask = (mode: string, overrides: Record<string, string | undefined> = {}, event: object = EVENT, ctx: object = CONTEXT) =>
    withEnv(
      {
        ONI_MCLIENT: program,
        ONI_MCLIENT_CLI: "omp",
        ONI_FIXTURE_MODE: mode,
        ONI_FIXTURE_ARGS: args,
        ONI_FIXTURE_STDIN: stdin,
        ...overrides,
      },
      () => handler(event, ctx),
    );

  const allowed = await ask("allow");
  probe.check(allowed === undefined, `explicit allow answered ${JSON.stringify(allowed)}`);
  probe.check(readFileSync(args, "utf8") === "hook permission --cli omp\n", `the module invoked ${readFileSync(args, "utf8")}`);
  probe.check(
    JSON.stringify(JSON.parse(readFileSync(stdin, "utf8"))) ===
      JSON.stringify({ sessionId: "session-1", toolCallId: "call-1", toolName: "bash", input: { command: "true" } }),
    `the module wrote ${readFileSync(stdin, "utf8")}`,
  );
  const blocked: readonly [string, Block | undefined, string][] = [
    ["deny", await ask("deny"), "denied by the host"],
    ["nonzero exit", await ask("silent"), "oni: permission hook exited 3"],
    ["signal death", await ask("killed"), "oni: permission hook exited null"],
    ["unread stdin", await ask("unread", {}, { ...EVENT, input: { flood: FLOOD } }), "oni: permission hook exited 4"],
    ["timeout", await ask("hang", { ONI_MCLIENT_HOOK_LIMIT_MS: "50" }), "oni: permission hook exited null"],
    ["unlowered limit", await ask("silent", { ONI_MCLIENT_HOOK_LIMIT_MS: "999999999" }), "oni: permission hook exited 3"],
    ["missing program", await ask("allow", { ONI_MCLIENT: undefined }), "oni: ONI_MCLIENT and ONI_MCLIENT_CLI must be set"],
    ["missing selector", await ask("allow", { ONI_MCLIENT_CLI: undefined }), "oni: ONI_MCLIENT and ONI_MCLIENT_CLI must be set"],
    ["spawn failure", await ask("allow", { ONI_MCLIENT: join(directory, "absent") }), "ENOENT"],
    ["malformed context", await ask("allow", {}, EVENT, {}), "oni: TypeError"],
    ["malformed input", await ask("allow", {}, { ...EVENT, input: { size: 1n } }), "oni: TypeError"],
  ];
  for (const [label, verdict, reason] of blocked) {
    probe.check(verdict?.block === true && verdict.reason.includes(reason), `${label} answered ${JSON.stringify(verdict)}`);
  }
  probe.record(`shipped permission module: explicit allow passes; ${blocked.map(([label]) => label).join(", ")} all block`);
}
