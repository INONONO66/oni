import { type PlainObject, PlainValueSchema } from "@oni/protocol";
import { z } from "zod";

const Frame = z.record(z.string(), PlainValueSchema);

/**
 * Shared WebSocket test plumbing: every wait is an exact-event subscription
 * with a bounded timeout that only ever fails the test.
 */

/** Resolves when the socket opens; rejects on error or after `timeoutMs`. */
function opened(ws: WebSocket, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`WebSocket open timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    ws.addEventListener(
      "error",
      () => {
        clearTimeout(timeout);
        reject(new Error("WebSocket failed before opening"));
      },
      { once: true },
    );
  });
}

/** Opens a socket to `url` and resolves once it is connected. */
export async function openSocket(
  url: string,
  protocols: string[],
  timeoutMs = 2000,
): Promise<WebSocket> {
  const ws = new WebSocket(url, protocols);
  // opened() only ever rejects with its own Error; keep that cause intact.
  await opened(ws, timeoutMs).catch(async (error: Error) => {
    await closeSocket(ws, timeoutMs);
    throw error;
  });
  return ws;
}

/** Subscribe before closing and await the transport's completion, including failed opens. */
export function closeSocket(ws: WebSocket, timeoutMs = 2000): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket close timed out")), timeoutMs);
    ws.addEventListener(
      "close",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    ws.close();
  });
}


/** The next JSON frame the predicate accepts; earlier frames are skipped. */
export function nextFrame(
  ws: WebSocket,
  accept: (frame: PlainObject) => boolean,
  timeoutMs = 10_000,
): Promise<PlainObject> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no accepted frame arrived within ${timeoutMs}ms`)),
      timeoutMs,
    );
    const listener = (event: MessageEvent) => {
      const frame = Frame.parse(JSON.parse(String(event.data)));
      if (!accept(frame)) return;
      clearTimeout(timer);
      ws.removeEventListener("message", listener);
      resolve(frame);
    };
    ws.addEventListener("message", listener);
  });
}
