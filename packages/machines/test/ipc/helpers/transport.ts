import { afterEach } from "bun:test";
import net from "node:net";
import type { IpcClient, IpcServer } from "./native";
import { within } from "./signal";

/** Call inside the owning describe so cleanup follows that suite's lifecycle. */
export function transportFixture() {
  const servers: Pick<IpcServer, "close">[] = [];
  const clients: IpcClient[] = [];
  const rawSockets: net.Socket[] = [];
  afterEach(() => {
    for (const socket of rawSockets.splice(0)) socket.destroy();
    for (const client of clients.splice(0)) client.close();
    for (const server of servers.splice(0)) server.close();
  });
  return { servers, clients, rawSockets };
}

export async function connectRaw(path: string): Promise<net.Socket> {
  const socket = new net.Socket();
  const connected = new Promise<net.Socket>((resolve, reject) => {
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });
  socket.connect(path);
  let connectionSucceeded = false;
  return within(connected, "raw socket connection")
    .then((value) => {
      connectionSucceeded = true;
      return value;
    })
    .finally(() => {
      if (!connectionSucceeded) socket.destroy();
    });
}
