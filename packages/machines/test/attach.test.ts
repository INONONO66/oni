import { Exit, Cause } from "effect";
import { beforeAll, describe, expect, test } from "bun:test";
import { statSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IpcRemoteError, connectIpcClient } from "./ipc/helpers/native";
import { captureError } from "./ipc/helpers/signal";
import { Machine } from "@oni/protocol";
import { attachMachineDaemon } from "./helpers/native";
import { type MachineHost, createMachineHost } from "./helpers/native";
import { socketPath } from "./helpers/socket-path";
import { eventCollector } from "./helpers/events";
import { kernelEnrollment } from "./helpers";
import { exit as runExit } from "./helpers/effect";
import { attachMclient, mclientBinary } from "./helpers/mclient";

beforeAll(mclientBinary, 300_000);

const enrollment: Machine.Enrollment = {
  name: "studio",
  machineId: "mac-studio",
  allowedCapabilities: ["fs.read", "shell.exec"],
  publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  enrolledAt: 1000,
};

function offer(overrides: Partial<Omit<Machine.Offer, "peer" | "generation">> = {}): Omit<Machine.Offer, "peer" | "generation"> {
  return {
    machineId: "mac-studio",
    daemonVersion: "0.0.1",
    platform: "darwin-arm64",
    offeredCapabilities: ["fs.read", "browser.control"],
    offeredAt: 2000,
    ...overrides,
  };
}

async function withHost(
  resolve: (machineId: Machine.MachineId) => Machine.Enrollment | undefined,
  run: (context: {
    host: MachineHost;
    path: string;
    collector: ReturnType<typeof eventCollector>;
  }) => Promise<void>,
  callTool?: (call: Machine.ToolCall) => Promise<Machine.ToolCallResult>,
  neverSupersede?: readonly Machine.MachineId[],
): Promise<void> {
  const collector = eventCollector();
  const path = socketPath();
  const host = await createMachineHost({
    listen: { unix: path },
    enrollment: resolve,
    events: collector.sink,
    now: () => 5000,
    callTool,
    neverSupersede,
  });
  try {
    await run({ host, path, collector });
  } finally {
    host.close();
  }
}

describe("machine attach handshake", () => {
  test.each([
    { cellId: "x" },
    { cellId: "x", timeoutMs: 1 },
    { cellId: "x", code: "ok" },
  ])("simulated peer rejects missing cell request fields: %j", (params) => {
    expect(() => Machine.CellRequest.parse(params)).toThrow();
  });

  test("simulated peer rejects extra cell request fields", () => {
    expect(() =>
      Machine.CellRequest.parse({ cellId: "x", code: "ok", timeoutMs: 1, constructor: "extra" }),
    ).toThrow();
  });

  test("rejects unaffiliated tool calls and unknown methods at the host boundary", async () => {
    await withHost(
      () => enrollment,
      async ({ path }) => {
        const client = await connectIpcClient(path);
        try {
          for (const [method, params] of [
            ["machine.call_tool", { cellId: "unknown", name: "tool", arguments: {} }],
            ["machine.unknown", {}],
          ] as const) {
            await expect(client.call(method, params)).rejects.toBeInstanceOf(IpcRemoteError);
          }
        } finally {
          client.close();
        }
      },
    );
  });

  test("a host without a tool port refuses a real client cell and duplicate ids", async () => {
    await withHost(
      () => kernelEnrollment(enrollment),
      async ({ host, path, collector }) => {
        const client = await attachMclient({ host, events: collector, machineId: "mac-studio", root: tmpdir(), exports: [] });
        try {
          const refusal = await host.get("mac-studio").runCode({
            cellId: "no-tools", code: "tool.missing()", timeoutMs: 15_000,
          });
          expect(refusal.status).toBe("raised");
          expect(refusal.status === "raised" && refusal.error).toContain("host_tool_missing");
        } finally { await client.stop(); }

        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const peer = await connectIpcClient(path, {
          onRequest: async (method, params, respond) => {
            if (method !== Machine.WireMethod.RunCode) throw new Error(`unexpected peer request: ${method}`);
            const request = Machine.CellRequest.parse(params);
            entered.resolve();
            await release.promise;
            respond({ status: "completed", cellId: request.cellId, output: { stdout: "", stderr: "" } });
          },
        });
        try {
          expect(await peer.call(Machine.WireMethod.Attach, {
            ...offer({ offeredCapabilities: ["kernel.py"] }),
            peer: { kind: "client", contractVersion: Machine.contractVersion },
          })).toMatchObject({ status: "attached" });
          const cell = { cellId: "same", code: "x", timeoutMs: 15_000 };
          const running = host.get("mac-studio").runCode(cell);
          await entered.promise;
          expect(await captureError(host.get("mac-studio").runCode(cell))).toMatchObject({
            _tag: "MachineCellError", code: "duplicate_cell_id", cellId: "same",
          });
          release.resolve();
          expect((await running).status).toBe("completed");
          const preAborted = await runExit(host.get("mac-studio").native.runCode(cell, AbortSignal.abort()));
          expect(Exit.isFailure(preAborted) && Cause.hasInterrupts(preAborted.cause)).toBe(true);
        } finally { release.resolve(); await peer.close(); }
      },
    );
  });

  test("rejects mismatched filesystem replies and propagates wire cancellation failures", async () => {
    const started = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    await withHost(
      () => ({ ...enrollment, allowedExports: ["docs"] }),
      async ({ host, path }) => {
        const client = await connectIpcClient(path, {
          onRequest: async (method, params, respond) => {
            if (method === "machine.fs_op") {
              respond({
                status: "completed",
                value: { op: "list", entries: [], truncated: false },
              });
            } else if (method === "machine.cancel_code") {
              cancelled.resolve();
              throw new Error("cancel rejected by peer");
            } else {
              const request = Machine.CellRequest.parse(params);
              started.resolve();
              await cancelled.promise;
              respond({
                status: "cancelled",
                cellId: request.cellId,
                output: { stdout: "", stderr: "" },
              });
            }
          },
        });
        try {
          await client.call("machine.attach", { ...offer({ exports: [{ name: "docs", path: "/" }] }), peer: { kind: "daemon", contractVersion: 2 } });
          const handle = host.get("mac-studio");
          await expect(handle.fs.stat("/file")).rejects.toMatchObject({
            _tag: "MachineRefusalError",
            reason: "invalid_response",
          });
          const controller = new AbortController();
          const running = handle.runCode(
            { cellId: "cancel", code: "x", timeoutMs: 1000 },
            controller.signal,
          );
          const outcome = captureError(running);
          await started.promise;
          controller.abort();
          expect(await outcome).toMatchObject({ _tag: "TransportFailure", operation: "cell.cancel" });
        } finally {
          client.close();
        }
      },
    );
  });

  test("list preserves enrollment fields and stable handles route two attachments without rendering", async () => {
    const root = mkdtempSync(join(tmpdir(), "om-routing-"));
    const data = Buffer.alloc(80_001, 255);
    writeFileSync(join(root, "data"), data);
    const a: Machine.Enrollment = {
      ...enrollment,
      machineId: "A",
      tags: ["fast", "local"],
      allowedCapabilities: ["fs.read", "kernel.py"],
      allowedExports: ["docs"],
    };
    const b: Machine.Enrollment = { ...a, machineId: "B", tags: ["other"] };
    try {
      await withHost(
        (id) => (id === "A" ? a : id === "B" ? b : undefined),
        async ({ host, collector }) => {
          const first = host.get("A");
          expect(host.get("A")).toBe(first);
          const connect = (id: string) =>
            attachMclient({ host, events: collector, machineId: id, root, exports: [{ name: "docs", path: root }] });
          const da = await connect("A");
          const db = await connect("B");
          try {
            expect(host.list()).toMatchObject([
              { machineId: "A", tags: ["fast", "local"], generation: 1, peer: { kind: "client" }, capabilities: ["fs.read", "kernel.py"] },
              { machineId: "B", tags: ["other"], generation: 1, peer: { kind: "client" }, capabilities: ["fs.read", "kernel.py"] },
            ]);
            host.list()[0]?.tags.push("mutated");
            expect(host.list()[0]?.tags).toEqual(["fast", "local"]);
            expect((await first.fs.read(join(root, "data"))).data).toEqual(data);
            const request = { cellId: "route", code: "'route'", timeoutMs: 15_000 };
            const results = await Promise.all([
              first.runCode(request),
              host.get("B").runCode(request),
            ]);
            expect(results).toMatchObject([
              { status: "completed", value: "'route'" },
              { status: "completed", value: "'route'" },
            ]);
          } finally {
            await da.stop();
            await db.stop();
          }
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("peekCode answers unknown cells locally and forwards an active cell to its peer", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const peeked: string[] = [];
    await withHost(
      () => ({ ...enrollment, allowedCapabilities: ["kernel.py"] }),
      async ({ host, path }) => {
        const peer = await connectIpcClient(path, { onRequest: async (method, params, respond) => {
          if (method === Machine.WireMethod.PeekCode) {
            const { cellId } = Machine.PeekCode.parse(params);
            peeked.push(cellId);
            respond({ running: true, output: { stdout: "so far\n", stderr: "warn\n" } });
            return;
          }
          if (method !== Machine.WireMethod.RunCode) throw new Error(`unexpected peer request: ${method}`);
          const request = Machine.CellRequest.parse(params);
          entered.resolve();
          await release.promise;
          respond({ status: "completed", cellId: request.cellId, output: { stdout: "done\n", stderr: "" } });
        } });
        try {
          expect(await peer.call(Machine.WireMethod.Attach, {
            ...offer({ offeredCapabilities: ["kernel.py"] }),
            peer: { kind: "client", contractVersion: Machine.contractVersion },
          })).toMatchObject({ status: "attached" });
          const handle = host.get("mac-studio");
          expect(await handle.peekCode("nobody")).toEqual({ running: false, output: { stdout: "", stderr: "" } });
          expect(peeked).toEqual([]);
          const running = handle.runCode({ cellId: "live", code: "x", timeoutMs: 5000 });
          await entered.promise;
          expect(await handle.peekCode("live")).toEqual({ running: true, output: { stdout: "so far\n", stderr: "warn\n" } });
          expect(peeked).toEqual(["live"]);
          release.resolve();
          expect(await running).toMatchObject({ status: "completed", cellId: "live" });
          expect(await handle.peekCode("live")).toEqual({ running: false, output: { stdout: "", stderr: "" } });
          expect(peeked).toEqual(["live"]);
        } finally { release.resolve(); await peer.close(); }
      },
    );
  });

  test("enrolled daemon attaches with the enrollment∩offer effective set and the attached event", async () => {
    await withHost(
      () => enrollment,
      async ({ host, collector }) => {
        const client = await attachMclient({ host, events: collector, machineId: "mac-studio", root: tmpdir(), exports: [] });
        expect(host.list().find((entry) => entry.machineId === "mac-studio")?.capabilities).toEqual(
          ["shell.exec"],
        );
        expect(collector.events.filter((event) => event.name === Machine.Events.Attached.name)).toEqual([{
          name: Machine.Events.Attached.name,
          payload: { machineId: "mac-studio", time: 5000, effectiveCapabilities: ["shell.exec"] },
        }]);
        await client.stop();
      },
    );
  });

  test("unknown machine is refused machine_not_enrolled and never attaches", async () => {
    await withHost(
      () => undefined,
      async ({ host, path, collector }) => {
        const peer = await connectIpcClient(path);
        expect(await peer.call(Machine.WireMethod.Attach, {
          ...offer(), peer: { kind: "client", contractVersion: Machine.contractVersion },
        })).toEqual({ status: "refused", reason: "machine_not_enrolled" });
        expect(
          host.list().find((entry) => entry.machineId === "mac-studio")?.capabilities,
        ).toBeUndefined();
        expect(collector.events).toEqual([]);
        await peer.close();
      },
    );
  });

  test("a resolver answering with another machine's enrollment is refused machine_mismatch", async () => {
    await withHost(
      () => ({ ...enrollment, machineId: "other-box" }),
      async ({ path, collector }) => {
        const peer = await connectIpcClient(path);
        expect(await peer.call(Machine.WireMethod.Attach, {
          ...offer(), peer: { kind: "client", contractVersion: Machine.contractVersion },
        })).toEqual({ status: "refused", reason: "machine_mismatch" });
        expect(collector.events).toEqual([]);
        await peer.close();
      },
    );
  });

  test("a malformed offer is a remote protocol error, not a refusal", async () => {
    await withHost(
      () => enrollment,
      async ({ path }) => {
        const client = await connectIpcClient(path);
        try {
          await expect(
            client.call("machine.attach", { machineId: "mac-studio" }),
          ).rejects.toBeInstanceOf(IpcRemoteError);
          expect(await client.call("machine.attach", { ...offer(), peer: { kind: "daemon", contractVersion: 2 } })).toEqual({
            status: "attached",
            generation: 1,
            effectiveCapabilities: ["fs.read"],
            effectiveExports: [],
          });
        } finally {
          client.close();
        }
      },
    );
  });

  test("daemon disconnect publishes machine.detached with connection_closed", async () => {
    await withHost(
      () => enrollment,
      async ({ host, collector }) => {
        const daemon = await attachMclient({ host, events: collector, machineId: "mac-studio", root: tmpdir(), exports: [] });
        const detached = collector.next("machine.detached");
        await daemon.stop();
        expect((await detached).payload).toEqual({
          machineId: "mac-studio",
          time: 5000,
          reason: "connection_closed",
        });
        expect(
          host.list().find((entry) => entry.machineId === "mac-studio")?.capabilities,
        ).toBeUndefined();
      },
    );
  });

  test("a neverSupersede machine refuses the second offer and the incumbent stays authoritative (#1271)", async () => {
    await withHost(
      () => enrollment,
      async ({ host, path, collector }) => {
        const first = await attachMclient({ host, events: collector, machineId: "mac-studio", root: tmpdir(), exports: [] });
        const second = await connectIpcClient(path);
        expect(await second.call(Machine.WireMethod.Attach, {
          ...offer({ offeredCapabilities: ["shell.exec"] }),
          peer: { kind: "client", contractVersion: Machine.contractVersion },
        })).toEqual({ status: "refused", reason: "already_attached" });
        // No detach was published; the incumbent keeps its negotiated plane.
        expect(collector.events.map((event) => event.name)).not.toContain("machine.detached");
        expect(host.list().find((entry) => entry.machineId === "mac-studio")?.capabilities).toEqual(
          ["shell.exec"],
        );
        await second.close();
        await first.stop();
      },
      undefined,
      ["mac-studio"],
    );
  });

  test("re-attach over a new connection supersedes the stale attachment", async () => {
    await withHost(
      () => enrollment,
      async ({ host, path, collector }) => {
        const first = await attachMclient({ host, events: collector, machineId: "mac-studio", root: tmpdir(), exports: [] });
        const superseded = collector.next("machine.detached");
        const second = await connectIpcClient(path);
        const result = await second.call(Machine.WireMethod.Attach, {
          ...offer({ offeredCapabilities: ["shell.exec"] }),
          peer: { kind: "client", contractVersion: Machine.contractVersion },
        });
        expect((await superseded).payload).toEqual({
          machineId: "mac-studio",
          time: 5000,
          reason: "superseded",
        });
        expect(result).toEqual({
          status: "attached",
          generation: 2,
          effectiveCapabilities: ["shell.exec"],
          effectiveExports: [],
        });
        expect(host.list().find((entry) => entry.machineId === "mac-studio")?.capabilities).toEqual(
          ["shell.exec"],
        );
        await second.close();
        await first.stop();
      },
    );
  });

  test("host socket is owner-only — the localhost trust boundary is real", async () => {
    await withHost(
      () => enrollment,
      async ({ path }) => {
        expect(statSync(path).mode & 0o777).toBe(0o600);
      },
    );
  });


  test("daemon relays a cell's tool call to the host and cancels the cell on the wire", async () => {
    const calls: Machine.ToolCall[] = [];
    const relayed = Promise.withResolvers<void>();
    await withHost(
      () => kernelEnrollment(enrollment),
      async ({ host, collector }) => {
        const daemon = await attachMclient({ host, events: collector, machineId: "mac-studio", root: tmpdir(), exports: [] });
        try {
          const controller = new AbortController();
          const running = host
            .get("mac-studio")
            .runCode({ cellId: "relay", code: "tool.answer()\nimport threading\nthreading.Event().wait()", timeoutMs: 5000 }, controller.signal);
          await relayed.promise;
          expect(calls).toEqual([{ cellId: "relay", name: "answer", arguments: {} }]);
          controller.abort();
          expect(await running).toMatchObject({ status: "cancelled", cellId: "relay" });
        } finally {
          await daemon.stop();
        }
      },
      async (call) => {
        calls.push(call);
        relayed.resolve();
        return { status: "completed", value: 42 };
      },
    );
  });


  test("pty.session is offered only when tmux resolves at attach time, and enrollment can withhold it (#1273)", async () => {
    const ptyOffer = offer({ offeredCapabilities: ["pty.session"] });
    await withHost(
      () => ({ ...enrollment, allowedCapabilities: ["pty.session"] }),
      async ({ path }) => {
        const withTmux = await attachMachineDaemon({ socketPath: path, offer: ptyOffer });
        expect(withTmux.attachment).toEqual({
          status: "attached",
          generation: 1,
          effectiveCapabilities: ["pty.session"],
          effectiveExports: [],
        });
        await withTmux.close();
        const withoutTmux = await attachMachineDaemon({
          socketPath: path,
          offer: ptyOffer,
          pty: { tmux: "oni-test-no-such-tmux" },
        });
        expect(withoutTmux.attachment).toEqual({
          status: "attached",
          generation: 2,
          effectiveCapabilities: [],
          effectiveExports: [],
        });
        await withoutTmux.close();
      },
    );
    await withHost(
      // The default enrollment never granted pty.session: the intersection
      // withholds it even though tmux is installed and the daemon offers it.
      () => enrollment,
      async ({ host, path }) => {
        const daemon = await attachMachineDaemon({
          socketPath: path,
          offer: offer({ offeredCapabilities: ["shell.exec", "pty.session"] }),
        });
        expect(daemon.attachment).toEqual({
          status: "attached",
          generation: 1,
          effectiveCapabilities: ["shell.exec"],
          effectiveExports: [],
        });
        expect(await host.get("mac-studio").pty.open("qa", "/")).toEqual({
          status: "refused",
          reason: "pty_not_available",
        });
        daemon.close();
      },
    );
  });

  test("pty_open confines cwd under the same export rule as exec and refuses before any session exists (#1273)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pty-export-"));
    const outside = mkdtempSync(join(tmpdir(), "pty-outside-"));
    symlinkSync(outside, join(root, "leak"));
    try {
      await withHost(
        () => ({ ...enrollment, allowedCapabilities: ["pty.session"], allowedExports: ["work"] }),
        async ({ host, path }) => {
          const daemon = await attachMachineDaemon({
            socketPath: path,
            offer: offer({ offeredCapabilities: ["pty.session"], exports: [{ name: "work", path: root }] }),
            fsExports: new Map([["work", root]]),
          });
          expect(daemon.attachment).toEqual({
            status: "attached",
            generation: 1,
            effectiveCapabilities: ["pty.session"],
            effectiveExports: ["work"],
          });
          const handle = host.get("mac-studio");
          // #1512: the consumer resolves a declared cwd against the attachment's effective roots through the host.
          expect(host.native.exports("mac-studio")).toEqual([{ name: "work", path: root }]);
          expect(() => host.native.exports("unknown-machine")).toThrow(/machine is not attached/);
          expect(await handle.pty.open("qa", "/")).toEqual({ status: "refused", reason: "path_escapes_export" });
          // A symlink under the export escapes it: refused before tmux runs.
          expect(await handle.pty.open("qa", join(root, "leak"))).toEqual({
            status: "refused",
            reason: "path_escapes_export",
          });
          daemon.close();
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("#1512 r2 L11: the export listing reads the one effective root set routing does — an offered export the enrollment does not allow is absent, and a root two allowed exports share is dropped because `location` refuses it as ambiguous", async () => {
    const root = mkdtempSync(join(tmpdir(), "roots-export-"));
    const outside = mkdtempSync(join(tmpdir(), "roots-outside-"));
    mkdirSync(join(root, "sub"));
    try {
      await withHost(
        () => ({ ...enrollment, allowedCapabilities: ["fs.read"], allowedExports: ["work", "twin", "alias"] }),
        async ({ host, collector }) => {
          const daemon = await attachMclient({
            host, events: collector, machineId: "mac-studio", root,
            exports: [
              { name: "work", path: root },
              { name: "twin", path: `${outside}/` },
              { name: "alias", path: `${outside}/./` },
              { name: "unallowed", path: join(root, "sub") },
            ],
          });
          expect(daemon.info.generation).toBe(1);
          // Listed: `work` alone — `twin` and `alias` share one normalized root, `unallowed` is not the enrollment's.
          expect(host.native.exports("mac-studio")).toEqual([{ name: "work", path: root }]);
          const handle = host.get("mac-studio");
          // Routed the same way: the shared root is refused, the unallowed longer root is no candidate (its path
          // resolves through `work`), and a path outside every effective root is refused.
          await expect(handle.fs.stat(outside)).rejects.toMatchObject({ _tag: "MachineRefusalError", reason: "ambiguous_export" });
          expect(await handle.fs.stat(join(root, "sub"))).toMatchObject({ op: "stat", kind: "dir" });
          await expect(handle.fs.stat(join(tmpdir(), "nowhere-in-any-export"))).rejects.toMatchObject({
            _tag: "MachineRefusalError",
            reason: "export_not_available",
          });
          await daemon.stop();
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
