import { beforeAll, describe, expect, test } from "bun:test";
import fs, { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { Machine } from "@oni/protocol";
import { attachMachineDaemon as nativeDaemon } from "../src/daemon";
import { createMachineHost as nativeHost } from "../src/host";
import { createMemoryGenerationStore } from "../src/generation-store";
import { PTY_OPEN_SIZE } from "../src/pty";
import { createMachineHost, refusingToolPort } from "./helpers/native";
import { acquire } from "./ipc/helpers/effects";
import { connectIpcTcpClient } from "./ipc/helpers/native";
import { attachMclient, mclientBinary } from "./helpers/mclient";
import { eventCollector } from "./helpers/events";
import { exit as runExit } from "./helpers/effect";
import { socketPath } from "./helpers/socket-path";
import { daemonIdentity, daemonFingerprint, hostIdentity, wrongIdentity } from "./ipc/helpers/tls-fixtures";

const silent = { publish: () => undefined };
function sequentialIds(prefix: string): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${n}`;
  };
}
function enrollment(machineId: string, publicKey: Machine.KeyFingerprint): Machine.Enrollment {
  return {
    machineId,
    name: machineId,
    allowedCapabilities: ["fs.read"],
    allowedExports: ["docs"],
    publicKey,
    enrolledAt: 1,
  };
}
function offer(machineId: string, root: string): Omit<Machine.Offer, "peer" | "generation"> {
  return {
    machineId,
    daemonVersion: "test",
    platform: "darwin-arm64",
    offeredCapabilities: ["fs.read"],
    exports: [{ name: "docs", path: root }],
    offeredAt: 2,
  };
}
const unixPin: Machine.KeyFingerprint =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
beforeAll(mclientBinary, 300_000);

describe("host listener set (#1270)", () => {
  test("unix and tcp serve ONE attachment registry; unix keeps 0600", async () => {
    const root = mkdtempSync(join(tmpdir(), "om-listen-"));
    writeFileSync(join(root, "note"), "dual");
    const unix = socketPath();
    const enrollments = new Map([
      ["via-unix", enrollment("via-unix", unixPin)],
      ["via-tcp", enrollment("via-tcp", daemonFingerprint)],
    ]);
    const events = eventCollector();
    const host = await createMachineHost({
      listen: { unix, tcp: { host: "127.0.0.1", port: 0 } },
      tls: hostIdentity,
      enrollment: (id) => enrollments.get(id),
      events: events.sink,
      now: () => 3,
    });
    try {
      expect(host.endpoints.unix).toBe(unix);
      const port = host.endpoints.tcp?.port ?? 0;
      expect(port).toBeGreaterThan(0);
      expect(statSync(unix).mode & 0o777).toBe(0o600);
      const overUnix = await attachMclient({ host, events, machineId: "via-unix", root, exports: [{ name: "docs", path: root }] });
      const overTcp = await connectIpcTcpClient({
        tcp: { host: "127.0.0.1", port }, tls: daemonIdentity, hostCertificate: hostIdentity.certificate,
      }, { onRequest: (method, params, respond) => {
        if (method !== Machine.WireMethod.FsOp) throw new Error(`unexpected peer request: ${method}`);
        const request = Machine.FsRequest.parse(params);
        expect(request.op).toBe("read");
        respond({ status: "completed", value: { op: "read", data: Buffer.from("dual").toString("base64"), bytesRead: 4, size: 4, truncated: false } });
      } });
      try {
        expect(await overTcp.call(Machine.WireMethod.Attach, {
          ...offer("via-tcp", root), peer: { kind: "client", contractVersion: Machine.contractVersion },
        })).toMatchObject({ status: "attached" });
        expect(host.list().map((machine) => machine.machineId)).toEqual(["via-tcp", "via-unix"]);
        // The SAME dispatcher serves both transports: handle operations route
        // by machine identity to whichever listener the daemon came in on.
        const viaUnix = await host.get("via-unix").fs.read(join(root, "note"));
        const viaTcp = await host.get("via-tcp").fs.read(join(root, "note"));
        expect(Buffer.from(viaUnix.data).toString()).toBe("dual");
        expect(Buffer.from(viaTcp.data).toString()).toBe("dual");
      } finally {
        await overUnix.stop();
        await overTcp.close();
      }
    } finally {
      await host.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a pty round trip completes through the tcp listener of a dual-listener host (#1273 r1 F4), and source: screen answers the rendered pane (#1510)", async () => {
    const tmuxSocket = `om-listen-pty-${process.pid}`;
    const tmuxCli = (...args: string[]) => Bun.spawnSync(["tmux", "-L", tmuxSocket, ...args], { stderr: "pipe" });
    const paneFact = (format: string) => tmuxCli("display-message", "-p", "-t", "=qa:", format).stdout.toString().trimEnd();
    // The daemon's injected wall clock (#1510): every snapshot stamps the next tick.
    let ticks = 0;
    const now = () => {
      ticks += 1;
      return 1_700_000_000_000 + ticks;
    };
    const unix = socketPath();
    const host = await createMachineHost({
      listen: { unix, tcp: { host: "127.0.0.1", port: 0 } },
      tls: hostIdentity,
      enrollment: () => ({ ...enrollment("via-tcp", daemonFingerprint), allowedCapabilities: ["pty.session"] }),
      events: silent,
      now: () => 3,
    });
    try {
      const port = host.endpoints.tcp?.port ?? 0;
      const daemon = await acquire(
        nativeDaemon({
          tcp: { host: "127.0.0.1", port },
          hostCertificate: hostIdentity.certificate,
          tlsCertificate: daemonIdentity.certificate,
          tlsPrivateKey: daemonIdentity.privateKey,
          id: sequentialIds("tcp-pty-daemon"),
          dispatcherBound: 8,
          offer: { ...offer("via-tcp", "/"), offeredCapabilities: ["pty.session"] },
          fsExports: new Map([["docs", "/"]]),
          pty: { socketName: tmuxSocket, now },
        }),
      );
      try {
        expect(daemon.value.attachment.status).toBe("attached");
        const pty = host.get("via-tcp").pty;
        const opened = await pty.open("qa", "/");
        if (opened.status !== "ok") throw new Error(`open refused: ${opened.reason}`);
        // The shell becomes `tr`, so the uppercase marker can only be written
        // by the exec'd process (typed-ahead echoes stay lowercase, however
        // many the shell produces), after which the pane is quiescent: every
        // screen fact below has exactly one possible value.
        await pty.write("qa", Buffer.from("exec tr a-z A-Z\ntcp-pty-ok\n", "utf8"));
        // Event-driven drain on the daemon's long-poll; no sleeps.
        let seen = "";
        let cursor = opened.cursor;
        for (let round = 0; round < 200 && !seen.includes("TCP-PTY-OK\r\n"); round += 1) {
          const view = await pty.read("qa", { cursor, waitMs: 2000 });
          if (view.status !== "ok") throw new Error(`read refused: ${view.reason}`);
          seen += Buffer.from(view.data).toString("utf8");
          cursor = view.cursor;
        }
        expect(seen.split("TCP-PTY-OK")).toHaveLength(2);
        // #1510: the rendered pane, captured on the daemon over the same wire
        // method, equals what the tmux server itself reports for that pane.
        const snapshot = await pty.screen("qa");
        if (snapshot.status !== "ok") throw new Error(`screen refused: ${snapshot.reason}`);
        expect(snapshot.rows).toHaveLength(PTY_OPEN_SIZE.rows);
        expect(snapshot.rows).toHaveLength(Number(paneFact("#{pane_height}")));
        expect(snapshot.rows.filter((row) => row.includes("TCP-PTY-OK"))).toHaveLength(1);
        expect(snapshot.cursor).toEqual({ x: Number(paneFact("#{cursor_x}")), y: Number(paneFact("#{cursor_y}")) });
        expect(snapshot.occupant).toEqual({ pid: Number(paneFact("#{pane_pid}")), command: "tr" });
        expect(snapshot.observedAt).toBe(1_700_000_000_001);
        // A second snapshot is a fresh capture on the next clock tick; the byte
        // stream cursor is untouched by either.
        const again = await pty.screen("qa");
        if (again.status !== "ok") throw new Error(`screen refused: ${again.reason}`);
        expect(again).toEqual({ ...snapshot, observedAt: 1_700_000_000_002 });
        const after = await pty.read("qa", { cursor });
        if (after.status !== "ok") throw new Error(`read refused: ${after.reason}`);
        expect(after.data).toHaveLength(0);
        expect(await pty.close("qa")).toEqual({ status: "ok" });
        // Cleanup proof: the named session and its linked window are gone from
        // the private server; only the reserved control session remains.
        expect(tmuxCli("has-session", "-t", "=qa").exitCode).not.toBe(0);
        expect(tmuxCli("list-sessions", "-F", "#{session_name}").stdout.toString().trim().split("\n")).toEqual([
          "omo-pty-control",
        ]);
        expect(tmuxCli("list-windows", "-a", "-F", "#{window_id}").stdout.toString().trim().split("\n")).toHaveLength(1);
        expect(await pty.screen("qa")).toEqual({ status: "refused", reason: "pty_not_found" });
      } finally {
        await daemon.close();
      }
    } finally {
      await host.close();
      tmuxCli("kill-server");
      expect(tmuxCli("list-sessions").exitCode).not.toBe(0);
    }
  }, 30_000);

  test("a TCP peer whose key is not the enrollment pin is refused peer_key_mismatch before admission", async () => {
    const host = await createMachineHost({
      listen: { tcp: { host: "127.0.0.1", port: 0 } },
      tls: hostIdentity,
      enrollment: (id) => enrollments(id),
      events: silent,
      now: () => 3,
    });
    function enrollments(id: string): Machine.Enrollment | undefined {
      return id === "pinned" ? enrollment("pinned", daemonFingerprint) : undefined;
    }
    try {
      const port = host.endpoints.tcp?.port ?? 0;
      const intruder = await connectIpcTcpClient({
        tcp: { host: "127.0.0.1", port }, tls: wrongIdentity, hostCertificate: hostIdentity.certificate,
      });
      try {
        expect(await intruder.call(Machine.WireMethod.Attach, {
          ...offer("pinned", "/tmp"), exports: undefined,
          peer: { kind: "client", contractVersion: Machine.contractVersion },
        })).toEqual({ status: "refused", reason: "peer_key_mismatch" });
        expect(host.list()).toEqual([]);
      } finally {
        await intruder.close();
      }
    } finally {
      await host.close();
    }
  });

  test("same machineId under another key is refused while the valid attachment stays authoritative", async () => {
    const root = mkdtempSync(join(tmpdir(), "om-pin-"));
    writeFileSync(join(root, "note"), "still-mine");
    const host = await createMachineHost({
      listen: { tcp: { host: "127.0.0.1", port: 0 } },
      tls: hostIdentity,
      enrollment: () => enrollment("pinned", daemonFingerprint),
      events: silent,
      now: () => 3,
    });
    try {
      const port = host.endpoints.tcp?.port ?? 0;
      const legitimate = await connectIpcTcpClient({
        tcp: { host: "127.0.0.1", port }, tls: daemonIdentity, hostCertificate: hostIdentity.certificate,
      }, { onRequest: (method, params, respond) => {
        if (method !== Machine.WireMethod.FsOp) throw new Error(`unexpected peer request: ${method}`);
        expect(Machine.FsRequest.parse(params).op).toBe("read");
        respond({ status: "completed", value: { op: "read", data: Buffer.from("still-mine").toString("base64"), bytesRead: 10, size: 10, truncated: false } });
      } });
      const intruder = await connectIpcTcpClient({
        tcp: { host: "127.0.0.1", port },
        tls: wrongIdentity,
        hostCertificate: hostIdentity.certificate,
      });
      try {
        expect(await legitimate.call(Machine.WireMethod.Attach, {
          ...offer("pinned", root), peer: { kind: "client", contractVersion: Machine.contractVersion },
        })).toMatchObject({ status: "attached" });
        expect(await intruder.call("machine.attach", { ...offer("pinned", root), peer: { kind: "client", contractVersion: Machine.contractVersion } })).toEqual({
          status: "refused",
          reason: "peer_key_mismatch",
        });
        // The current valid attachment was not superseded or detached.
        expect(host.list().map((machine) => machine.machineId)).toEqual(["pinned"]);
        const read = await host.get("pinned").fs.read(join(root, "note"));
        expect(Buffer.from(read.data).toString()).toBe("still-mine");
      } finally {
        await intruder.close();
        await legitimate.close();
      }
    } finally {
      await host.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("when one of two binds fails, startup fails and the listener that DID bind is closed", async () => {
    const blocker = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() { return; } },
    });
    const unix = socketPath();
    try {
      const outcome = await runExit(
        Effect.scoped(
          nativeHost({
            listen: { unix, tcp: { host: "127.0.0.1", port: blocker.port } },
            tls: hostIdentity,
            id: sequentialIds("half-bound"),
            dispatcherBound: 8,
            callTool: refusingToolPort,
            generations: createMemoryGenerationStore(),
            enrollment: () => undefined,
            events: silent,
            now: () => 3,
          }),
        ),
      );
      expect(outcome._tag).toBe("Failure");
      // The bound unix listener was released: its socket file is gone and the
      // path binds cleanly again.
      expect(fs.existsSync(unix)).toBe(false);
      const rebound = await createMachineHost({
        listen: { unix },
        enrollment: () => undefined,
        events: silent,
        now: () => 3,
      });
      await rebound.close();
    } finally {
      blocker.stop(true);
    }
  });

  test("an empty listener set and tcp without a TLS identity are typed startup failures", async () => {
    const common = {
      id: sequentialIds("invalid"),
      dispatcherBound: 8,
      callTool: refusingToolPort,
      generations: createMemoryGenerationStore(),
      enrollment: () => undefined,
      events: silent,
      now: () => 3,
    };
    const empty = await runExit(Effect.scoped(nativeHost({ listen: {}, ...common })));
    expect(empty._tag).toBe("Failure");
    expect(String(empty)).toContain("at least one of unix or tcp");
    const bare = await runExit(
      Effect.scoped(nativeHost({ listen: { tcp: { host: "127.0.0.1", port: 0 } }, ...common })),
    );
    expect(bare._tag).toBe("Failure");
    expect(String(bare)).toContain("requires the host tls identity");
  });
});
