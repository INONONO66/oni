import { afterEach, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import {
  IpcConfigurationError,
  IpcConnectionError,
  IpcPeerKeyMismatchError,
  connectIpcClient,
  connectIpcTcpClient,
  createIpcServer,
  createIpcTcpServer,
} from "./helpers/native";
import { hostPinOf } from "../../src";
import { captureError, deferred, within } from "./helpers/signal";
import { expectOversizeFailFast } from "./helpers/oversize";
import { socketPath } from "./helpers/socket-path";
import { daemonIdentity, daemonFingerprint, hostChainIdentity, hostIdentity, hostIssuedIdentity, hostIssuedPin, hostPin, hostRenewedIdentity, unverifiedTlsOptions, wrongIdentity, wrongFingerprint, wrongPin } from "./helpers/tls-fixtures";

/** The pin of host-cert.pem, computed once by `openssl` and asserted by the Rust client over the same fixture. */
const HOST_FIXTURE_PIN = "r9E1hURv+fC1akcg+pV4WrFyDYMF+bylOUOXJ0MOBs4=";

describe("TLS-over-TCP IPC transport", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  type TcpServer = Awaited<ReturnType<typeof createIpcTcpServer>>;

  /** A pin-judging server: grants only the enrolled daemon fingerprint. */
  async function pinnedServer(identity = hostIdentity) {
    const fingerprintsSeen: (string | undefined)[] = [];
    let server!: TcpServer;
    server = await createIpcTcpServer(
      { host: "127.0.0.1", port: 0, tls: identity },
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
    const { server, fingerprintsSeen } = await pinnedServer();
    expect(server.port).toBeGreaterThan(0);

    const client = await connectIpcTcpClient({
      tcp: { host: "127.0.0.1", port: server.port },
      tls: daemonIdentity,
      hostPin,
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
      hostPin,
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
      hostPin,
    }));
  }

  test("same-key pass: a certificate reissued for the pinned key is accepted by the unchanged pin", async () => {
    const { server, fingerprintsSeen } = await pinnedServer(hostRenewedIdentity);
    expect(hostPinOf(new X509Certificate(hostRenewedIdentity.certificate).raw)).toBe(hostPin);
    expect(hostRenewedIdentity.certificate).not.toBe(hostIdentity.certificate);

    const client = await connectIpcTcpClient({
      tcp: { host: "127.0.0.1", port: server.port },
      tls: daemonIdentity,
      hostPin,
    });
    cleanups.push(client.close);

    expect(await client.call("machine.attach")).toEqual({ status: "attached" });
    expect(fingerprintsSeen).toEqual([daemonFingerprint]);
  });

  test("same-key pass: an ACME-style chain for the pinned key is served whole and accepted by the unchanged pin", async () => {
    const { server } = await pinnedServer(hostChainIdentity);
    const client = await connectIpcTcpClient({
      tcp: { host: "127.0.0.1", port: server.port },
      tls: daemonIdentity,
      hostPin,
    });
    cleanups.push(client.close);
    expect(await client.call("machine.attach")).toEqual({ status: "attached" });

    // The pin judges the leaf; the issuer behind it reaches the peer too.
    const probe = tls.connect({ host: "127.0.0.1", port: server.port, ...unverifiedTlsOptions(daemonIdentity) });
    cleanups.push(() => probe.destroy());
    const chain = await within(new Promise<tls.DetailedPeerCertificate>((resolve) => probe.once("secureConnect", () => resolve(probe.getPeerCertificate(true)))), "chain probe");
    expect(hostPinOf(chain.raw)).toBe(hostPin);
    expect(chain.issuerCertificate.subject.CN).toBe("oni-test-issuer");
  });

  test("pin mismatch: a host presenting a different key is refused typed once the handshake completes and before any byte is sent", async () => {
    const framesReceived: Buffer[] = [];
    let tcpConnections = 0;
    const secured = deferred<void>();
    const impostorHost = tls.createServer(
      { ...unverifiedTlsOptions(wrongIdentity), requestCert: true },
      (socket) => {
        socket.on("data", (chunk) => framesReceived.push(chunk));
        socket.on("error", () => undefined);
        socket.on("close", () => secured.resolve());
      },
    );
    impostorHost.on("connection", () => { tcpConnections += 1; });
    const failure = await dialRogue(impostorHost);
    expect(failure).toBeInstanceOf(IpcPeerKeyMismatchError);
    const mismatch = failure as InstanceType<typeof IpcPeerKeyMismatchError>;
    expect(mismatch.expected).toBe(hostPin);
    expect(mismatch.presented).toBe(wrongPin);

    // No chain is verified, so the handshake itself completes; the client
    // then hangs up on the key without writing one application byte.
    await within(secured.promise, "impostor saw the hang-up");
    expect(tcpConnections).toBe(1);
    expect(framesReceived).toEqual([]);
  });

  test("pin mismatch: a key behind a familiar issuer is refused by the pin, with zero requests served", async () => {
    // host-issued-cert.pem IS signed by host-key.pem; only the key is judged.
    const requestsSeen: string[] = [];
    const server = await createIpcTcpServer(
      { host: "127.0.0.1", port: 0, tls: hostIssuedIdentity },
      (method, _params, respond) => { requestsSeen.push(method); respond({ ok: true }); },
    );
    cleanups.push(server.close);
    const failure = await captureError(connectIpcTcpClient({
      tcp: { host: "127.0.0.1", port: server.port },
      tls: daemonIdentity,
      hostPin,
    }));
    expect(failure).toBeInstanceOf(IpcPeerKeyMismatchError);
    const mismatch = failure as InstanceType<typeof IpcPeerKeyMismatchError>;
    expect(mismatch.expected).toBe(hostPin);
    expect(mismatch.presented).toBe(hostIssuedPin);
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
    const certless = tls.connect({ host: "127.0.0.1", port: server.port, ...unverifiedTlsOptions() }, () => {
      // The probe judges the host exactly as production does: by the key pin.
      expect(hostPinOf(certless.getPeerCertificate(true).raw)).toBe(hostPin);
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
      hostPin,
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
      hostPin,
    });
    cleanups.push(client.close);

    await expectOversizeFailFast(client, disconnected.promise);
  });

  test("a host pin that is not 44 characters of standard base64 over 32 bytes is refused as configuration before any socket (#1831)", async () => {
    let tcpConnections = 0;
    const listener = net.createServer(() => { tcpConnections += 1; });
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => listener.close(() => resolve())));
    const port = (listener.address() as net.AddressInfo).port;
    const legacyHex = "0".repeat(64);
    for (const pin of [legacyHex, hostPin.slice(1), `${hostPin.slice(0, 43)}!`, ""]) {
      const failure = await captureError(connectIpcTcpClient({ tcp: { host: "127.0.0.1", port }, tls: daemonIdentity, hostPin: pin }));
      expect(failure).toBeInstanceOf(IpcConfigurationError);
      expect((failure as InstanceType<typeof IpcConfigurationError>).field).toBe("hostPin");
      expect((failure as InstanceType<typeof IpcConfigurationError>).message).toContain("44 characters");
    }
    expect(tcpConnections).toBe(0);
  });

  test("the committed host fixture's pin is one literal, equal in the TypeScript and Rust hashes and unchanged by its renewed certificate (#1831)", () => {
    expect(hostPin).toBe(HOST_FIXTURE_PIN);
    expect(hostPinOf(new X509Certificate(hostRenewedIdentity.certificate).raw)).toBe(HOST_FIXTURE_PIN);
    expect(hostPinOf(new X509Certificate(hostChainIdentity.certificate).raw)).toBe(HOST_FIXTURE_PIN);
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
