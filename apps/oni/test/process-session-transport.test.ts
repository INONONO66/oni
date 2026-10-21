import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measuredEntry } from "./helpers/measured-entry";
import type { SessionTransition } from "@oni/protocol";
import { createProcessSessionTransport } from "../src/composition/process-session";
import { PROCESS_SESSION_NO_REQUEST_EXIT } from "../src/process-entry";
import { bounded } from "./helpers/protected-dispatch";

const CHILD = new URL("./fixtures/process-session-child.ts", import.meta.url).pathname;
const ENTRY = new URL("../src/process-entry.ts", import.meta.url).pathname;

function transport(scenario: string, answer?: SessionTransition.Resolution | Error) {
  const committed: string[][] = [];
  const answers: SessionTransition.Answer[] = [];
  const ready = Promise.withResolvers<void>();
  return {
    ready: ready.promise,
    committed,
    answers,
    sessions: createProcessSessionTransport({
      command: [process.execPath, CHILD, scenario],
      child: {
        catalogPath: "unused-catalog.sqlite",
        sessionsDir: "unused-sessions",
        entityIdleMs: 60_000,
        model: { provider: "anthropic", id: "claude-opus-4-5" },
        apiKey: "process-key",
      },
      committed: (ids) => {
        committed.push([...ids]);
        ready.resolve();
      },
      answer: async (value) => {
        answers.push(value);
        if (answer instanceof Error) throw answer;
        if (answer === undefined) throw new Error("no answer configured");
        // The second answer of a conversation is refused by the owner side.
        if (answers.length > 1) throw new Error("owner refused");
        return answer;
      },
      deliver: async () => {
        throw new Error("no delivery configured");
      },
    }),
  };
}

test("process transport relays the child's doorbell and both receipt outcomes", async () => {
  const f = transport("conversation", "resolved");
  const done = f.sessions.wake("child");
  expect(f.sessions.wake("child")).toBe(done);
  await bounded(done);
  expect(f.committed).toEqual([["child-a", "child-b"]]);
  expect(f.answers.map((answer) => answer.inputId)).toEqual(["first", "second"]);
  expect(f.answers[0]?.principal.principalId).toBe("child");
});

test("an answer whose principal is not the authenticated child is refused", async () => {
  const f = transport("impostor", "resolved");
  await expect(bounded(f.sessions.wake("child"))).rejects.toThrow(
    "process answer principal does not match its authenticated child",
  );
  expect(f.answers).toEqual([]);
});

test("measured process entry exits without a request on empty stdin", async () => {
  const child = await measuredEntry(
    new URL("../src/process-entry.ts", import.meta.url),
    { PATH: process.env.PATH ?? "/usr/bin:/bin", ONI_DISABLE_MODELS_FETCH: "1" },
    "",
  );
  expect(child.exitCode).toBe(PROCESS_SESSION_NO_REQUEST_EXIT);
});

test("native process entry validates and releases a request for a missing durable session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "oni-missing-session-"));
  const request = {
    sessionId: "MISSING_SESSION_SENTINEL",
    catalogPath: join(directory, "catalog.sqlite"),
    sessionsDir: join(directory, "sessions"),
    entityIdleMs: 60_000,
    model: { provider: "anthropic", id: "fixture" },
    apiKey: "fixture-key",
  };
  try {
    const child = await measuredEntry(
      new URL("../src/process-entry.ts", import.meta.url),
      { PATH: process.env.PATH ?? "/usr/bin:/bin", ONI_DISABLE_MODELS_FETCH: "1" },
      `${JSON.stringify(request)}\n`,
    );
    expect(child.exitCode).toBe(1);
    expect(child.stderr).toContain(request.sessionId);
    expect(child.stdout).not.toContain('"sessionIds"');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a child exiting without settling surfaces its exit code", async () => {
  const f = transport("crash");
  await expect(bounded(f.sessions.wake("child"))).rejects.toThrow(
    "session process exited 2: child",
  );
});

test("closing the transport kills lingering children", async () => {
  const f = transport("linger");
  const done = f.sessions.wake("child");
  const settled = done.then(
    () => "resolved" as const,
    (error: Error) => error.message,
  );
  await bounded(f.ready);
  await bounded(f.sessions.close());
  expect(await bounded(settled)).toMatch(/^session process exited /);
  expect(f.committed).toEqual([["child"]]);
});

test("a doorbell is not successful settlement when the child crashes", async () => {
  const f = transport("ack-crash");
  await expect(bounded(f.sessions.wake("child"))).rejects.toThrow(
    "session process exited 2: child",
  );
  expect(f.committed).toEqual([["child"]]);
  expect(f.answers).toEqual([]);
});

test("malformed child output rejects the wire rather than being acknowledged", async () => {
  const f = transport("malformed");
  try {
    await expect(bounded(f.sessions.wake("child"))).rejects.toBeInstanceOf(SyntaxError);
    expect(f.answers).toEqual([]);
    expect(f.committed).toEqual([]);
  } finally {
    await f.sessions.close();
  }
});

test.each([
  { input: "", code: 78, error: false },
  { input: "{not-json}\n", code: 1, error: true },
  { input: "{}\n", code: 1, error: true },
])("real process entry validates its first request: %j", async ({ input, code, error }) => {
  const child = Bun.spawn([process.execPath, ENTRY], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  try {
    child.stdin.write(input);
    child.stdin.end();
    expect(await bounded(child.exited)).toBe(code);
    const [stdout, stderr] = await bounded(output);
    expect(stdout).toBe("");
    expect(stderr.length > 0).toBe(error);
  } finally {
    if (child.exitCode === null) child.kill();
    await bounded(child.exited);
  }
});
