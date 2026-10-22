import { bundleTools, testToolPorts } from "./helpers/tool-ports";
import { dispatcherFixture } from "./helpers/dispatcher-fixture";
import { runEffect } from "./helpers/effect";
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { acquireEffect } from "./helpers/effect";
import { Core } from "@oni/agent";
const ToolRefused = Core.ToolRefused;
import { attachMachineDaemon, createMachineHost, createMemoryGenerationStore, type MachineHandle } from "@oni/machines";
import { Machine, type PlainValue } from "@oni/protocol";
import { parseLocus } from "../src/bundles/tools/locus/index";
import { socketPath } from "./helpers/socket-path";
import { testMachinePorts } from "./helpers/native-tool-ports";
import { executor } from "./helpers/executor";
import { testIds } from "./helpers/test-entropy";
import { refusingToolPort } from "./helpers/tool-port";

const context = { sessionId: "locus", turnId: "turn" };

describe("parseLocus", () => {
  const options = { defaultMachine: "self" };
  for (const path of ["/tmp/a", "/tmp/a:b"]) {
    test(`default machine ${path}`, () =>
      expect(parseLocus(path, options)).toEqual({ kind: "machine", machine: "self", path }));
  }
  test("the CONFIGURED default applies — no process-local state", () =>
    expect(parseLocus("/x", { defaultMachine: "node-1" })).toEqual({
      kind: "machine",
      machine: "node-1",
      path: "/x",
    }));
  for (const [input, machine, path] of [
    ["m:/tmp/a:b", "m", "/tmp/a:b"],
    ["c:/", "c", "/"],
    ["node-1:/a", "node-1", "/a"],
  ] as const) {
    test(`explicit ${input} is never rewritten to the default`, () =>
      expect(parseLocus(input, options)).toEqual({ kind: "machine", machine, path }));
  }
  for (const path of [
    "",
    ":/a",
    "m:",
    "m:relative",
    "m://a",
    "m:/../a",
    "m:/a\0",
    "/machines/m/a",
    " /a\0",
    "a b:/x",
    // No process working directory exists: relative paths are refusals (#1271).
    "a/b",
    "./a:b",
    "../relative",
    ".",
  ]) {
    test(`refuses ${JSON.stringify(path)}`, () =>
      expect(() => parseLocus(path, options)).toThrow(ToolRefused));
  }
});

async function fixture(
  explicit: boolean,
  run: (api: {
    root: string;
    machine: MachineHandle;
    rawExec: MachineHandle["exec"];
    endpointCalls: () => { get: number; exec: number };
    stored: Map<string, Uint8Array>;
    path: (name: string) => string;
    cell: (
      tool: string,
      input: Record<string, PlainValue>,
    ) => Promise<Effect.Success<ReturnType<ReturnType<typeof dispatcherFixture>["executeCell"]>>>;
    model: (
      tool: string,
      input: Record<string, PlainValue>,
    ) => Promise<Effect.Success<ReturnType<ReturnType<typeof dispatcherFixture>["execute"]>>>;
  }) => Promise<void>,
  capabilities = ["fs.read", "fs.write", "shell.exec"],
) {
  const root = await mkdtemp(join(tmpdir(), "locus-"));
  const machineId = explicit ? "c" : "self";
  const socket = socketPath();
  const host = await acquireEffect(createMachineHost({
    generations: createMemoryGenerationStore(),
    dispatcherBound: 8,
    callTool: refusingToolPort,
    listen: { unix: socket },
    id: testIds("locus-host"),
    enrollment: () => ({
      machineId,
      name: "test",
      allowedCapabilities: capabilities,
      allowedExports: ["data", "shell"],
      publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      enrolledAt: 1,
    }),
    events: { publish: () => undefined },
    now: () => 1,
  }));
  const daemon = await acquireEffect(attachMachineDaemon({
    dispatcherBound: 8,
    socketPath: socket,
    id: testIds("locus-daemon"),
    offer: {
      machineId,
      daemonVersion: "test",
      platform: "darwin-arm64",
      offeredAt: 1,
      offeredCapabilities: ["fs.read", "fs.write", "shell.exec"],
      exports: [
        { name: "data", path: root },
        { name: "shell", path: "/" },
      ],
    },
    fsExports: new Map([
      ["data", root],
      ["shell", "/"],
    ]),
  }));
  const handle = host.get(machineId);
  const spies = {
    get: spyOn(host, "get"),
    read: spyOn(handle.fs, "read"),
    write: spyOn(handle.fs, "write"),
    list: spyOn(handle.fs, "list"),
    stat: spyOn(handle.fs, "stat"),
    exec: spyOn(handle, "exec"),
  };
  const operations: Record<string, (keyof typeof spies)[]> = {
    read: ["read"],
    write: ["write"],
    edit: ["read", "write"],
    ls: ["list"],
    find: ["stat", "list"],
    grep: ["stat", "read"],
    bash: ["exec"],
  };
  const stored = new Map<string, Uint8Array>();
  async function observe<T extends { isError?: boolean }>(
    tool: string,
    invoke: () => Promise<T>,
  ): Promise<T> {
    const before = Object.fromEntries(
      Object.entries(spies).map(([name, spy]) => [name, spy.mock.calls.length]),
    );
    const result = await invoke();
    if (!result.isError) {
      for (const name of operations[tool] ?? []) {
        const count = spies[name].mock.calls.length - (before[name] ?? 0);
        expect(count).toBeGreaterThan(0);
      }
      const resolved = spies.get.mock.calls.slice(before.get ?? 0).map(([id]) => id);
      expect(resolved.length).toBeGreaterThan(0);
      expect(resolved.every((id) => id === machineId)).toBe(true);
    }
    return result;
  }
  try {
    // #1305: real catalog + in-memory output store, the app composition's shape.
    const dispatcher = dispatcherFixture(bundleTools({ ...testToolPorts, machines: testMachinePorts(host, "self") }), {
      executor,
      toolOutput: { budgetBytes: 32_768, put: (write) => { stored.set(write.outputId, write.bytes); } },
    });
    let call = 0;
    await run({
      root,
      machine: handle,
      rawExec: handle.exec,
      endpointCalls: () => ({
        get: spies.get.mock.calls.length,
        exec: spies.exec.mock.calls.length,
      }),
      stored,
      path: (name) => `${explicit ? "c:" : ""}${join(root, name)}`,
      cell: (tool, input) =>
        observe(tool, () => runEffect(dispatcher.executeCell({ id: `cell-${++call}`, tool, input }, context))),
      model: (tool, input) =>
        observe(tool, () => runEffect(dispatcher.execute({ id: `model-${++call}`, tool, input }, context))),
    });
  } finally {
    for (const spy of Object.values(spies)) spy.mockRestore();
    await runEffect(daemon.close());
    await runEffect(host.close());
    await rm(root, { recursive: true, force: true });
  }
}

for (const explicit of [false, true]) {
  describe(explicit ? "explicit machine prefix tools" : "default-machine prefix-less tools", () => {
    test("all five filesystem verbs preserve values and route mutations", async () => {
      await fixture(explicit, async ({ root, path, cell, model }) => {
        const file = path("file");
        expect((await cell("write", { path: file, content: "alpha\nbeta\n" })).structuredContent).toEqual({
          bytesWritten: 11,
        });
        expect(await readFile(join(root, "file"), "utf8")).toBe("alpha\nbeta\n");
        expect((await cell("read", { path: file })).structuredContent).toEqual({
          content: "alpha\nbeta\n",
          bytes: 11,
        });
        expect((await model("read", { path: file })).content).toBe("alpha\nbeta\n");
        expect((await cell("read", { path: file, offset: 2, limit: 1 })).structuredContent).toEqual({
          content: "beta",
          bytes: 11,
        });
        expect(
          (await cell("edit", { path: file, edits: [{ oldText: "beta", newText: "gamma" }] }))
            .structuredContent,
        ).toEqual({ bytesWritten: 12 });
        expect(await readFile(join(root, "file"), "utf8")).toBe("alpha\ngamma\n");
        expect((await cell("ls", { path: path(".") })).structuredContent).toEqual({
          entries: [{ name: "file", kind: "file" }],
          truncated: false,
        });
        await mkdir(join(root, "nested"));
        await writeFile(join(root, "nested", "file"), "gamma in nested\n");
        await symlink(root, join(root, "loop"));
        expect((await cell("find", { path: path("."), pattern: "**/file" })).structuredContent).toEqual({
          paths: [file, path("nested/file")],
          truncated: false,
        });
        expect((await cell("find", { path: path("."), pattern: "*", limit: 1 })).structuredContent).toEqual({
          paths: [file],
          truncated: true,
        });
        const renderedFind = await model("find", { path: path("."), pattern: "*", limit: 1 });
        expect(renderedFind.content.split("\n")[0]).toBe(file);
        expect(renderedFind.content).toContain("[truncated:");
        // A walk root must itself be a regular file or directory; symlinks are never followed.
        expect(await model("find", { path: path("loop"), pattern: "*" })).toMatchObject({
          isError: true,
          errorKind: "precondition_failed",
        });
        expect((await cell("grep", { path: path("."), pattern: "gamma" })).structuredContent).toEqual({
          matches: [
            { path: file, line: 2, text: "gamma", before: [], after: [] },
            { path: path("nested/file"), line: 1, text: "gamma in nested", before: [], after: [] },
          ],
          truncated: false,
        });
        expect(
          (await cell("grep", { path: path("."), pattern: "GAMMA", ignoreCase: true, context: 1 }))
            .structuredContent,
        ).toMatchObject({
          matches: [
            { path: file, line: 2, before: ["alpha"], after: [""] },
            { path: path("nested/file"), line: 1, before: [], after: [""] },
          ],
        });
        expect(
          (await cell("grep", { path: path("."), pattern: "a.*", literal: true })).structuredContent,
        ).toEqual({ matches: [], truncated: false });
        expect((await cell("grep", { path: file, pattern: "^al", limit: 1 })).structuredContent).toEqual({
          matches: [{ path: file, line: 1, text: "alpha", before: [], after: [] }],
          truncated: false,
        });
        const malformed = await model("grep", { path: file, pattern: "(" });
        expect(malformed.errorKind).toBe("precondition_failed");
        expect(malformed.content).toContain("invalid regular expression: (");
      });
    });
    test("binary encoding, exact edit conflict, missing files, and full cell output", async () => {
      await fixture(explicit, async ({ root, path, cell, model }) => {
        const binary = Buffer.from([0, 255, 128, 1]).toString("base64");
        expect(
          (await cell("write", { path: path("binary"), content: binary, encoding: "base64" }))
            .isError,
        ).toBeUndefined();
        expect((await cell("read", { path: path("binary"), encoding: "base64" })).structuredContent).toEqual({
          content: binary,
          bytes: 4,
        });
        expect(await model("read", { path: path("binary") })).toMatchObject({
          isError: true,
          errorKind: "precondition_failed",
        });
        expect(
          await model("write", { path: path("binary"), content: "!!", encoding: "base64" }),
        ).toMatchObject({ isError: true, errorKind: "precondition_failed" });
        await writeFile(join(root, "text"), "aaa");
        for (const oldText of ["missing", "aa"])
          expect(
            await model("edit", { path: path("text"), edits: [{ oldText, newText: "x" }] }),
          ).toMatchObject({
            isError: true,
            errorKind: "precondition_failed",
          });
        expect(await readFile(join(root, "text"), "utf8")).toBe("aaa");
        expect(await model("read", { path: path("absent") })).toMatchObject({
          isError: true,
          errorKind: "precondition_failed",
        });
        const content = "x".repeat(1_100_000);
        await writeFile(join(root, "large"), content);
        expect((await cell("read", { path: path("large") })).structuredContent).toEqual({
          content,
          bytes: content.length,
        });
        const rendered = await model("read", { path: path("large") });
        // #1305: a 1.1 MB read projects — bounded preview, identifier, stored bytes.
        expect(Buffer.byteLength(rendered.content, "utf8")).toBeLessThanOrEqual(32_768);
        expect(rendered.content).toContain("[output sha256:");
        expect(rendered.content).toContain("1100000 bytes");
      });
    });
    test("bash returns stdout, stderr, exit status and has no persistent cwd", async () => {
      await fixture(explicit, async ({ root, cell }) => {
        const machine: Record<string, PlainValue> = explicit ? { machine: "c" } : {};
        expect(
          (
            await cell("bash", {
              command: `cd '${root}'; printf out; printf err >&2; exit 7`,
              ...machine,
            })
          ).structuredContent,
        ).toEqual({
          stdout: "out",
          stderr: "err",
          exitCode: 7,
          signal: null,
          truncated: false,
          pending: false,
        });
        expect(
          (await cell("bash", { command: "printf '%s' \"$PWD\"", ...machine })).structuredContent,
        ).toMatchObject({ stdout: "/", exitCode: 0 });
      });
    });
  });
}

test("R1 bash rejects composite machine IDs before endpoint lookup even with an allowed cwd", async () => {
  await fixture(true, async ({ root, rawExec, endpointCalls, model }) => {
    const injected = join(root, "injected:");
    await mkdir(injected);
    const command = "printf '%s' \"$PWD\"";
    // Prove the real daemon would allow the malformed locus's cwd: denial must be in the adapter.
    expect(await runEffect(rawExec(command, injected))).toMatchObject({
      status: "completed",
      stdout: Buffer.from(await realpath(injected)),
      exitCode: 0,
    });
    for (const machine of [`c:${root}/injected`, "c:/", "c/path", "./c"]) {
      const before = endpointCalls();
      expect(await model("bash", { machine, command })).toMatchObject({
        isError: true,
        errorKind: "precondition_failed",
      });
      expect(endpointCalls()).toEqual(before);
    }
    expect((await model("bash", { machine: "c", command })).isError).toBeUndefined();
  });
});

test.each([
  [false, ""],
  [true, "c:"],
])("R2 recursive search preserves colon-containing names (explicit=%p)", async (explicit, prefix) => {
  await fixture(explicit, async ({ root, cell, model }) => {
    await writeFile(join(root, "a:b"), "needle in file\n");
    await mkdir(join(root, "d:e"));
    await writeFile(join(root, "d:e", "f:g"), "needle in directory\n");
    const file = `${prefix}${join(root, "a:b")}`;
    const nested = `${prefix}${join(root, "d:e", "f:g")}`;
    expect((await cell("grep", { path: `${prefix}${root}`, pattern: "needle" })).structuredContent).toEqual({
      matches: [
        { path: file, line: 1, text: "needle in file", before: [], after: [] },
        { path: nested, line: 1, text: "needle in directory", before: [], after: [] },
      ],
      truncated: false,
    });
    expect((await model("grep", { path: `${prefix}${root}`, pattern: "needle" })).content).toBe(
      `${file}:1:needle in file\n${nested}:1:needle in directory`,
    );
    expect((await cell("find", { path: `${prefix}${root}`, pattern: "d:e/*" })).structuredContent).toEqual({
      paths: [nested],
      truncated: false,
    });
  });
});

test("R3 real daemon Unicode read preserves cells and projects the model text to a stored ref", async () => {
  await fixture(true, async ({ root, path, cell, model, stored }) => {
    const content = `a${"\u{1F600}".repeat(25_000)}`;
    await writeFile(join(root, "unicode"), content);
    expect((await cell("read", { path: path("unicode") })).structuredContent).toEqual({
      content,
      bytes: 100_001,
    });
    const result = await model("read", { path: path("unicode") });
    expect(result.isError).toBeUndefined();
    // #1305: over-budget model output projects to preview + stored ref.
    const marker = /\n\[output (sha256:[0-9a-f]{64}): (\d+) bytes; read with tool_output\("sha256:[0-9a-f]{64}"\)\]$/.exec(result.content);
    if (marker === null) throw new Error("missing output marker");
    expect(Number(marker[2])).toBe(100_001);
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(32_768);
    const preview = result.content.slice(0, marker.index);
    expect(content.startsWith(preview)).toBe(true);
    expect(Buffer.from(result.content, "utf8").toString("utf8")).toBe(result.content);
    const full = stored.get(marker[1] ?? "");
    if (full === undefined) throw new Error("output bytes not stored");
    expect(new TextDecoder().decode(full)).toBe(content);
  });
});

test("a real daemon read assembles successive bounded chunks without dropping the tail", async () => {
  await fixture(true, async ({ root, path, cell }) => {
    const content = `${"a".repeat(Machine.FS_READ_MAX_BYTES)}TAIL_SENTINEL`;
    await writeFile(join(root, "chunked"), content);
    expect((await cell("read", { path: path("chunked") })).structuredContent).toEqual({
      content,
      bytes: Buffer.byteLength(content),
    });
  });
});

test("a truncated remote read without progress is refused instead of looping", async () => {
  await fixture(true, async ({ machine, path, model }) => {
    const read = spyOn(machine.fs, "read").mockReturnValue(Effect.succeed({
      op: "read",
      data: new Uint8Array(),
      bytesRead: 0,
      size: 1,
      truncated: true,
    }));
    try {
      const result = await model("read", { path: path("stalled") });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("remote read made no progress");
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      read.mockRestore();
    }
  });
});

test("a truncated remote listing is refused rather than presented as complete", async () => {
  await fixture(true, async ({ machine, path, model }) => {
    const list = spyOn(machine.fs, "list").mockReturnValue(Effect.succeed({
      op: "list",
      entries: [{ name: "first", kind: "file" }],
      truncated: true,
    }));
    try {
      const result = await model("ls", { path: path(".") });
      expect(result).toMatchObject({ isError: true, errorKind: "precondition_failed" });
      expect(result.content).toContain("directory exceeds daemon entry limit");
      expect(list).toHaveBeenCalledTimes(1);
    } finally {
      list.mockRestore();
    }
  });
});

test("daemon authority refuses writes and exec independently of the catalog", async () => {
  await fixture(
    true,
    async ({ path, model }) => {
      expect(await model("write", { path: path("denied"), content: "x" })).toMatchObject({
        isError: true,
        errorKind: "precondition_failed",
      });
      expect(await model("bash", { machine: "c", command: "true" })).toMatchObject({
        isError: true,
        errorKind: "precondition_failed",
      });
    },
    ["fs.read"],
  );
});

test("missing machine host and malformed machine ids yield typed refusals", async () => {
  const dispatcher = dispatcherFixture(bundleTools(testToolPorts), { executor });
  for (const [tool, input] of [
    ["read", { path: "c:/file" }],
    ["bash", { machine: "c", command: "true" }],
    ["bash", { machine: "./bad", command: "true" }],
  ] as const) {
    expect(await runEffect(dispatcher.execute({ id: tool, tool, input }, context))).toMatchObject({
      isError: true,
      errorKind: "precondition_failed",
    });
  }
});
