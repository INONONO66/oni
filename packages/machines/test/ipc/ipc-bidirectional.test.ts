import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { carriers } from "./helpers/carriers";
import { deferred, within } from "./helpers/signal";
import { transportFixture } from "./helpers/transport";

describe.each(carriers)("IPC bidirectional over $name", (carrier) => {
  const { servers, clients } = transportFixture();

  test("client receives incoming Request → onRequest fires → response sent back", async () => {
    const srv = await carrier.listen("req", () => undefined);
    servers.push(srv);

    const received = { method: "", params: { msg: "" } };
    const client = await carrier.connect(srv.endpoint, {
      onRequest(method, params, respond) {
        received.method = method;
        received.params = z.object({ msg: z.string() }).parse(params);
        respond({ echo: received.params.msg });
      },
    });
    clients.push(client);

    const result = await srv.call("ping", { msg: "hello" });

    expect(received.method).toBe("ping");
    expect(received.params).toEqual({ msg: "hello" });
    expect(result).toEqual({ echo: "hello" });
  });

  test("client receives Notification → onNotification fires", async () => {
    const srv = await carrier.listen("notif", () => undefined);
    servers.push(srv);

    let notifMethod = "";
    let notifParams: { key: string } | undefined;

    const notifReceived = deferred();
    const client = await carrier.connect(srv.endpoint, {
      onNotification(method, params) {
        notifMethod = method;
        notifParams = z.object({ key: z.string() }).parse(params);
        notifReceived.resolve();
      },
    });
    clients.push(client);

    expect(srv.notify("event.fired", { key: "value" })).toBe(true);
    await within(notifReceived.promise, "client notification");

    expect(notifMethod).toBe("event.fired");
    expect(notifParams).toEqual({ key: "value" });
  });

  test("a throwing/rejecting onNotification never escapes the socket listener", async () => {
    // A throw here would surface as an uncaughtException in the process
    // hosting the client (e.g. a parent process supervising its children).
    // The contract mirrors the server: log, keep the connection draining.
    const srv = await carrier.listen("notifThrow", () => undefined);
    servers.push(srv);

    const seen: string[] = [];
    const drained = deferred();
    const client = await carrier.connect(srv.endpoint, {
      onNotification(method) {
        seen.push(method);
        if (method === "boom.sync") throw new Error("sync handler failure");
        if (method === "boom.async") return Promise.reject(new Error("async handler failure"));
        if (method === "after.failures") drained.resolve();
      },
    });
    clients.push(client);

    expect(srv.notify("boom.sync", {})).toBe(true);
    expect(srv.notify("boom.async", {})).toBe(true);
    expect(srv.notify("after.failures", {})).toBe(true);
    await within(drained.promise, "notification drain after handler failures");

    // Both failures were contained and the connection kept draining: the
    // frame AFTER the failures still reached the handler on the same socket.
    expect(seen).toEqual(["boom.sync", "boom.async", "after.failures"]);
  });

  test("server.call() → client receives → responds → server gets result", async () => {
    const srv = await carrier.listen("srvCall", () => undefined);
    servers.push(srv);

    const client = await carrier.connect(srv.endpoint, {
      onRequest(_method, params, respond) {
        respond({ doubled: z.object({ n: z.number() }).parse(params).n * 2 });
      },
    });
    clients.push(client);

    const result = await srv.call("compute", { n: 21 });
    expect(result).toEqual({ doubled: 42 });
  });

  test("existing client.call() flow unchanged", async () => {
    const srv = await carrier.listen("clientCall", (method, params, respond) => {
      if (method === "echo") respond({ got: params?.v });
    });
    servers.push(srv);

    const client = await carrier.connect(srv.endpoint);
    clients.push(client);

    const result = await client.call("echo", { v: "unchanged" });
    expect(result).toEqual({ got: "unchanged" });
  });
});
