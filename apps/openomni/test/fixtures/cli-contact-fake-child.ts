/**
 * The fake child CLI for the #1512 conformance test: a Bun program the pty
 * pane resolves as the pack's command. It behaves as the vendor would toward
 * the installed live config — prints the pack's idle prompt, runs the wired
 * hook command for each event with the payload on stdin, appends transcript
 * records to the path it advertised in SessionStart — using only the
 * payloads and records captured in the pack's fixtures. It parses nothing
 * of the TUI protocol and knows nothing of the spool: the hook script does.
 */
import { readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

interface Fixture {
  readonly live: readonly { readonly line: string }[];
  readonly transcript: readonly { readonly line: string }[];
}

function argument(flag: string): string {
  const index = process.argv.indexOf(flag);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined) throw new Error(`missing ${flag}`);
  return value;
}

const packDir = process.env.OPENOMNI_FAKE_PACK_DIR;
if (packDir === undefined) throw new Error("OPENOMNI_FAKE_PACK_DIR is required");
const sessionId = argument("--session-id");
const settings = JSON.parse(readFileSync(argument("--settings"), "utf8")) as {
  readonly hooks?: Record<string, readonly { readonly hooks: readonly { readonly type: string; readonly command: string }[] }[]>;
};
const fixtures = JSON.parse(readFileSync(join(packDir, "test", "fixtures.json"), "utf8")) as Fixture;
const screens = JSON.parse(readFileSync(join(packDir, "test", "screen-fixtures.json"), "utf8")) as { readonly idle_prompt: string };
const idle = screens.idle_prompt.split("\n").at(-1) ?? "";
const transcriptPath = join(process.cwd(), `transcript-${sessionId}.jsonl`);

function payloadOf(event: string): Record<string, string | number | boolean | object> {
  for (const entry of fixtures.live) {
    const line = JSON.parse(entry.line) as { readonly event: string; readonly payload: Record<string, string | number | boolean | object> };
    if (line.event === event) return line.payload;
  }
  throw new Error(`no fixture payload for ${event}`);
}

/** The vendor's side of the contract: every wired command for the event runs with the payload JSON on stdin. */
function fire(event: string, payload: Record<string, string | number | boolean | object>): void {
  for (const matcher of settings.hooks?.[event] ?? []) {
    for (const hook of matcher.hooks) {
      if (hook.type !== "command") continue;
      const run = Bun.spawnSync(["/bin/sh", "-c", hook.command], { stdin: Buffer.from(JSON.stringify(payload)), stdout: "ignore", stderr: "ignore" });
      if (run.exitCode !== 0) throw new Error(`hook ${event} exited ${run.exitCode}`);
    }
  }
}

async function* lines(): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of Bun.stdin.stream()) {
    pending += decoder.decode(chunk, { stream: true });
    let boundary = pending.indexOf("\n");
    while (boundary !== -1) {
      yield pending.slice(0, boundary).replace(/\r$/, "");
      pending = pending.slice(boundary + 1);
      boundary = pending.indexOf("\n");
    }
  }
}

console.log(idle);
fire("SessionStart", { ...payloadOf("SessionStart"), session_id: sessionId, transcript_path: transcriptPath, cwd: process.cwd() });
for await (const prompt of lines()) {
  // Two scripted misbehaviours the conformance suite needs: a child that swallows the letter without a single
  // event (the stall), and one that takes it and never ends its turn (the deadline's interrupt).
  if (prompt.includes("[stall]")) continue;
  fire("UserPromptSubmit", { ...payloadOf("UserPromptSubmit"), session_id: sessionId, prompt });
  if (prompt.includes("[hang]")) await new Promise<never>(() => undefined);
  fire("PreToolUse", { ...payloadOf("PreToolUse"), session_id: sessionId });
  fire("PostToolUse", { ...payloadOf("PostToolUse"), session_id: sessionId });
  appendFileSync(transcriptPath, `${fixtures.transcript.map((entry) => entry.line).join("\n")}\n`);
  fire("Stop", { ...payloadOf("Stop"), session_id: sessionId });
  console.log(idle);
}
fire("SessionEnd", { ...payloadOf("SessionEnd"), session_id: sessionId });
