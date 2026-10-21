import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import tls from "node:tls";
import {
  IpcConnectionError,
  IpcPeerKeyMismatchError,
  connectIpcClient,
  connectIpcTcpClient,
  createIpcServer,
  createIpcTcpServer,
} from "./helpers/native";
import { certificateKeyFingerprint } from "../../src";
import { captureError, deferred, within } from "./helpers/signal";
import { expectOversizeFailFast } from "./helpers/oversize";
import { socketPath } from "./helpers/socket-path";
import { daemonIdentity, daemonFingerprint, hostIdentity, hostFingerprint, hostIssuedFingerprint, hostIssuedIdentity, wrongIdentity, wrongFingerprint } from "./helpers/tls-fixtures";

describe("TLS-over-TCP IPC transport", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  type TcpServer = Awaited<ReturnType<typeof createIpcTcpServer>>;

  /** A pin-judging server: grants only the enrolled daemon fingerprint. */
  async function pinnedServer() {
    const fingerprintsSeen: (string | undefined)[] = [];
    let server!: TcpServer;
    server = await createIpcTcpServer(
      { host: "127.0.0.1", port: 0, tls: hostIdentity },
      (_method, _params, respond, _notify, connectionId) => {
        // The transport only extracts the fingerprint — the handler judges it,
        // exactly as the host will against the offered machineId's enrollment.
        const presented = server.peerFingerprintOf(connectionId);
        fingerprintsSeen.push(presented);
        if (presented !== daemonFingerprint) {
          respond({ status: "refused", reason: "peer_key_mismatch" });
          return;
        }
        respond({ status: "attached" });
      },
    );
    cleanups.push(server.close);
    return { server, fingerprintsSeen };
  }

  test("mutual TLS succeeds when both pins match, and port 0 reports the bound port", async () => {
    // The production client dials with `rejectUnauthorized: true` and the host
    // certificate as its only trust anchor: reaching secureConnect (and thus a
    // served call) IS the authorized handshake — the raw-probe variant below
    // ("a client that presents no certificate…") asserts `authorized` directly.
    const { server, fingerprintsSeen } = await pinnedServer();
    expect(server.port).toBeGreaterThan(0);

    const client = await connectIpcTcpClient({
      tcp: { host: "127.0.0.1", port: server.port },
      tls: daemonIdentity,
      hostCertificate: hostIdentity.certificate,
    });
    cleanups.push(client.close);

    expect(await client.call("machine.attach")).toEqual({ status: "attached" });
    expect(fingerprintsSeen).toEqual([daemonFingerprint]);
  });

  test("a wrong daemon key reaches the handler as the mismatching fingerprint and is refused before any machine request is served", async () => {
    const { server, fingerprintsSeen } = await pinnedServer();
    const impostor = await connectIpcTcpClient({
      tcp: { host: "127.0.0.1", port: server.port },
      tls: wrongIdentity,
      hostCertificate: hostIdentity.certificate,
    });
    cleanups.push(impostor.close);

    expect(await impostor.call("machine.attach")).toEqual({ status: "refused", reason: "peer_key_mismatch" });
    expect(fingerprintsSeen).toEqual([wrongFingerprint]);
  });

  /** Bind a rogue listener, then dial it with the PINNED client; yields the typed failure. */
  async function dialRogue(rogue: net.Server): Promise<Error> {
    await new Promise<void>((resolve) => rogue.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => rogue.close(() => resolve())));
    const address = rogue.address() as net.AddressInfo;
    return captureError(connectIpcTcpClient({
      tcp: { host: "127.0.0.1", port: address.port },
      tls: daemonIdentity,
      hostCertificate: hostIdentity.certificate,
    }));
  }

  test("a certificate outside the host chain fails the client typed before the handshake ever completes", async () => {
    const framesReceived: Buffer[] = [];
    let tcpConnections = 0;
    let secureConnections = 0;
    const impostorHost = tls.createServer(
      { cert: wrongIdentity.certificate, key: wrongIdentity.privateKey, requestCert: true, rejectUnauthorized: true, ca: [daemonIdentity.certificate] },
      (socket) => {
        secureConnections += 1;
        socket.on("data", (chunk) => framesReceived.push(chunk));
        socket.on("error", () => undefined);
      },
    );
    impostorHost.on("connection", () => { tcpConnections += 1; });
    const failure = await dialRogue(impostorHost);
    expect(failure).toBeInstanceOf(IpcPeerKeyMismatchError);
    const mismatch = failure as InstanceType<typeof IpcPeerKeyMismatchError>;
    expect(mismatch.expected).toBe(hostFingerprint);
    // Chain validation aborts the handshake BEFORE a peer certificate is
    // readable and before checkServerIdentity runs — the typed failure still
    // carries the OpenSSL verify code.
    expect(mismatch.presented).toBe("unverified");
    expect(mismatch.code).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");

    // The impostor saw the TCP dial but never a completed TLS connection —
    // and therefore not one application byte, so not one frame.
    expect(tcpConnections).toBe(1);
    expect(secureConnections).toBe(0);
    expect(framesReceived).toEqual([]);
  });

  test("a chain-valid certificate carrying a different key is refused by the pin, with zero frames served", async () => {
    // host-issued-cert.pem IS signed by host-key.pem: the chain validates and
    // only the checkServerIdentity fingerprint compare can refuse it.
    const requestsSeen: string[] = [];
    const server = await createIpcTcpServer(
      { host: "127.0.0.1", port: 0, tls: hostIssuedIdentity },
      (method, _params, respond) => { requestsSeen.push(method); respond({ ok: true }); },
    );
    cleanups.push(server.close);
    const failure = await captureError(connectIpcTcpClient({
      tcp: { host: "127.0.0.1", port: server.port },
      tls: daemonIdentity,
      hostCertificate: hostIdentity.certificate,
    }));
    expect(failure).toBeInstanceOf(IpcPeerKeyMismatchError);
    const mismatch = failure as InstanceType<typeof IpcPeerKeyMismatchError>;
    expect(mismatch.expected).toBe(hostFingerprint);
    expect(mismatch.presented).toBe(hostIssuedFingerprint);
    expect(mismatch.code).toBeUndefined();
    expect(requestsSeen).toEqual([]);
  });

  test("a TLS handshake failure is a typed failure, never a fallback to plaintext frames", async () => {
    const received: Buffer[] = [];
    let connections = 0;
    const plaintext = net.createServer((socket) => {
      connections += 1;
      socket.on("data", (chunk) => {
        received.push(chunk);
        // Garbage instead of a ServerHello: the client's TLS layer must abort.
        socket.write("not a tls server\n");
      });
      socket.on("error", () => undefined);
    });
    const failure = await dialRogue(plaintext);
    expect(failure).toBeInstanceOf(IpcConnectionError);
    // One connection attempt, and what arrived was a TLS ClientHello record
    // (0x16 handshake), never a plaintext NDJSON frame.
    expect(connections).toBe(1);
    expect(received[0]?.[0]).toBe(0x16);
  });

  test("a client that presents no certificate never becomes a connection", async () => {
    const { server, fingerprintsSeen } = await pinnedServer();
    const closed = deferred<void>();
    // assumed: the committed fixtures carry no SAN (CN=oni-test-host
    // only), so Node hostname matching cannot apply; the probe verifies the
    // chain against the committed host cert and checks identity by the SAME
    // SPKI pin production uses.
    const certless = tls.connect({
      host: "127.0.0.1",
      port: server.port,
      rejectUnauthorized: true,
      ca: [hostIdentity.certificate],
      checkServerIdentity: (_host: string, peer: tls.PeerCertificate) =>
        certificateKeyFingerprint(peer.raw) === hostFingerprint ? undefined : new Error("unexpected host certificate"),
    }, () => {
      // The probe's own handshake chain-validated the host certificate.
      expect(certless.authorized).toBe(true);
      // Mutual TLS was not satisfied; this frame must fall on the floor.
      certless.write('{"id":"r-1","method":"machine.attach"}\n');
    });
    certless.on("error", () => undefined);
    certless.on("close", () => closed.resolve());
    cleanups.push(() => certless.destroy());

    await within(closed.promise, "certless client rejection");
    expect(fingerprintsSeen).toEqual([]);
    await expect(server.call("anything")).rejects.toThrow("no connected client");
  });

  test("an unexpected disconnect settles each pending call exactly once with a typed connection failure and never replays it", async () => {
    const requestsSeen: string[] = [];
    const firstRequest = deferred<void>();
    const server = await createIpcTcpServer(
      { host: "127.0.0.1", port: 0, tls: hostIdentity },
      (method) => {
        // Never respond: the call must be settled by the disconnect, not a reply.
        requestsSeen.push(method);
        firstRequest.resolve();
      },
    );
    const client = await connectIpcTcpClient({
      tcp: { host: "127.0.0.1", port: server.port },
      tls: daemonIdentity,
      hostCertificate: hostIdentity.certificate,
    });
    cleanups.push(client.close);

    const pending = captureError(client.call("machine.run_code"));
    await within(firstRequest.promise, "request arrival");
    await server.close();

    expect(await pending).toBeInstanceOf(IpcConnectionError);
    expect(client.connected).toBe(false);
    // Nothing was retained for replay: the dead client refuses new calls and
    // the server saw the request exactly once.
    await expect(client.call("machine.run_code")).rejects.toThrow("not connected");
    expect(requestsSeen).toEqual(["machine.run_code"]);
  });

  test("an oversize frame over TCP fails fast through the shared decoder guard, not by burning its timeout", async () => {
    // The 16 MiB LineDecoder cap is transport-blind (#1270 F8): the TLS door
    // condemns the flooding connection exactly like the unix door does.
    const disconnected = deferred<string>();
    const server = await createIpcTcpServer(
      { host: "127.0.0.1", port: 0, tls: hostIdentity },
      (_method, _params, respond) => respond({ ok: true }),
      { onDisconnect: disconnected.resolve },
    );
    cleanups.push(server.close);
    const client = await connectIpcTcpClient({
      tcp: { host: "127.0.0.1", port: server.port },
      tls: daemonIdentity,
      hostCertificate: hostIdentity.certificate,
    });
    cleanups.push(client.close);

    await expectOversizeFailFast(client, disconnected.promise);
  });

  test("unix connections expose no peer fingerprint — the pin is a TLS-only fact", async () => {
    const fingerprints: (string | undefined)[] = [];
    let server!: Awaited<ReturnType<typeof createIpcServer>>;
    server = await createIpcServer(
      socketPath("network-tls-unix"),
      (_method, _params, respond, _notify, connectionId) => {
        fingerprints.push(server.peerFingerprintOf(connectionId));
        respond({ ok: true });
      },
    );
    cleanups.push(server.close);
    const client = await connectIpcClient(server.socketPath);
    cleanups.push(client.close);

    expect(await client.call("ping")).toEqual({ ok: true });
    expect(fingerprints).toEqual([undefined]);
  });
});
