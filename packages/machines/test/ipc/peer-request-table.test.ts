import { describe, expect, test } from "bun:test";
import { Ipc } from "@oni/protocol";

import { IpcConnectionError, IpcRemoteError, IpcTimeoutError } from "../../src/ipc/errors";
import { classifyIpcMessage, PeerRequestTable } from "./helpers/native";
import { captureError, deferred, within } from "./helpers/signal";

type Frame = Ipc.Request | Ipc.Response | Ipc.Notification;

/** Deterministic injected id entropy (#1245): no table is constructed without one. */
function sequentialIds(prefix: string): () => string {
  let n = 0;
  return () => { n += 1; return `${prefix}-${n}`; };
}

function requestFrom(frames: Frame[], index = 0): Ipc.Request {
  const parsed = Ipc.Request.safeParse(frames[index]);
  if (!parsed.success) throw new Error(`frame ${index} was not a request`);
  return parsed.data;
}

describe("PeerRequestTable", () => {
  test("call issues an id and correlates the matching response", async () => {
    const sent: Frame[] = [];
    const issued = deferred();
    const table = new PeerRequestTable<string>({
      send: (_peer, frame) => { sent.push(frame); issued.resolve(); },
      idSource: () => "request-injected",
    });

    const call = table.call("peer-a", "compute", { n: 21 }, 1_000);
    await within(issued.promise, "request sent");
    const request = requestFrom(sent);
    expect(request.id).toBe("request-injected");
    expect(request.method).toBe("compute");
    expect(table.dispatch(Ipc.createResponse(request.id, { answer: 42 }), "peer-a")).toBe(true);
    expect(await call).toEqual({ answer: 42 });
  });

  test("a correlated error response rejects as IpcRemoteError", async () => {
    const sent: Frame[] = [];
    const issued = deferred();
    const table = new PeerRequestTable<string>({ send: (_peer, frame) => { sent.push(frame); issued.resolve(); }, idSource: sequentialIds("remote") });

    const call = captureError(table.call("peer-a", "refuse", undefined, 1_000));
    await within(issued.promise, "request sent");
    const request = requestFrom(sent);
    table.dispatch(Ipc.createErrorResponse(request.id, 1000, "no"), "peer-a");

    const error = await call;
    expect(error).toBeInstanceOf(IpcRemoteError);
    expect(error).toMatchObject({ code: 1000, message: "IPC error 1000: no" });
  });

  test("response correlation and disconnect rejection are scoped to the owning peer", async () => {
    const sent: Frame[] = [];
    const issued = deferred();
    const table = new PeerRequestTable<string>({ send: (_peer, frame) => { sent.push(frame); if (sent.length === 2) issued.resolve(); }, idSource: sequentialIds("scoped") });
    const callA = table.call("peer-a", "a", undefined, 1_000);
    const callB = table.call("peer-b", "b", undefined, 1_000);
    await within(issued.promise, "both peer requests sent");
    const requestA = requestFrom(sent, 0);
    const requestB = requestFrom(sent, 1);
    let settledA = false;
    callA.then(
      () => {
        settledA = true;
      },
      () => {
        settledA = true;
      },
    );

    table.dispatch(Ipc.createResponse(requestA.id, "wrong peer"), "peer-b");
    expect(settledA).toBe(false);

    const disconnectError = new IpcConnectionError({ message: "peer-a closed" });
    table.disconnect("peer-a", disconnectError);
    await expect(callA).rejects.toBe(disconnectError);

    table.dispatch(Ipc.createResponse(requestB.id, "survived"), "peer-b");
    expect(await callB).toBe("survived");
  });

  test("call timeout rejects with IpcTimeoutError", async () => {
    const table = new PeerRequestTable({ send: () => undefined, idSource: sequentialIds("timeout") });
    const call = table.call(undefined, "slow", undefined, 10);
    const error = await captureError(call);
    expect(error).toBeInstanceOf(IpcTimeoutError);
    expect(error).toMatchObject({ message: "request timeout: slow" });
  });

  test("disconnectAll rejects calls across peers", async () => {
    const issued = deferred();
    let count = 0;
    const table = new PeerRequestTable<string>({ send: () => { if (++count === 2) issued.resolve(); }, idSource: sequentialIds("all") });
    const first = captureError(table.call("peer-a", "a", undefined, 1_000));
    const second = captureError(table.call("peer-b", "b", undefined, 1_000));
    const error = new IpcConnectionError({ message: "endpoint closed" });
    await within(issued.promise, "both requests sent");
    table.disconnectAll(error);
    expect(await first).toBe(error);
    expect(await second).toBe(error);
  });

  test("dispatch invokes inbound request handlers with response and notification senders", () => {
    const sent: Frame[] = [];
    const table = new PeerRequestTable<string>({
      send: (_peer, frame) => sent.push(frame),
      idSource: sequentialIds("inbound"),
      onRequest: (_peer, method, params, respond, notify) => {
        respond({ method, params });
        notify("request.observed", { method });
      },
    });

    expect(table.dispatch(Ipc.createRequest("inbound-echo", "echo", { value: 1 }), "peer-a")).toBe(
      true,
    );
    expect(sent).toHaveLength(2);
    expect(Ipc.Response.parse(sent[0]).result).toEqual({ method: "echo", params: { value: 1 } });
    expect(Ipc.Notification.parse(sent[1])).toMatchObject({
      method: "request.observed",
      params: { method: "echo" },
    });
  });

  test("missing and throwing request handlers become code-1000 responses", () => {
    const missingFrames: Frame[] = [];
    const missing = new PeerRequestTable<string>({
      send: (_peer, frame) => missingFrames.push(frame),
      idSource: sequentialIds("missing"),
      missingRequestHandlerMessage: (method) => `missing ${method}`,
    });
    missing.dispatch(Ipc.createRequest("inbound-none", "none"), "peer-a");
    expect(Ipc.Response.parse(missingFrames[0]).error).toEqual({
      code: 1000,
      message: "missing none",
    });

    const failureFrames: Frame[] = [];
    const throwing = new PeerRequestTable<string>({
      send: (_peer, frame) => failureFrames.push(frame),
      idSource: sequentialIds("throwing"),
      onRequest: () => {
        throw new TypeError("handler failed");
      },
    });
    throwing.dispatch(Ipc.createRequest("inbound-boom", "boom"), "peer-a");
    expect(Ipc.Response.parse(failureFrames[0]).error).toEqual({
      code: 1000,
      message: "handler failed",
    });
  });

  test("dispatch delivers notifications and rejects unrecognized frames", () => {
    const observed: string[] = [];
    const table = new PeerRequestTable<string>({
      send: () => undefined,
      idSource: sequentialIds("notify"),
      onNotification: (_peer, method) => {
        observed.push(method);
      },
    });

    expect(table.dispatch(Ipc.createNotification("event.ready"), "peer-a")).toBe(true);
    expect(table.dispatch({ type: "mystery" }, "peer-a")).toBe(false);
    expect(observed).toEqual(["event.ready"]);
  });

  test("classifyIpcMessage is the one classifier: typed dispatch routes what it returns", () => {
    const sent: Frame[] = [];
    const seen: string[] = [];
    const table = new PeerRequestTable<string>({
      send: (_peer, frame) => sent.push(frame),
      idSource: sequentialIds("classify"),
      onNotification: (_peer, method) => {
        seen.push(`notification:${method}`);
      },
    });
    const request = Ipc.createRequest("typed-1", "ping");
    const notification = Ipc.createNotification("event.tick");
    const response = Ipc.createResponse("nobody", 1);
    expect(classifyIpcMessage(request)).toEqual({ kind: "request", value: request });
    expect(classifyIpcMessage(notification)).toEqual({ kind: "notification", value: notification });
    expect(classifyIpcMessage(response)).toEqual({ kind: "response", value: response });
    expect(classifyIpcMessage({ type: "mystery" })).toBeUndefined();
    expect(classifyIpcMessage(null)).toBeUndefined();

    for (const raw of [request, notification, response]) {
      const message = classifyIpcMessage(raw);
      if (message === undefined) throw new Error("classified above");
      table.dispatchMessage(message, "peer-a");
    }
    expect(seen).toEqual(["notification:event.tick"]);
    expect(sent).toEqual([
      Ipc.createErrorResponse("typed-1", 1000, "peer has no request handler for ping"),
    ]);
  });
});
