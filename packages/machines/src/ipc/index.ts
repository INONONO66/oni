// Published protocol-only transport contract; product semantics stay in consumers.
export { connectIpcClient, connectIpcTcpClient } from "./client";
export type { IpcClient, IpcTcpConnectSpec } from "./client";
export * from "./errors";
export { createIpcServer, createIpcTcpServer } from "./server";
export type { IpcServer, IpcTcpServer, IpcTcpListenSpec } from "./server";
export { certificateKeyFingerprint } from "./tls";
export type { IpcTlsIdentity } from "./tls";
export { connectIpcWsClient } from "./ws-client";
export type { IpcWsConnectSpec } from "./ws-client";
export { createIpcWsServer, IPC_WS_PATH } from "./ws-server";
export type { IpcWsListenSpec, IpcWsServer } from "./ws-server";
