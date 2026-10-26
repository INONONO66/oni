// Installed by mclient as the one permission module of every CLI that loads a
// script hook. Every tool call waits for the oni host's verdict through
// `$ONI_MCLIENT hook permission --cli $ONI_MCLIENT_CLI`; anything other than
// exit 0 from it, including a missing client, a crash or a timeout, blocks
// the call. The launching dialect sets both variables.
import { spawn } from "node:child_process";

interface ToolCallEvent {
  toolCallId: string;
  toolName: string;
  input: object;
}

interface HookContext {
  sessionManager: { getSessionId(): string };
}

interface Block {
  block: true;
  reason: string;
}

interface HookApi {
  on(event: "tool_call", handler: (event: ToolCallEvent, ctx: HookContext) => Promise<Block | undefined>): void;
}

const LIMIT_MS = 190_000;

/** `ONI_MCLIENT_HOOK_LIMIT_MS` can only shorten the wait, never extend it. */
function limit(): number {
  const lowered = Number(process.env.ONI_MCLIENT_HOOK_LIMIT_MS);
  return lowered > 0 && lowered < LIMIT_MS ? lowered : LIMIT_MS;
}

function ask(payload: string): Promise<string | undefined> {
  const program = process.env.ONI_MCLIENT;
  const cli = process.env.ONI_MCLIENT_CLI;
  if (!(program && cli)) {
    return Promise.resolve("oni: ONI_MCLIENT and ONI_MCLIENT_CLI must be set");
  }
  return new Promise((resolve) => {
    const child = spawn(program, ["hook", "permission", "--cli", cli], {
      stdio: ["pipe", "ignore", "pipe"],
      timeout: limit(),
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdin.on("error", () => undefined);
    child.on("error", (error: Error) => resolve(`oni: ${error.message}`));
    child.on("close", (code: number | null) =>
      resolve(code === 0 ? undefined : stderr.trim() || `oni: permission hook exited ${code}`),
    );
    child.stdin.end(payload);
  });
}

export default function (api: HookApi): void {
  api.on("tool_call", async (event, ctx) => {
    try {
      const reason = await ask(
        JSON.stringify({
          sessionId: ctx.sessionManager.getSessionId(),
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.input,
        }),
      );
      return reason === undefined ? undefined : { block: true, reason };
    } catch (error) {
      return { block: true, reason: `oni: ${String(error)}` };
    }
  });
}
