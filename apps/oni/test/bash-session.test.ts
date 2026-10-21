import { expect, spyOn, test } from "bun:test";
import type { PlainObject } from "@oni/protocol";
import type { FilePorts } from "../src/bundles/tools/core/filesystem";
import { dispatchModelTool } from "./helpers/tool-dispatch";

const input = (command: string) => ({ machine: "m-1", session: "qa", command }) satisfies PlainObject;

function fixture(readText: (writes: readonly string[], read: number) => string) {
  const writes: string[] = [];
  const cursors: string[] = [];
  let reads = 0;
  const machines: NonNullable<FilePorts["machines"]> = {
    defaultMachine: "m-1",
    get: () => ({
      fs: {
        read: async () => { throw new Error("unused fs"); },
        write: async () => { throw new Error("unused fs"); },
        list: async () => { throw new Error("unused fs"); },
        stat: async () => { throw new Error("unused fs"); },
      },
      exec: async () => { throw new Error("unused exec"); },
      pty: {
        open: async () => ({ status: "ok", cursor: "c0" }),
        write: async (_name, bytes) => {
          writes.push(Buffer.from(bytes).toString("utf8"));
          return { status: "ok" };
        },
        read: async (_name, options) => {
          cursors.push(options?.cursor ?? "");
          const data = readText(writes, reads++);
          return {
            status: "ok",
            data: Buffer.from(data),
            cursor: `c${reads}`,
            truncated: false,
          };
        },
      },
    }),
  };
  const bash = dispatchModelTool("bash", { machines });
  return { bash, writes, cursors };
}

function nonce(written: string): string {
  const halves = /'([0-9a-f]{16})' '([0-9a-f]{16})'/.exec(written);
  if (!halves) throw new Error("sentinel was not written with split halves");
  return `${halves[1]}${halves[2]}`;
}

function value(result: Awaited<ReturnType<ReturnType<typeof dispatchModelTool>>>) {
  expect(result.isError).toBeUndefined();
  return JSON.parse(String(result.content)) as {
    stdout: string; exitCode: number | null; pending: boolean; truncated: boolean;
  };
}

test("bash session waits for actual readiness and strips tty and line-editor echoes", async () => {
  const { bash, writes, cursors } = fixture((sent, read) => {
    // A fresh shell echoes the typed-ahead sentinel from the tty, then again after its first prompt.
    if (read === 0) return `${sent[0]?.trimEnd()}\r\n\x1b[?2004hrunner:/$ ${sent[0]?.trimEnd()}\r\n\x1b[?2004l`;
    if (read === 1) return `${nonce(sent[0] ?? "")}\n`;
    return `\x1b[?2004hprintf 'ok\\n'\r\n${sent[1]?.split("\n")[1]}\r\n\x1b[?2004l\x1b]0;title\x07ok\n${nonce(sent[1] ?? "")} 0\n`;
  });
  const result = value(await bash(input("printf 'ok\\n'")));
  expect(result).toMatchObject({ stdout: "runner:/$ ok", exitCode: 0, pending: false });
  expect(cursors).toEqual(["c0", "c1", "c2"]);
  expect(writes[1]).toStartWith("printf 'ok\\n'\n");
  expect(writes[1]).toContain("\nprintf '%s%s %s\\n'");
  expect(writes[1]).not.toContain(nonce(writes[1] ?? ""));
});

test.each(["echo hi &", "echo hi;", "echo hi # comment"])(
  "bash session executes %s before the exit sentinel",
  async (command) => {
    const { bash } = fixture((writes, read) =>
      read === 0 ? `${nonce(writes[0] ?? "")}\n` : `hi\n${nonce(writes[1] ?? "")} 7\n`);
    expect(value(await bash(input(command)))).toMatchObject({
      stdout: "hi", exitCode: 7, pending: false,
    });
  },
);

test("bash session retains partial output until an empty call drains a split marker", async () => {
  let clock = 0;
  const now = spyOn(Date, "now").mockImplementation(() => clock);
  try {
    const { bash, writes, cursors } = fixture((sent, read) => {
      if (read === 0) return `${nonce(sent[0] ?? "")}\n`;
      if (read === 1) {
        clock = 20_001;
        return `first\n${nonce(sent[1] ?? "").slice(0, 8)}`;
      }
      clock = 20_002;
      return `${nonce(sent[1] ?? "").slice(8)} 3\n`;
    });
    expect(value(await bash(input("printf first")))).toMatchObject({
      stdout: "first\n", exitCode: null, pending: true,
    });
    const busy = await bash(input("echo queued"));
    expect(busy.isError).toBe(true);
    expect(String(busy.content)).toContain("session command is still pending");
    expect(writes).toHaveLength(2);
    expect(value(await bash(input("")))).toMatchObject({
      stdout: "", exitCode: 3, pending: false,
    });
    expect(cursors).toEqual(["c0", "c1", "c2"]);
  } finally {
    now.mockRestore();
  }
});

test("empty bash command reads new terminal output once with the saved cursor", async () => {
  const { bash, writes, cursors } = fixture((sent, read) => {
    if (read === 0) return `${nonce(sent[0] ?? "")}\n`;
    if (read === 1) return `${nonce(sent[1] ?? "")} 0\n`;
    return "background output";
  });
  value(await bash(input("true")));
  expect(value(await bash(input("")))).toMatchObject({
    stdout: "background output", exitCode: null, pending: false,
  });
  expect(writes).toHaveLength(2);
  expect(cursors).toEqual(["c0", "c1", "c2"]);
});

test("bash session refuses a non-numeric exit suffix", async () => {
  const { bash } = fixture((writes, read) =>
    read === 0 ? `${nonce(writes[0] ?? "")}\n` : `${nonce(writes[1] ?? "")} 7junk\n`);
  const result = await bash(input("false"));
  expect(result.isError).toBe(true);
  expect(String(result.content)).toContain("non-numeric exit code");
});
