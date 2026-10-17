import { describe, expect, test } from "bun:test";
import { Operational } from "@openomni/protocol";
import { z } from "zod";
import { type A2AFetch, A2AClient } from "../src/provider/a2a/client";
import type { PublishPort } from "../src/types";
import { injectedOptions } from "./helpers/injected";

interface Scripted {
  readonly status: number;
  readonly body?: string;
}
type Script = (call: { readonly method: string; readonly url: string; readonly body?: string }) => Scripted | Error;

/** A scripted peer: every call recorded, the answer (or the thrown failure) scripted per call. */
function peer(script: Script) {
  const calls: { method: string; url: string; headers: Record<string, string>; body?: string; redirect: string }[] = [];
  const fetch: A2AFetch = async (url, init) => {
    calls.push({ method: init.method, url, headers: { ...init.headers }, redirect: init.redirect, ...(init.body === undefined ? {} : { body: init.body }) });
    const next = script({ method: init.method, url, ...(init.body === undefined ? {} : { body: init.body }) });
    if (next instanceof Error) throw next;
    return { status: next.status, text: async () => next.body ?? "" };
  };
  return { calls, fetch };
}

const card = { name: "Scout", url: "https://scout.example/rpc", protocolVersion: "0.3.0", preferredTransport: "JSONRPC" };
const task = (state: string, text?: string) => ({
  kind: "task",
  id: "t-1",
  contextId: "c-1",
  status: { state, ...(text === undefined ? {} : { message: { kind: "message", role: "agent", parts: [{ kind: "text", text }], messageId: "a-1" } }) },
});
const rpcResult = (result: object) => ({ status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: "x", result }) });
const params = { message: { kind: "message" as const, role: "user" as const, parts: [{ kind: "text" as const, text: "hi" }], messageId: "k-1" }, configuration: { blocking: true } };

function client(fetch: A2AFetch, publish: PublishPort = () => undefined) {
  return new A2AClient({ fetch, publish, ...injectedOptions() });
}
const coded = (code: string) => Object.assign(new TypeError(code), { code });

describe("A2A client (#1569 lane 9c): the outbound half", () => {
  test("the card is read once per peer from either well-known path, with the bearer; a peer serving none, or whose GET fails in any way, has none", async () => {
    const legacy = peer(({ url }) => (url.endsWith("/agent-card.json") ? { status: 404 } : { status: 200, body: JSON.stringify(card) }));
    const reading = client(legacy.fetch);
    expect(await reading.card("https://scout.example/", "scout-token")).toEqual({ kind: "card", card });
    expect(await reading.card("https://scout.example/", "scout-token")).toEqual({ kind: "card", card });
    expect(legacy.calls.map((call) => call.url)).toEqual([
      "https://scout.example/.well-known/agent-card.json",
      "https://scout.example/.well-known/agent.json",
    ]);
    expect(legacy.calls[0]).toMatchObject({ method: "GET", headers: { authorization: "Bearer scout-token" }, redirect: "manual" });
    expect(await client(peer(() => ({ status: 404 })).fetch).card("https://none.example", "t")).toEqual({ kind: "none" });
    expect(await client(peer(() => ({ status: 200, body: "not a card" })).fetch).card("https://none.example", "t")).toEqual({ kind: "none" });
    expect(await client(peer(() => coded("ConnectionRefused")).fetch).card("https://down.example", "t")).toEqual({ kind: "none" });
    expect(await client(peer(() => Object.assign(new Error("timed out"), { name: "TimeoutError" })).fetch).card("https://slow.example", "t")).toEqual({ kind: "none" });
  });

  test("a card naming an endpoint outside the declared url's origin is refused and never kept: the bearer goes nowhere the Owner did not declare", async () => {
    for (const url of ["http://169.254.169.254/latest/collect", "https://evil.example/collect", "https://scout.example:8443/rpc", "http://scout.example/rpc", "/rpc"]) {
      const foreign = peer(() => ({ status: 200, body: JSON.stringify({ ...card, url }) }));
      const reading = client(foreign.fetch);
      expect(await reading.card("https://scout.example", "t")).toEqual({ kind: "foreign", url });
      expect(await reading.card("https://scout.example", "t")).toEqual({ kind: "foreign", url });
      expect(foreign.calls).toHaveLength(2);
    }
    expect(await client(peer(() => ({ status: 200, body: JSON.stringify({ ...card, url: "https://scout.example:443/a2a/" }) })).fetch).card("https://scout.example", "t")).toMatchObject({ kind: "card" });
  });

  test("one message/send per key under custody: the peer's task or message comes back with a sent receipt, its JSON-RPC error as not_sent", async () => {
    const answering = peer(() => rpcResult(task("completed", "done")));
    const sending = client(answering.fetch);
    const first = await sending.send(card.url, "scout-token", params, "k-1");
    expect(first.receipt).toEqual({ value: "sent", externalMessageId: "t-1" });
    expect(first.answer).toMatchObject({ kind: "task", task: { id: "t-1", status: { state: "completed" } } });
    expect(answering.calls).toHaveLength(1);
    expect(answering.calls[0]).toMatchObject({ method: "POST", url: card.url, headers: { authorization: "Bearer scout-token", "content-type": "application/json" }, redirect: "manual" });
    expect(JSON.parse(answering.calls[0]?.body ?? "{}")).toMatchObject({ jsonrpc: "2.0", id: "k-1", method: "message/send", params });
    expect((await sending.send(card.url, "scout-token", params, "k-1")).receipt).toEqual({ value: "sent", externalMessageId: "t-1" });
    expect(answering.calls).toHaveLength(1);
    const direct = client(peer(() => rpcResult({ kind: "message", role: "agent", parts: [{ kind: "text", text: "ok" }], messageId: "a-2" })).fetch);
    expect(await direct.send(card.url, "t", params, "k-2")).toMatchObject({ receipt: { value: "sent", externalMessageId: "a-2" }, answer: { kind: "message" } });
    const refusing = client(peer(() => ({ status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: "x", error: { code: -32005, message: "Incompatible content types" } }) })).fetch);
    expect(await refusing.send(card.url, "t", params, "k-3")).toEqual({ receipt: { value: "not_sent" }, answer: { kind: "error", error: { code: -32005, message: "Incompatible content types" } } });
  });

  test("a 4xx, a redirect and a request that never left are not_sent; a 5xx, an unreadable answer and a lost answer are unknown, surfaced once", async () => {
    const warns: string[] = [];
    const publish: PublishPort = (event, data) => {
      if (event.name === Operational.Events.Warn.name) warns.push(z.object({ msg: z.string() }).parse(data).msg);
    };
    expect((await client(peer(() => ({ status: 403 })).fetch, publish).send(card.url, "t", params, "k-1")).receipt).toEqual({ value: "not_sent" });
    expect((await client(peer(() => ({ status: 307 })).fetch, publish).send(card.url, "t", params, "k-2")).receipt).toEqual({ value: "not_sent" });
    expect((await client(peer(() => coded("ENOTFOUND")).fetch, publish).send(card.url, "t", params, "k-3")).receipt).toEqual({ value: "not_sent" });
    expect((await client(peer(() => coded("UNKNOWN_CERTIFICATE_VERIFICATION_ERROR")).fetch, publish).send(card.url, "t", params, "k-4")).receipt).toEqual({ value: "not_sent" });
    expect(warns).toEqual([]);
    expect((await client(peer(() => ({ status: 502 })).fetch, publish).send(card.url, "t", params, "k-5")).receipt).toEqual({ value: "unknown" });
    expect((await client(peer(() => ({ status: 200, body: "<html>" })).fetch, publish).send(card.url, "t", params, "k-6")).receipt).toEqual({ value: "unknown" });
    expect((await client(peer(() => rpcResult({ nothing: true })).fetch, publish).send(card.url, "t", params, "k-7")).receipt).toEqual({ value: "unknown" });
    expect((await client(peer(() => Object.assign(new Error("timed out"), { name: "TimeoutError" })).fetch, publish).send(card.url, "t", params, "k-8")).receipt).toEqual({ value: "unknown" });
    expect(warns).toHaveLength(4);
  });

  test("tasks/get reads the task as the peer holds it, or the peer's refusal", async () => {
    const holding = peer(({ body }) => (body?.includes('"tasks/get"') ? rpcResult(task("working")) : { status: 500 }));
    expect(await client(holding.fetch).getTask(card.url, "t", { id: "t-1" })).toMatchObject({ kind: "task", task: { status: { state: "working" } } });
    expect(JSON.parse(holding.calls[0]?.body ?? "{}")).toMatchObject({ method: "tasks/get", params: { id: "t-1" } });
    await client(holding.fetch).getTask(card.url, "t", { id: "t-1", historyLength: 0 });
    expect(JSON.parse(holding.calls[1]?.body ?? "{}")).toMatchObject({ method: "tasks/get", params: { id: "t-1", historyLength: 0 } });
    const gone = client(peer(() => ({ status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: "x", error: { code: -32001, message: "Task not found" } }) })).fetch);
    expect(await gone.getTask(card.url, "t", { id: "t-9" })).toEqual({ kind: "error", error: { code: -32001, message: "Task not found" } });
    await expect(client(peer(() => ({ status: 503 })).fetch).getTask(card.url, "t", { id: "t-1" })).rejects.toMatchObject({ _tag: "ChannelsFailure" });
  });
});
