import { beforeAll, describe, expect, test } from "bun:test";
import fs, { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { Machine } from "@oni/protocol";
import { createMachineHost as nativeHost } from "../src/host";
import { createMemoryGenerationStore } from "../src/generation-store";
import { createMachineHost, refusingToolPort } from "./helpers/native";
import { connectIpcTcpClient, connectIpcWsClient } from "./ipc/helpers/native";
import { type AttachedMclient, type JoinedMclient, attachMclient, joinMclient, mclientBinary, mclientEnrollment, mclientRunOnce } from "./helpers/mclient";
import { eventCollector } from "./helpers/events";
import { exit as runExit } from "./helpers/effect";
import { socketPath } from "./helpers/socket-path";
import { daemonIdentity, daemonFingerprint, hostChainIdentity, hostIdentity, hostPin, hostRenewedIdentity, wrongIdentity } from "./ipc/helpers/tls-fixtures";

/** A ws host whose enrollment of `machineId` is the one a real join reports: the client's own key, read after the join. */
async function wsHostForJoin(options: {
  readonly identity: { readonly certificate: string; readonly privateKey: string };
  readonly port: number;
  readonly machineId: string;
  readonly joined: () => JoinedMclient | undefined;
  readonly events: ReturnType<typeof eventCollector>;
  readonly generations?: ReturnType<typeof createMemoryGenerationStore>;
}) {
  return createMachineHost({
    listen: { ws: { host: "127.0.0.1", port: options.port } },
    tls: options.identity,
    enrollment: (id) => {
      const joined = options.joined();
      return id === options.machineId && joined !== undefined
        ? mclientEnrollment(options.machineId, { publicKey: joined.receipt.publicKey })
        : undefined;
    },
    events: options.events.sink,
    ...(options.generations === undefined ? {} : { generations: options.generations }),
    now: () => 4,
  });
}

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
        tcp: { host: "127.0.0.1", port }, tls: daemonIdentity, hostPin,
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

  test("a ws listener attaches a peer into the same registry and routes its handle operations (#1830)", async () => {
    const root = mkdtempSync(join(tmpdir(), "om-listen-ws-"));
    writeFileSync(join(root, "note"), "over-ws");
    const events = eventCollector();
    const host = await createMachineHost({
      listen: { ws: { host: "127.0.0.1", port: 0 } },
      tls: hostIdentity,
      enrollment: (id) => (id === "via-ws" ? enrollment("via-ws", daemonFingerprint) : undefined),
      events: events.sink,
      now: () => 3,
    });
    try {
      expect(host.endpoints.unix).toBeUndefined();
      expect(host.endpoints.tcp).toBeUndefined();
      const port = host.endpoints.ws?.port ?? 0;
      expect(port).toBeGreaterThan(0);
      const intruder = await connectIpcWsClient({
        ws: { host: "127.0.0.1", port }, tls: wrongIdentity, hostPin,
      });
      try {
        expect(await intruder.call(Machine.WireMethod.Attach, {
          ...offer("via-ws", root), peer: { kind: "client", contractVersion: Machine.contractVersion },
        })).toEqual({ status: "refused", reason: "peer_key_mismatch" });
        expect(host.list()).toEqual([]);
      } finally {
        await intruder.close();
      }
      const overWs = await connectIpcWsClient({
        ws: { host: "127.0.0.1", port }, tls: daemonIdentity, hostPin,
      }, { onRequest: (method, params, respond) => {
        if (method !== Machine.WireMethod.FsOp) throw new Error(`unexpected peer request: ${method}`);
        expect(Machine.FsRequest.parse(params).op).toBe("read");
        respond({ status: "completed", value: { op: "read", data: Buffer.from("over-ws").toString("base64"), bytesRead: 7, size: 7, truncated: false } });
      } });
      try {
        expect(await overWs.call(Machine.WireMethod.Attach, {
          ...offer("via-ws", root), peer: { kind: "client", contractVersion: Machine.contractVersion },
        })).toMatchObject({ status: "attached" });
        expect(host.list().map((machine) => machine.machineId)).toEqual(["via-ws"]);
        const viaWs = await host.get("via-ws").fs.read(join(root, "note"));
        expect(Buffer.from(viaWs.data).toString()).toBe("over-ws");
      } finally {
        await overWs.close();
      }
    } finally {
      await host.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the real mclient joins a wss host, records its pin in the receipt, then attaches with its own certificate and serves fs and exec (#1830, #1831)", async () => {
    const root = mkdtempSync(join(tmpdir(), "om-listen-mclient-wss-"));
    writeFileSync(join(root, "note"), "wss-mclient");
    const events = eventCollector();
    let joined: JoinedMclient | undefined;
    const host = await wsHostForJoin({ identity: hostIdentity, port: 0, machineId: "desk-wss", joined: () => joined, events });
    let client: AttachedMclient | undefined;
    try {
      joined = await joinMclient({ host: `wss://127.0.0.1:${host.endpoints.ws?.port ?? 0}/machine`, hostPin, machineId: "desk-wss", root });
      // The receipt names the pin the join recorded, in the host-pin file's exact bytes.
      expect(joined.receipt.hostPin).toBe(hostPin);
      expect(joined.recordedHostPin()).toBe(hostPin);
      expect(joined.receipt).toMatchObject({ machineId: "desk-wss", allowedExports: ["workspace"] });
      client = await attachMclient({ host, events, machineId: "desk-wss", root, joined });
      expect(host.list().map((machine) => machine.machineId)).toEqual(["desk-wss"]);
      const read = await host.get("desk-wss").fs.read(join(root, "note"));
      expect(Buffer.from(read.data).toString()).toBe("wss-mclient");
      expect(await host.get("desk-wss").exec("cat note; exit 3", root)).toEqual({
        status: "completed", stdout: Buffer.from("wss-mclient"), stderr: Buffer.from(""), exitCode: 3, signal: null, truncated: false,
      });
    } finally {
      await client?.stop();
      await host.close();
      joined?.remove();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("host certificate rotation: after ONE real join, hosts serving a renewed certificate and then an ACME-style chain for the same key admit the client on the pin it recorded, and a host with a different key is refused peer_key_mismatch (#1831)", async () => {
    const root = mkdtempSync(join(tmpdir(), "om-listen-rotate-"));
    writeFileSync(join(root, "note"), "rotated");
    const generations = createMemoryGenerationStore();
    const events = eventCollector();
    let joined: JoinedMclient | undefined;
    const serve = (identity: typeof hostIdentity, port: number) =>
      wsHostForJoin({ identity, port, machineId: "desk-rotate", joined: () => joined, events, generations });
    const attached: number[] = [];
    // The one host still listening; every host below closes before the next binds the same port.
    let listening: Awaited<ReturnType<typeof serve>> | undefined = await serve(hostIdentity, 0);
    const port = listening.endpoints.ws?.port ?? 0;
    try {
      joined = await joinMclient({ host: `wss://127.0.0.1:${port}/machine`, hostPin, machineId: "desk-rotate", root });
      expect(joined.receipt.hostPin).toBe(hostPin);
      const recorded = joined.recordedHostPin();
      expect(recorded).toBe(hostPin);
      // Same key, three certificates: the join's host-pin is never rewritten.
      for (const identity of [hostIdentity, hostRenewedIdentity, hostChainIdentity]) {
        const host = listening ?? await serve(identity, port);
        listening = host;
        let client: AttachedMclient | undefined;
        try {
          client = await attachMclient({ host, events, machineId: "desk-rotate", root, joined });
          attached.push(client.info.generation);
          const read = await host.get("desk-rotate").fs.read(join(root, "note"));
          expect(Buffer.from(read.data).toString()).toBe("rotated");
        } finally {
          await client?.stop();
          await host.close();
          listening = undefined;
        }
      }
      // Three successive attachments of ONE enrolled machine, never a new enrollment.
      expect(attached).toEqual([1, 2, 3]);
      expect(joined.recordedHostPin()).toBe(recorded);
      // A different host key behind the same endpoint: refused by the recorded pin before any frame.
      listening = await serve(wrongIdentity, port);
      expect(await mclientRunOnce(joined.configPath)).toEqual({ exitCode: 3, refusal: { reason: "peer_key_mismatch" } });
      expect(listening.list()).toEqual([]);
    } finally {
      await listening?.close();
      joined?.remove();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a pty round trip completes through a dual-listener host, and source: screen answers the rendered pane (#1510)", async () => {
    const tmuxSocket = `om-listen-pty-${process.pid}`;
    const tmuxCli = (...args: string[]) => Bun.spawnSync(["tmux", "-L", tmuxSocket, ...args], { stderr: "pipe" });
    const paneFact = (format: string) => tmuxCli("display-message", "-p", "-t", "=qa:", format).stdout.toString().trimEnd();
    const unix = socketPath();
    const events = eventCollector();
    const host = await createMachineHost({
      listen: { unix, tcp: { host: "127.0.0.1", port: 0 } },
      tls: hostIdentity,
      enrollment: () => ({ ...enrollment("via-unix", unixPin), allowedCapabilities: ["pty.session"] }),
      events: events.sink,
      now: () => 3,
    });
    try {
      expect(host.endpoints.tcp?.port).toBeGreaterThan(0);
      const daemon = await attachMclient({
        host, events, machineId: "via-unix", root: "/",
        exports: [{ name: "docs", path: "/" }], tmuxSocket,
      });
      try {
        expect(daemon.info.capabilities).toContain("pty.session");
        const pty = host.get("via-unix").pty;
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
        expect(snapshot.rows).toHaveLength(Number(paneFact("#{pane_height}")));
        expect(snapshot.rows.filter((row) => row.includes("TCP-PTY-OK"))).toHaveLength(1);
        expect(snapshot.cursor).toEqual({ x: Number(paneFact("#{cursor_x}")), y: Number(paneFact("#{cursor_y}")) });
        expect(snapshot.occupant).toEqual({ pid: Number(paneFact("#{pane_pid}")), command: "tr" });
        expect(snapshot.observedAt).toBeGreaterThan(0);
        // A second snapshot is a fresh capture on the next clock tick; the byte
        // stream cursor is untouched by either.
        const again = await pty.screen("qa");
        if (again.status !== "ok") throw new Error(`screen refused: ${again.reason}`);
        expect(again).toEqual({ ...snapshot, observedAt: expect.any(Number) });
        expect(again.observedAt).toBeGreaterThanOrEqual(snapshot.observedAt);
        const after = await pty.read("qa", { cursor });
        if (after.status !== "ok") throw new Error(`read refused: ${after.reason}`);
        expect(after.data).toHaveLength(0);
        expect(await pty.close("qa")).toEqual({ status: "ok" });
        // Cleanup proof: the named session and its linked window are gone from
        // the private server; only the reserved control session remains.
        expect(tmuxCli("has-session", "-t", "=qa").exitCode).not.toBe(0);
        expect(tmuxCli("list-sessions", "-F", "#{session_name}").stdout.toString().trim().split("\n")).toEqual([
          "oni-pty-control",
        ]);
        expect(tmuxCli("list-windows", "-a", "-F", "#{window_id}").stdout.toString().trim().split("\n")).toHaveLength(1);
        expect(await pty.screen("qa")).toEqual({ status: "refused", reason: "pty_not_found" });
      } finally {
        await daemon.stop();
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
        tcp: { host: "127.0.0.1", port }, tls: wrongIdentity, hostPin,
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
      const rejoined = await connectIpcTcpClient({
        tcp: { host: "127.0.0.1", port }, tls: daemonIdentity, hostPin,
      });
      try {
        expect(await rejoined.call(Machine.WireMethod.Attach, {
          ...offer("pinned", "/tmp"), exports: undefined,
          peer: { kind: "client", contractVersion: Machine.contractVersion },
        })).toMatchObject({ status: "attached" });
        expect(host.list().map((machine) => machine.machineId)).toEqual(["pinned"]);
      } finally {
        await rejoined.close();
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
        tcp: { host: "127.0.0.1", port }, tls: daemonIdentity, hostPin,
      }, { onRequest: (method, params, respond) => {
        if (method !== Machine.WireMethod.FsOp) throw new Error(`unexpected peer request: ${method}`);
        expect(Machine.FsRequest.parse(params).op).toBe("read");
        respond({ status: "completed", value: { op: "read", data: Buffer.from("still-mine").toString("base64"), bytesRead: 10, size: 10, truncated: false } });
      } });
      const intruder = await connectIpcTcpClient({
        tcp: { host: "127.0.0.1", port },
        tls: wrongIdentity,
        hostPin,
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

  test("an empty listener set and tcp or ws without a TLS identity are typed startup failures", async () => {
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
    expect(String(empty)).toContain("at least one of unix, tcp or ws");
    const bare = await runExit(
      Effect.scoped(nativeHost({ listen: { tcp: { host: "127.0.0.1", port: 0 } }, ...common })),
    );
    expect(bare._tag).toBe("Failure");
    expect(String(bare)).toContain("a tcp listener requires the host tls identity");
    const bareWs = await runExit(
      Effect.scoped(nativeHost({ listen: { ws: { host: "127.0.0.1", port: 0 } }, ...common })),
    );
    expect(bareWs._tag).toBe("Failure");
    expect(String(bareWs)).toContain("a ws listener requires the host tls identity");
  });
});
