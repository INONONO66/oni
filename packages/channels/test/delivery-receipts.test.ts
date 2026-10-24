import { expect, test } from "bun:test";
import { Outbound } from "@oni/protocol";
import { deliveryFixture, installDeliveryFetch } from "./helpers/delivery";
import { recordHttp } from "./helpers/http";

const providers = ["discord", "discord-owner", "telegram"] as const;
const neverConnected = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ConnectionRefused"];

for (const provider of providers) {
  test.each(neverConnected)(`${provider}: a 503 quoting %s retains uncertain custody`, async (token) => {
    let sends = 0;
    const restore = installDeliveryFetch(() => {
      sends++;
      return Response.json({ message: token, ok: false, error_code: 503, description: token }, { status: 503 });
    });
    try {
      const { adapter, address } = deliveryFixture(provider);
      const send = () => adapter.deliver(address, Outbound.payload("hello"), "503");
      expect(await send()).toEqual({ value: "unknown" });
      expect(await send()).toEqual({ value: "unknown" });
      expect(sends).toBe(1);
    } finally { restore(); }
  });

  test.each(neverConnected)(`${provider}: typed %s permits a same-key physical retry`, async (code) => {
    let sends = 0;
    const restore = installDeliveryFetch(() => {
      sends++;
      if (sends === 1) throw Object.assign(new Error("connect failed"), { code });
      return Response.json({ id: "17", ok: true, result: { message_id: 17 } });
    });
    try {
      const { adapter, address } = deliveryFixture(provider);
      const send = () => adapter.deliver(address, Outbound.payload("hello"), "retry");
      expect(await send()).toEqual({ value: "not_sent" });
      expect(await send()).toEqual({ value: "sent", externalMessageId: "17" });
      expect(await send()).toEqual({ value: "sent", externalMessageId: "17" });
      expect(sends).toBe(2);
    } finally { restore(); }
  });

  test.each([400, 401, 403, 404, 429])(`${provider}: HTTP %i is one proven refusal`, async (status) => {
    let sends = 0;
    const restore = installDeliveryFetch(() => {
      sends++;
      return Response.json({ message: "refused", ok: false, error_code: status, description: "refused" }, { status });
    });
    try {
      const { adapter, address } = deliveryFixture(provider);
      expect(await adapter.deliver(address, Outbound.payload("hello"), "refused")).toEqual({ value: "not_sent" });
      expect(sends).toBe(1);
    } finally { restore(); }
  });

  test.each(["ECONNRESET", "ETIMEDOUT", "message-only"])(
    `${provider}: ambiguous transport %s never permits retry`, async (code) => {
      let sends = 0;
      const restore = installDeliveryFetch(() => {
        sends++;
        throw Object.assign(new Error("ECONNREFUSED in untrusted prose"), { code });
      });
      try {
        const { adapter, address } = deliveryFixture(provider);
        const send = () => adapter.deliver(address, Outbound.payload("hello"), "uncertain");
        expect(await send()).toEqual({ value: "unknown" });
        expect(await send()).toEqual({ value: "unknown" });
        expect(sends).toBe(1);
      } finally { restore(); }
    },
  );

  test.each(["missing", "boolean", "wrong-type", "invalid-json"] as const)(
    `${provider}: a %s receipt remains uncertain`, async (shape) => {
      let sends = 0;
      const restore = installDeliveryFetch(() => {
        sends++;
        if (shape === "invalid-json") return new Response("{");
        const id = shape === "missing" ? undefined : shape === "boolean" ? true : provider === "telegram" ? {} : 17;
        return Response.json({ id, ok: true, result: { message_id: id } });
      });
      try {
        const { adapter, address } = deliveryFixture(provider);
        const send = () => adapter.deliver(address, Outbound.payload("hello"), "bad-receipt");
        expect(await send()).toEqual({ value: "unknown" });
        expect(await send()).toEqual({ value: "unknown" });
        expect(sends).toBe(1);
      } finally { restore(); }
    },
  );
}

for (const provider of ["discord", "discord-owner"] as const) {
  test.each(["503", "missing-id", "numeric-id", "reset"] as const)(
    `${provider}: DM preflight %s permits a same-key retry before posting`, async (failure) => {
      let preflights = 0;
      let sends = 0;
      const wire = recordHttp(request => {
        if (request.url.endsWith("/users/@me/channels")) {
          preflights++;
          if (preflights > 1) return Response.json({ id: "dm" });
          if (failure === "reset") throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
          if (failure === "503") return Response.json({ message: "unavailable" }, { status: 503 });
          return Response.json(failure === "numeric-id" ? { id: 17 } : {});
        }
        sends++;
        return Response.json({ id: "17" });
      });
      try {
        const { adapter, address } = deliveryFixture(provider);
        const send = () => adapter.deliver(address, Outbound.payload("hello"), "preflight");
        expect(await send()).toEqual({ value: "not_sent" });
        expect(sends).toBe(0);
        expect(await send()).toEqual({ value: "sent", externalMessageId: "17" });
        expect({ preflights, sends }).toEqual({ preflights: 2, sends: 1 });
      } finally { wire.restore(); }
    },
  );
}
