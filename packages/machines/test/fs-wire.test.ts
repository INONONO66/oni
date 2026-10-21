import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import net from "node:net";
import { connectIpcClient, createIpcServer, typedCall } from "./ipc/helpers/native";
import { Machine } from "@oni/protocol";
import { attachMachineDaemon, createMachineHost, MachineRefusalError } from "./helpers/native";
import { socketPath } from "./helpers/socket-path";
import { startProxy } from "./helpers/proxy";
import { eventCollector } from "./helpers/events";

import {
  capabilities,
  enrollment,
  offer,
  silent,
  wireHost,
  wireDaemon,
  expectKernelUnavailable,
} from "./helpers";
async function fixture(run: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "om-wire-"));
  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("real machine consumer surface", () => {
  test("write/read/list/stat preserve binary bytes and raw metadata", async () => {
    await fixture(async (root) => {
      const path = socketPath();
      const host = await wireHost(path);
      const daemon = await wireDaemon(path, root);
      try {
        const target = host.get("m-1");
        const bytes = Buffer.from([0, 255, 128, 10, 65]);
        expect(await target.fs.write(join(root, "data"), bytes)).toEqual({
          op: "write",
          bytesWritten: 5,
        });
        expect(await target.fs.read(join(root, "data"))).toEqual({
          op: "read",
          data: bytes,
          bytesRead: 5,
          size: 5,
          truncated: false,
        });
        expect(await target.fs.list(root)).toEqual({
          op: "list",
          entries: [{ name: "data", kind: "file", size: 5 }],
          truncated: false,
        });
        expect(await target.fs.stat(join(root, "data"))).toMatchObject({
          op: "stat",
          kind: "file",
          size: 5,
        });
        expect(await target.fs.write(join(root, "data"), Buffer.from("x"))).toEqual({
          op: "write",
          bytesWritten: 1,
        });
        expect((await target.fs.read(join(root, "data"))).data).toEqual(Buffer.from("x"));
        await expect(target.fs.read("/outside-export")).rejects.toMatchObject({
          _tag: "MachineRefusalError",
          reason: "export_not_available",
        });
      } finally {
        await daemon.close();
        host.close();
      }
    });
  });

  test("streams 10 MiB through the host and daemon with matching SHA-256", async () => {
    await fixture(async (root) => {
      const path = socketPath();
      const host = await wireHost(path);
      const daemon = await wireDaemon(path, root);
      try {
        const bytes = Buffer.alloc(10 * 1024 * 1024);
        for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;
        const expected = createHash("sha256").update(bytes).digest("hex");
        expect(await host.get("m-1").fs.write(join(root, "bulk"), bytes)).toEqual({
          op: "write", bytesWritten: bytes.length,
        });
        const first = await host.get("m-1").fs.read(join(root, "bulk"), { limit: bytes.length });
        expect(first.bytesRead).toBe(8 * 1024 * 1024);
        expect(first.truncated).toBe(true);
        const second = await host.get("m-1").fs.read(join(root, "bulk"), { offset: first.bytesRead, limit: bytes.length });
        expect(second.bytesRead).toBe(bytes.length - first.bytesRead);
        expect(second.truncated).toBe(false);
        expect(createHash("sha256").update(first.data).update(second.data).digest("hex")).toBe(expected);
        const defaultRead = await host.get("m-1").fs.read(join(root, "bulk"));
        expect(defaultRead.bytesRead).toBe(Machine.FS_READ_MAX_BYTES);
        expect(defaultRead.truncated).toBe(true);
      } finally {
        await daemon.close();
        host.close();
      }
    });
  }, 30_000);

  test("a write-only attachment can finish its own streamed write", async () => {
    await fixture(async (root) => {
      const path = socketPath();
      const host = await createMachineHost({
        listen: { unix: path },
        enrollment: () => ({ ...enrollment(), allowedCapabilities: ["fs.write"] }),
        events: silent,
        now: () => 3,
      });
      const daemon = await attachMachineDaemon({
        socketPath: path,
        offer: offer(root, { offeredCapabilities: ["fs.write"] }),
        fsExports: new Map([["docs", root]]),
      });
      try {
        const bytes = Buffer.alloc(Machine.FS_WRITE_MAX_BYTES + 1, 42);
        expect(await host.get("m-1").fs.write(join(root, "write-only"), bytes))
          .toEqual({ op: "write", bytesWritten: bytes.length });
        expect(await Bun.file(join(root, "write-only")).bytes()).toEqual(bytes);
      } finally {
        await daemon.close();
        host.close();
      }
    });
  });

  test("unattached handles throw typed refusal and a capability fold grants no extra authority", async () => {
    await fixture(async (root) => {
      const path = socketPath();
      const host = await createMachineHost({
        listen: { unix: path },
        enrollment: () => ({ ...enrollment(), allowedCapabilities: ["fs.read"] }),
        events: silent,
        now: () => 3,
      });
      await expect(host.get("missing").fs.stat(root)).rejects.toBeInstanceOf(MachineRefusalError);
      const daemon = await attachMachineDaemon({
        socketPath: path,
        offer: offer(root),
        fsExports: new Map([["docs", root]]),
      });
      try {
        await expect(
          host.get("m-1").fs.write(join(root, "no"), Buffer.from("no")),
        ).rejects.toMatchObject({
          _tag: "MachineRefusalError",
          reason: "fs_not_available",
        });
        expect(await host.get("m-1").exec("echo no", root)).toEqual({
          status: "refused",
          reason: "exec_not_available",
        });
        await expectKernelUnavailable(
          host.get("m-1").runCode({ cellId: "no", code: "no", timeoutMs: 1000 }),
        );
      } finally {
        await daemon.close();
        host.close();
      }
    });
  });

  test("exec documents pathname TOCTOU after an export symlink swap", async () => {
    await fixture(async (base) => {
      const first = join(base, "first");
      const moved = join(base, "moved");
      const second = join(base, "second");
      const link = join(base, "root");
      mkdirSync(first);
      mkdirSync(second);
      writeFileSync(join(first, "mark"), "FIRST");
      writeFileSync(join(second, "mark"), "SECOND");
      symlinkSync(first, link);
      const path = socketPath();
      const host = await wireHost(path);
      const daemon = await wireDaemon(path, link);
      try {
        renameSync(first, moved);
        rmSync(link);
        symlinkSync(second, link);
        // Contract contrast on one wire: the fs branch keeps its root pinned at attach and still reads FIRST,
        // while exec re-resolves and spawns by pathname, so the accepted TOCTOU follows SECOND.
        expect((await host.get("m-1").fs.read(join(link, "mark"))).data).toEqual(
          Buffer.from("FIRST"),
        );
        await expect(host.get("m-1").exec("cat mark", link)).resolves.toMatchObject({
          status: "completed",
          stdout: Buffer.from("SECOND"),
        });
      } finally {
        await daemon.close();
        host.close();
      }
    });
  });

  test("exec uses each explicit cwd and returns independent stdout, stderr, exit and signal", async () => {
    await fixture(async (root) => {
      const a = join(root, "a");
      const b = join(root, "b");
      mkdirSync(a);
      mkdirSync(b);
      writeFileSync(join(a, "mark"), "A");
      writeFileSync(join(b, "mark"), "B");
      const path = socketPath();
      const host = await wireHost(path);
      const daemon = await wireDaemon(path, root);
      try {
        const target = host.get("m-1");
        await expect(target.exec("true", "/tmp")).resolves.toEqual({
          status: "refused",
          reason: "path_escapes_export",
        });
        expect(await target.exec("cat mark; printf err >&2; cd /; exit 7", a)).toEqual({
          status: "completed",
          stdout: Buffer.from("A"),
          stderr: Buffer.from("err"),
          exitCode: 7,
          signal: null,
          truncated: false,
        });
        expect(await target.exec("cat mark", b)).toMatchObject({
          status: "completed",
          stdout: Buffer.from("B"),
          exitCode: 0,
        });
        expect(await target.exec("cat mark", a)).toMatchObject({
          status: "completed",
          stdout: Buffer.from("A"),
        });
        expect(await target.exec("kill -TERM $$", a)).toMatchObject({
          status: "completed",
          exitCode: null,
          signal: "SIGTERM",
        });
        await expect(target.exec("true", join(root, "absent"))).rejects.toMatchObject({
          _tag: "TransportFailure", operation: "exec.call", cause: expect.stringContaining("ENOENT"),
        });
        symlinkSync("/tmp", join(root, "outside"));
        await expect(target.exec("true", join(root, "outside"))).resolves.toEqual({
          status: "refused",
          reason: "path_escapes_export",
        });
        const capped = await target.exec("yes x", root);
        expect(capped.status).toBe("completed");
        if (capped.status !== "completed") throw new Error("expected a capped execution result");
        expect(capped.truncated).toBe(true);
        expect(capped.stdout.length + capped.stderr.length).toBe(Machine.EXEC_MAX_BYTES);
      } finally {
        await daemon.close();
        host.close();
      }
    });
  });
});

test("the longest effective normalized root wins — an offered root the enrollment does not allow is no candidate — and equal roots refuse rather than selecting arbitrarily", async () => {
  await fixture(async (root) => {
    const nested = join(root, "nested");
    mkdirSync(nested);
    const path = socketPath();
    const host = await wireHost(path);
    const twoExports = {
      exports: [
        { name: "docs", path: root },
        { name: "private", path: `${nested}/./` },
      ],
    };
    /** A scripted daemon: records the export and relative path the host routed each fs_op to, answers a stat. */
    const routed: string[] = [];
    const scripted = (socket: string) =>
      connectIpcClient(socket, {
        onRequest: async (method, params, respond) => {
          if (method !== "machine.fs_op") throw new Error(`unexpected ${method}`);
          const request = Machine.FsRequest.parse(params);
          routed.push(`${request.export}:${request.path}`);
          respond({ status: "completed", value: { op: "stat", kind: "file", size: 1, mtimeMs: 0 } });
        },
      });
    // The enrollment allows `docs` alone: `private`, though offered and the longer root, is not a candidate
    // (#1512 r2 L11 — the host routes by the roots the daemon negotiated), so the path resolves through `docs`.
    const client = await scripted(path);
    try {
      await client.call("machine.attach", offer(root, twoExports));
      expect(await host.get("m-1").fs.stat(join(nested, "file"))).toMatchObject({ op: "stat", kind: "file", size: 1 });
      expect(routed).toEqual(["docs:nested/file"]);
    } finally {
      client.close();
    }
    // Both allowed: the longest root wins.
    const bothPath = socketPath();
    const both = await createMachineHost({
      listen: { unix: bothPath },
      enrollment: () => ({ ...enrollment(), allowedExports: ["docs", "private"] }),
      events: silent,
      now: () => 3,
    });
    const bothClient = await scripted(bothPath);
    try {
      await bothClient.call("machine.attach", offer(root, twoExports));
      expect(await both.get("m-1").fs.stat(join(nested, "file"))).toMatchObject({ op: "stat", kind: "file", size: 1 });
      expect(routed).toEqual(["docs:nested/file", "private:file"]);
    } finally {
      bothClient.close();
      both.close();
    }
    // Two ALLOWED exports naming one root: refused as ambiguous rather than selected arbitrarily.
    const aliasPath = socketPath();
    const aliased = await createMachineHost({
      listen: { unix: aliasPath },
      enrollment: () => ({ ...enrollment(), allowedExports: ["docs", "alias"] }),
      events: silent,
      now: () => 3,
    });
    const duplicate = await attachMachineDaemon({
      socketPath: aliasPath,
      offer: offer(root, {
        exports: [
          { name: "docs", path: root },
          { name: "alias", path: `${root}/./` },
        ],
      }),
    });
    try {
      await expect(aliased.get("m-1").fs.stat(root)).rejects.toMatchObject({
        _tag: "MachineRefusalError",
        reason: "ambiguous_export",
      });
    } finally {
      await duplicate.close();
      aliased.close();
      host.close();
    }
  });
});

describe("daemon boundary cannot be bypassed by a rogue host", () => {
  test("disconnect during a staged write fails typed and clears daemon transfer state", async () => {
    await fixture(async (root) => {
      writeFileSync(join(root, "target"), "original");
      const path = socketPath();
      const proxyPath = socketPath();
      const events = eventCollector();
      const host = await createMachineHost({ listen: { unix: path }, enrollment, events: events.sink, now: () => 3 });
      const discarded = Promise.withResolvers<void>();
      const scheduled = Promise.withResolvers<void>();
      let proxy!: Awaited<ReturnType<typeof startProxy>>;
      proxy = await startProxy(proxyPath, () => net.connect(path), (line) => {
        const frame = JSON.parse(line);
        if (frame.type !== "response" || frame.result?.status !== "written") return false;
        discarded.resolve();
        queueMicrotask(() => proxy.sever());
        return true;
      });
      const daemon = await attachMachineDaemon({
        socketPath: proxyPath, offer: offer(root), fsExports: new Map([["docs", root]]),
        reconnect: { scheduler: { schedule: () => { scheduled.resolve(); return () => undefined; } }, random: () => 1 },
      });
      try {
        const detached = events.next(Machine.Events.Detached.name);
        const pending = host.get("m-1").fs.write(join(root, "target"), Buffer.alloc(Machine.FS_WRITE_MAX_BYTES + 1, 42));
        await discarded.promise;
        await expect(pending).rejects.toMatchObject({ _tag: "MachineRefusalError", reason: "disconnected" });
        await detached;
        await scheduled.promise;
        expect(readFileSync(join(root, "target"), "utf8")).toBe("original");
        expect(readdirSync(root)).toEqual(["target"]);
      } finally {
        await daemon.close();
        await proxy.stop();
        host.close();
      }
    });
  });

  test("a lost write acknowledgement resumes by transfer id and sequence", async () => {
    await fixture(async (root) => {
      const path = socketPath();
      const proxyPath = socketPath();
      const host = await createIpcServer(path, (_method, _params, respond) =>
        respond({ status: "attached", effectiveCapabilities: capabilities, effectiveExports: ["docs"] }),
      );
      const dropped = Promise.withResolvers<void>();
      let discarded = false;
      const proxy = await startProxy(proxyPath, () => net.connect(path), (line) => {
        const frame = JSON.parse(line);
        if (discarded || frame.type !== "response" || frame.result?.status !== "written") return false;
        discarded = true;
        dropped.resolve();
        return true;
      });
      const daemon = await attachMachineDaemon({
        socketPath: proxyPath, offer: offer(root), fsExports: new Map([["docs", root]]),
      });
      try {
        const transferId = "dropped-ack";
        const data = Buffer.from("resume exact bytes");
        expect(await typedCall(host, Machine.WireMethod.FsStream, {
          op: "begin", mode: "write", transferId, export: "docs", path: "resumed",
        })).toMatchObject({ status: "begun", seq: 0 });
        const chunk = {
          op: "write", transferId, seq: 0, data: data.toString("base64"), last: true,
          digest: createHash("sha256").update(data).digest("hex"),
        } as const;
        const unanswered = typedCall(host, Machine.WireMethod.FsStream, chunk, 200);
        await dropped.promise;
        await expect(unanswered).rejects.toMatchObject({ _tag: "IpcTimeoutError" });
        expect(await typedCall(host, Machine.WireMethod.FsStream, chunk)).toEqual({
          status: "written", seq: 0, bytesWritten: data.length, last: true,
        });
        expect(await typedCall(host, Machine.WireMethod.FsStream, { op: "finish", transferId })).toEqual({ status: "finished" });
        expect((await Bun.file(join(root, "resumed")).bytes())).toEqual(data);
      } finally {
        await daemon.close();
        await proxy.stop();
        host.close();
      }
    });
  });

  test.each([
    "read",
    "write",
  ] as const)("rechecks %s capabilities even when the host fabricates an effective grant", async (op) => {
    await fixture(async (root) => {
      const path = socketPath();
      const host = await createIpcServer(path, (_method, _params, respond) =>
        respond({
          status: "attached",
          effectiveCapabilities: capabilities,
          effectiveExports: ["docs"],
        }),
      );
      const daemon = await attachMachineDaemon({
        socketPath: path,
        offer: offer(root, { offeredCapabilities: [] }),
        fsExports: new Map([["docs", root]]),
      });
      try {
        const request: Machine.FsRequest =
          op === "write"
            ? { op, export: "docs", path: "file", data: "eA==" }
            : { op, export: "docs", path: "file" };
        expect(await typedCall(host, "machine.fs_op", request)).toMatchObject({
          status: "refused",
          reason: "fs_not_available",
        });
        expect(await typedCall(host, "machine.exec", { cmd: "echo no", cwd: root })).toEqual({
          status: "refused",
          reason: "exec_not_available",
        });
        await expectKernelUnavailable(
          typedCall(host, "machine.run_code", { cellId: "no", code: "no", timeoutMs: 1000 }),
        );
      } finally {
        await daemon.close();
        host.close();
      }
    });
  });

  test.each([
    "offer",
    "enrollment",
  ] as const)("rechecks the %s export ceiling over real wire", async (missing) => {
    await fixture(async (root) => {
      const path = socketPath();
      const host = await createIpcServer(path, (_method, _params, respond) =>
        respond({
          status: "attached",
          effectiveCapabilities: capabilities,
          effectiveExports: missing === "enrollment" ? [] : ["docs"],
        }),
      );
      const daemon = await attachMachineDaemon({
        socketPath: path,
        offer: offer(root, missing === "offer" ? { exports: [] } : {}),
        fsExports: new Map([["docs", root]]),
      });
      try {
        expect(
          await typedCall(host, "machine.fs_op", {
            op: "write",
            export: "docs",
            path: "file",
            data: "eA==",
          }),
        ).toMatchObject({ status: "refused", reason: "export_not_available" });
        expect(await typedCall(host, "machine.exec", { cmd: "true", cwd: root })).toEqual({
          status: "refused",
          reason: "path_escapes_export",
        });
      } finally {
        await daemon.close();
        host.close();
      }
    });
  });

  test("refuses exec when the offered root disagrees with daemon configuration", async () => {
    await fixture(async (root) => {
      const outside = `${root}-outside`;
      mkdirSync(outside);
      const path = socketPath();
      const host = await createIpcServer(path, (_method, _params, respond) =>
        respond({
          status: "attached",
          effectiveCapabilities: capabilities,
          effectiveExports: ["data"],
        }),
      );
      const daemon = await attachMachineDaemon({
        socketPath: path,
        offer: { ...offer(root), exports: [{ name: "data", path: root }] },
        fsExports: new Map([["data", outside]]),
      });
      try {
        expect(await typedCall(host, "machine.exec", { cmd: "true", cwd: root })).toEqual({
          status: "refused",
          reason: "path_escapes_export",
        });
        expect(await typedCall(host, "machine.exec", { cmd: "true", cwd: outside })).toEqual({
          status: "refused",
          reason: "path_escapes_export",
        });
      } finally {
        await daemon.close();
        host.close();
      }
    });
  });

  test("connection failure closes the injected runner", async () => {
    let closed = 0;
    await expect(
      attachMachineDaemon({
        socketPath: socketPath(),
        offer: offer("/tmp"),
        runner: {
          runCode: async (request) => ({
            status: "cancelled",
            cellId: request.cellId,
            output: { stdout: "", stderr: "" },
          }),
          peekCode: () => ({ stdout: "", stderr: "" }),
          close: async () => {
            closed += 1;
          },
        },
      }),
    ).rejects.toMatchObject({ _tag: "TransportFailure", operation: "daemon.connect" });
    expect(closed).toBe(1);
  });
});
