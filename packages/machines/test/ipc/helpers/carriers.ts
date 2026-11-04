import { connectIpcClient, connectIpcTcpClient, connectIpcWsClient, createIpcServer, createIpcTcpServer, createIpcWsServer, type IpcClient, type IpcServer } from "./native";
import { socketPath } from "./socket-path";
import { daemonIdentity, hostIdentity } from "./tls-fixtures";

type Handler = Parameters<typeof createIpcServer>[1];
type ServerOptions = Parameters<typeof createIpcServer>[2];
type ClientOptions = Parameters<typeof connectIpcClient>[1];

type CarrierServer = Omit<IpcServer, "socketPath" | "native"> & { readonly endpoint: string };

export type Carrier = {
  readonly name: "unix" | "tcp" | "ws";
  listen(name: string, handler: Handler, options?: ServerOptions): Promise<CarrierServer>;
  connect(endpoint: string, options?: ClientOptions): Promise<IpcClient>;
};

const LOOPBACK = "127.0.0.1";

/**
 * The client speaks first on every carrier, as the Rust peer does with
 * `machine.attach`: the host registers a TLS or WebSocket connection only
 * once its side of the handshake completes, which is after the client's
 * ready event. One probe round-trip is the exact state "the host can call
 * this client", so a suite may open with a host-initiated call or notify.
 */
const READY_PROBE = "carrier.ready";

function answeringReady(handler: Handler): Handler {
  return (method, params, respond, notify, connectionId) => (method === READY_PROBE ? respond({}) : handler(method, params, respond, notify, connectionId));
}

async function ready(client: IpcClient): Promise<IpcClient> {
  await client.call(READY_PROBE);
  return client;
}

function loopbackPort(endpoint: string): number {
  return Number(endpoint.slice(endpoint.lastIndexOf(":") + 1));
}

/** The three carriers behind one request/notification surface; tcp and ws present the host identity and dial as the daemon. */
export const carriers: Carrier[] = [
  {
    name: "unix",
    listen: async (name, handler, options) => {
      const server = await createIpcServer(socketPath(name), answeringReady(handler), options);
      return { ...server, endpoint: server.socketPath };
    },
    connect: (endpoint, options) => connectIpcClient(endpoint, options).then(ready),
  },
  {
    name: "tcp",
    listen: async (_name, handler, options) => {
      const server = await createIpcTcpServer({ host: LOOPBACK, port: 0, tls: hostIdentity }, answeringReady(handler), options);
      return { ...server, endpoint: `${server.host}:${server.port}` };
    },
    connect: (endpoint, options) => connectIpcTcpClient({ tcp: { host: LOOPBACK, port: loopbackPort(endpoint) }, tls: daemonIdentity, hostCertificate: hostIdentity.certificate }, options).then(ready),
  },
  {
    name: "ws",
    listen: async (_name, handler, options) => {
      const server = await createIpcWsServer({ host: LOOPBACK, port: 0, tls: hostIdentity }, answeringReady(handler), options);
      return { ...server, endpoint: `${server.host}:${server.port}` };
    },
    connect: (endpoint, options) => connectIpcWsClient({ ws: { host: LOOPBACK, port: loopbackPort(endpoint) }, tls: daemonIdentity, hostCertificate: hostIdentity.certificate }, options).then(ready),
  },
];
