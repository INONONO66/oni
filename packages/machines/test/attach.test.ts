import { Exit, Cause } from "effect";
import { describe, expect, test } from "bun:test";
import { statSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IpcRemoteError, connectIpcClient, createIpcServer, typedCall } from "./ipc/helpers/native";
import { captureError } from "./ipc/helpers/signal";
import { Machine } from "@oni/protocol";
import { attachMachineDaemon, type CodeRunner } from "./helpers/native";
import { type MachineHost, createMachineHost } from "./helpers/native";
import { socketPath } from "./helpers/socket-path";
import { eventCollector } from "./helpers/events";
import { MachineCellError } from "../src/errors";
import { kernelEnrollment } from "./helpers";
import { exit as runExit } from "./helpers/effect";

const enrollment: Machine.Enrollment = {
  name: "studio",
  machineId: "mac-studio",
  allowedCapabilities: ["fs.read", "shell.exec"],
  publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  enrolledAt: 1000,
};

function offer(overrides: Partial<Machine.Offer> = {}): Machine.Offer {
  return {
    machineId: "mac-studio",
    daemonVersion: "0.0.1",
    platform: "darwin-arm64",
    offeredCapabilities: ["fs.read", "browser.control"],
    offeredAt: 2000,
    ...overrides,
  };
}

/** A daemon offering only the kernel capability, backed by a partial code runner. */
function attachKernel(path: string, runner: Pick<CodeRunner, "runCode"> & Partial<CodeRunner>) {
  return attachMachineDaemon({
    socketPath: path,
    offer: offer({ offeredCapabilities: ["kernel.py"] }),
    runner: { peekCode: () => ({ stdout: "", stderr: "" }), close: async () => undefined, ...runner },
  });
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

  test("a host wired without a tool port refuses host_tool_missing and refuses duplicate ids", async () => {
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    await withHost(
      () => kernelEnrollment(enrollment),
      async ({ host, path }) => {
        const daemon = await attachKernel(path, {
          runCode: async (request, call) => {
            // #1312: the tool port is required; a host wired with the refusing
            // port surfaces host_tool_missing, never a fabricated failed result.
            const refusal = await call({ cellId: request.cellId, name: "missing", arguments: {} }).then(
              () => undefined,
              (error: Error) => error,
            );
            expect(String(refusal)).toContain("host_tool_missing");
            entered.resolve();
            await finish.promise;
            return {
              status: "cancelled",
              cellId: request.cellId,
              output: { stdout: "", stderr: "" },
            };
          },
        });
        const cell = { cellId: "same", code: "x", timeoutMs: 1000 };
        try {
          const handle = host.get("mac-studio");
          const running = handle.runCode(cell);
          await entered.promise;
          const duplicate = await captureError(handle.runCode(cell));
          expect(duplicate).toBeInstanceOf(MachineCellError);
          expect(duplicate).toMatchObject({
            _tag: "MachineCellError", code: "duplicate_cell_id", cellId: cell.cellId,
          });
          finish.resolve();
          expect((await running).status).toBe("cancelled");
          const preAborted = await runExit(handle.native.runCode(cell, AbortSignal.abort()));
          expect(Exit.isFailure(preAborted) && Cause.hasInterrupts(preAborted.cause)).toBe(true);
        } finally {
          finish.resolve();
          await daemon.close();
        }
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
          await client.call("machine.attach", offer({ exports: [{ name: "docs", path: "/" }] }));
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
        async ({ host, path }) => {
          const first = host.get("A");
          expect(host.get("A")).toBe(first);
          const connect = (id: string) =>
            attachMachineDaemon({
              socketPath: path,
              offer: offer({
                machineId: id,
                offeredCapabilities: ["fs.read", "kernel.py"],
                exports: [{ name: "docs", path: root }],
              }),
              fsExports: new Map([["docs", root]]),
              runner: {
                runCode: async (request) => ({
                  status: "completed",
                  cellId: request.cellId,
                  value: id,
                  output: { stdout: "", stderr: "" },
                }),
                peekCode: () => ({ stdout: "", stderr: "" }),
                close: async () => undefined,
              },
            });
          const da = await connect("A");
          const db = await connect("B");
          try {
            expect(host.list()).toEqual(
              [a, b].map((entry) => ({
                ...entry,
                tags: entry.tags ?? [],
                capabilities: ["fs.read", "kernel.py"],
                os: "darwin",
                arch: "arm64",
              })),
            );
            host.list()[0]?.tags.push("mutated");
            expect(host.list()[0]?.tags).toEqual(["fast", "local"]);
            expect((await first.fs.read(join(root, "data"))).data).toEqual(data);
            const request = { cellId: "route", code: "value", timeoutMs: 1000 };
            const results = await Promise.all([
              first.runCode(request),
              host.get("B").runCode(request),
            ]);
            expect(results).toMatchObject([
              { status: "completed", value: "A" },
              { status: "completed", value: "B" },
            ]);
          } finally {
            await da.close();
            await db.close();
          }
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("peekCode answers not-running locally for an unknown cell and forwards a live one to the daemon", async () => {
    let releaseCell!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseCell = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const peeked: string[] = [];
    await withHost(
      () => ({ ...enrollment, allowedCapabilities: ["kernel.py"] }),
      async ({ host, path }) => {
        const daemon = await attachKernel(path, {
          runCode: async (request) => {
            entered();
            await held;
            return {
              status: "completed",
              cellId: request.cellId,
              output: { stdout: "done\n", stderr: "" },
            };
          },
          peekCode: (cellId) => {
            peeked.push(cellId);
            return { stdout: "so far\n", stderr: "warn\n" };
          },
        });
        try {
          const handle = host.get("mac-studio");
          // Not in flight: answered by the host without a wire round trip.
          expect(await handle.peekCode("nobody")).toEqual({
            running: false,
            output: { stdout: "", stderr: "" },
          });
          expect(peeked).toEqual([]);
          const running = handle.runCode({ cellId: "live", code: "x", timeoutMs: 5000 });
          await started;
          expect(await handle.peekCode("live")).toEqual({
            running: true,
            output: { stdout: "so far\n", stderr: "warn\n" },
          });
          expect(peeked).toEqual(["live"]);
          releaseCell();
          expect(await running).toMatchObject({ status: "completed", cellId: "live" });
          expect(await handle.peekCode("live")).toEqual({
            running: false,
            output: { stdout: "", stderr: "" },
          });
          expect(peeked).toEqual(["live"]);
        } finally {
          releaseCell();
          await daemon.close();
        }
      },
    );
  });

  test("enrolled daemon attaches with the enrollment∩offer effective set and the attached event", async () => {
    await withHost(
      () => enrollment,
      async ({ host, path, collector }) => {
        const daemon = await attachMachineDaemon({ socketPath: path, offer: offer() });
        expect(daemon.attachment).toEqual({
          status: "attached",
          effectiveCapabilities: ["fs.read"],
          effectiveExports: [],
        });
        expect(host.list().find((entry) => entry.machineId === "mac-studio")?.capabilities).toEqual(
          ["fs.read"],
        );
        expect(collector.events).toEqual([
          {
            name: "machine.attached",
            payload: { machineId: "mac-studio", time: 5000, effectiveCapabilities: ["fs.read"] },
          },
        ]);
        daemon.close();
      },
    );
  });

  test("unknown machine is refused machine_not_enrolled and never attaches", async () => {
    await withHost(
      () => undefined,
      async ({ host, path, collector }) => {
        const daemon = await attachMachineDaemon({ socketPath: path, offer: offer() });
        expect(daemon.attachment).toEqual({ status: "refused", reason: "machine_not_enrolled" });
        expect(
          host.list().find((entry) => entry.machineId === "mac-studio")?.capabilities,
        ).toBeUndefined();
        expect(collector.events).toEqual([]);
        daemon.close();
      },
    );
  });

  test("a resolver answering with another machine's enrollment is refused machine_mismatch", async () => {
    await withHost(
      () => ({ ...enrollment, machineId: "other-box" }),
      async ({ path, collector }) => {
        const daemon = await attachMachineDaemon({ socketPath: path, offer: offer() });
        expect(daemon.attachment).toEqual({ status: "refused", reason: "machine_mismatch" });
        expect(collector.events).toEqual([]);
        daemon.close();
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
          expect(await client.call("machine.attach", offer())).toEqual({
            status: "attached",
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
      async ({ host, path, collector }) => {
        const daemon = await attachMachineDaemon({ socketPath: path, offer: offer() });
        const detached = collector.next("machine.detached");
        daemon.close();
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
        const first = await attachMachineDaemon({ socketPath: path, offer: offer() });
        expect(first.attachment.status).toBe("attached");
        const second = await attachMachineDaemon({
          socketPath: path,
          offer: offer({ offeredCapabilities: ["shell.exec"] }),
        });
        expect(second.attachment).toEqual({ status: "refused", reason: "already_attached" });
        // No detach was published; the incumbent keeps its negotiated plane.
        expect(collector.events.map((event) => event.name)).not.toContain("machine.detached");
        expect(host.list().find((entry) => entry.machineId === "mac-studio")?.capabilities).toEqual(
          ["fs.read"],
        );
        second.close();
        first.close();
      },
      undefined,
      ["mac-studio"],
    );
  });

  test("re-attach over a new connection supersedes the stale attachment", async () => {
    await withHost(
      () => enrollment,
      async ({ host, path, collector }) => {
        const first = await attachMachineDaemon({ socketPath: path, offer: offer() });
        const superseded = collector.next("machine.detached");
        const second = await attachMachineDaemon({
          socketPath: path,
          offer: offer({ offeredCapabilities: ["shell.exec"] }),
        });
        expect((await superseded).payload).toEqual({
          machineId: "mac-studio",
          time: 5000,
          reason: "superseded_by_reattach",
        });
        expect(second.attachment).toEqual({
          status: "attached",
          effectiveCapabilities: ["shell.exec"],
          effectiveExports: [],
        });
        expect(host.list().find((entry) => entry.machineId === "mac-studio")?.capabilities).toEqual(
          ["shell.exec"],
        );
        second.close();
        first.close();
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

  test("daemon rejects host requests outside its wire contract", async () => {
    const path = socketPath();
    const rogue = await createIpcServer(path, (_method, _params, respond) => {
      respond({ status: "attached", effectiveCapabilities: [], effectiveExports: [] });
    });
    try {
      const daemon = await attachMachineDaemon({ socketPath: path, offer: offer() });
      try {
        await expect(rogue.call("machine.unknown", {})).rejects.toBeInstanceOf(IpcRemoteError);
      } finally {
        daemon.close();
      }
    } finally {
      rogue.close();
    }
  });

  test("daemon relays a cell's tool call to the host and cancels the cell on the wire", async () => {
    const calls: Machine.ToolCall[] = [];
    const relayed = Promise.withResolvers<void>();
    await withHost(
      () => kernelEnrollment(enrollment),
      async ({ host, path }) => {
        const daemon = await attachKernel(path, {
          runCode: async (request, call, signal) => {
            const answer = await call({ cellId: request.cellId, name: "answer", arguments: {} });
            // The abort may already have landed while the tool answer was in flight.
            if (!signal.aborted)
              await new Promise<void>((resolve) => {
                signal.addEventListener("abort", () => resolve(), { once: true });
              });
            return {
              status: "cancelled",
              cellId: request.cellId,
              output: { stdout: JSON.stringify(answer), stderr: "" },
            };
          },
        });
        try {
          const controller = new AbortController();
          const running = host
            .get("mac-studio")
            .runCode({ cellId: "relay", code: "x", timeoutMs: 5000 }, controller.signal);
          await relayed.promise;
          expect(calls).toEqual([{ cellId: "relay", name: "answer", arguments: {} }]);
          controller.abort();
          expect(await running).toEqual({
            status: "cancelled",
            cellId: "relay",
            output: { stdout: '{"status":"completed","value":42}', stderr: "" },
          });
        } finally {
          await daemon.close();
        }
      },
      async (call) => {
        calls.push(call);
        relayed.resolve();
        return { status: "completed", value: 42 };
      },
    );
  });

  test("daemon refuses a host reply that violates Machine.AttachResult", async () => {
    const path = socketPath();
    const rogue = await createIpcServer(path, (_method, _params, respond) => {
      respond({ status: "bogus" });
    });
    try {
      await expect(attachMachineDaemon({ socketPath: path, offer: offer() })).rejects.toMatchObject(
        { _tag: "MachinesFailure", operation: "daemon.attach.response", cause: expect.stringContaining("invalid") },
      );
    } finally {
      rogue.close();
    }
  });

  test("pty.session is offered only when tmux resolves at attach time, and enrollment can withhold it (#1273)", async () => {
    const ptyOffer = offer({ offeredCapabilities: ["pty.session"] });
    await withHost(
      () => ({ ...enrollment, allowedCapabilities: ["pty.session"] }),
      async ({ path }) => {
        const withTmux = await attachMachineDaemon({ socketPath: path, offer: ptyOffer });
        expect(withTmux.attachment).toEqual({
          status: "attached",
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
        async ({ host, path }) => {
          const daemon = await attachMachineDaemon({
            socketPath: path,
            offer: offer({
              offeredCapabilities: ["fs.read"],
              exports: [
                { name: "work", path: root },
                { name: "twin", path: `${outside}/` },
                { name: "alias", path: `${outside}/./` },
                { name: "unallowed", path: join(root, "sub") },
              ],
            }),
            fsExports: new Map([["work", root], ["twin", outside], ["alias", outside], ["unallowed", join(root, "sub")]]),
          });
          expect(daemon.attachment).toMatchObject({ status: "attached", effectiveExports: ["alias", "twin", "work"] });
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
          daemon.close();
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("daemon peek_code wire answers (#1312)", () => {
  const attachedHost = (path: string) =>
    createIpcServer(path, (_method, _params, respond) =>
      respond({ status: "attached", effectiveCapabilities: ["kernel.py"], effectiveExports: [] }),
    );

  test("a daemon without a runner refuses kernel_not_available instead of fabricating empty output", async () => {
    const path = socketPath();
    const server = await attachedHost(path);
    const daemon = await attachMachineDaemon({
      socketPath: path,
      offer: offer({ offeredCapabilities: ["kernel.py"] }),
    });
    try {
      expect(await typedCall(server, "machine.peek_code", { cellId: "ghost" })).toEqual({
        status: "refused",
        reason: "kernel_not_available",
      });
    } finally {
      await daemon.close();
      server.close();
    }
  });

  test("a daemon with a runner answers an unknown cell with the runner's own empty output", async () => {
    const path = socketPath();
    const server = await attachedHost(path);
    const daemon = await attachMachineDaemon({
      socketPath: path,
      offer: offer({ offeredCapabilities: ["kernel.py"] }),
      runner: {
        runCode: async (request) => ({
          status: "cancelled",
          cellId: request.cellId,
          output: { stdout: "", stderr: "" },
        }),
        peekCode: () => ({ stdout: "", stderr: "" }),
        close: async () => undefined,
      },
    });
    try {
      expect(await typedCall(server, "machine.peek_code", { cellId: "ghost" })).toEqual({
        running: false,
        output: { stdout: "", stderr: "" },
      });
    } finally {
      await daemon.close();
      server.close();
    }
  });
});
