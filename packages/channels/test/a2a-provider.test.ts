import { describe, expect, it } from "bun:test";
import { type Channel, Gateway, Operational, Outbound } from "@openomni/protocol";
import { z } from "zod";
import { DeliveryNotSent } from "../src/errors";
import { createA2AProvider } from "../src/provider/a2a/provider";
import type { EffectRunner, PublishPort } from "../src/types";
import { injectedOptions } from "./helpers/injected";

const PEERS = [
  { id: "scout", token: "scout-token" },
  { id: "planner", token: "planner-token" },
];
const CARD = { name: "OpenOmni Resident", description: "one Resident, delegating through evidence", version: "0.1.0" };
/** The driver's run port with every sleep elided: a blocking wait expires at once. */
const immediate: EffectRunner = () => Promise.resolve(undefined as never);

const TaskShape = z.object({
  kind: z.literal("task"),
  id: z.string(),
  contextId: z.string(),
  status: z.object({ state: z.string(), message: z.object({ parts: z.array(z.object({ text: z.string().optional() })) }).optional() }),
  history: z.array(z.object({ role: z.string(), messageId: z.string(), taskId: z.string(), contextId: z.string() })).optional(),
});
const Answer = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number(), z.null()]), result: z.json().optional(), error: z.object({ code: z.number(), message: z.string() }).optional() });

function door(publish: PublishPort = () => undefined, handler?: Channel.MessageHandler, run: EffectRunner = immediate) {
  const received: Channel.InboundMessage[] = [];
  const provider = createA2AProvider(async () => PEERS, CARD);
  const runtime = provider.create({ token: "scout-token" }, {}, publish, injectedOptions(run));
  runtime.surface.onMessage(
    handler ??
      (async (message) => {
        received.push(message);
      }),
  );
  return { provider, runtime, received };
}

/** A JSON-RPC call under a peer's bearer; `null` sends none. */
function rpc(method: string, params: object | undefined, token: string | null = "scout-token", id: string | number = 1) {
  return new Request("http://daemon.local/a2a", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

const letter = (text: string, extra: object = {}) => ({
  message: { kind: "message", role: "user", parts: [{ kind: "text", text }], messageId: `m-${text}`, ...extra },
});

async function answer(response: Response | undefined) {
  if (response === undefined) throw new Error("no door");
  return { status: response.status, body: Answer.parse(await response.json()) };
}

describe("A2A door (#1569 lane 9c): other agents reach the Resident through ordinary ingress", () => {
  it("serves the card at the well-known path with the door the request came through as its url", async () => {
    const { runtime } = door();
    await runtime.surface.start("boot");
    const response = await runtime.webhookHandler?.(new Request("http://daemon.local/.well-known/agent-card.json"));
    expect(response?.status).toBe(200);
    // Behind a proxy that terminates TLS, the forwarded scheme and host name the public door.
    const forwarded = await runtime.webhookHandler?.(
      new Request("http://127.0.0.1:3000/.well-known/agent.json", { headers: { "x-forwarded-proto": "https", "x-forwarded-host": "agent.example.com" } }),
    );
    expect(await forwarded?.json()).toMatchObject({ url: "https://agent.example.com/a2a" });
    expect(await response?.json()).toMatchObject({
      protocolVersion: "0.3.0",
      name: CARD.name,
      url: "http://daemon.local/a2a",
      preferredTransport: "JSONRPC",
      version: "0.1.0",
      capabilities: { streaming: false, pushNotifications: false },
      skills: [{ id: "resident" }],
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    });
  });

  it("admits only a declared peer's bearer, compared against every declared peer; the peer is the message's author and the context its conversation", async () => {
    const { runtime, received } = door();
    await runtime.surface.start("boot");
    expect((await answer(await runtime.webhookHandler?.(rpc("message/send", letter("hi"), null)))).status).toBe(401);
    expect((await answer(await runtime.webhookHandler?.(rpc("message/send", letter("hi"), "nobody")))).status).toBe(401);
    expect((await answer(await runtime.webhookHandler?.(rpc("message/send", letter("hi"), "scout-toke")))).status).toBe(401);
    expect(received).toEqual([]);
    const sent = await answer(await runtime.webhookHandler?.(rpc("message/send", letter("plan the sprint"), "planner-token")));
    expect(sent.status).toBe(200);
    const task = TaskShape.parse(sent.body.result);
    expect(task.status.state).toBe("working");
    expect(received).toHaveLength(1);
    expect(received[0]?.sender).toEqual({ kind: "external", surface: "a2a", externalId: "planner" });
    expect(Gateway.IngressFacts.parse(received[0]?.facts)).toMatchObject({
      eventId: "m-plan the sprint",
      surface: "a2a",
      event: "message",
      channelId: task.contextId,
      dm: true,
      author: { externalId: "planner", isBot: true },
      reply: { externalConversationId: `a2a:planner:${task.contextId}` },
      render: "plan the sprint",
    });
    expect(received[0]?.facts.reply?.threadId).toBeUndefined();
    expect(task.history?.[0]).toMatchObject({ role: "user", messageId: "m-plan the sprint", taskId: task.id, contextId: task.contextId });
    // A later task the peer opens in the same context reaches the same conversation.
    const again = TaskShape.parse((await answer(await runtime.webhookHandler?.(rpc("message/send", letter("and the budget", { contextId: task.contextId }), "planner-token")))).body.result);
    expect(again.id).not.toBe(task.id);
    expect(again.contextId).toBe(task.contextId);
    expect(received[1]?.facts.channelId).toBe(task.contextId);
    // The task's history is cut as the peer asks: 0 omits it.
    const bare = TaskShape.parse((await answer(await runtime.webhookHandler?.(rpc("message/send", { ...letter("brief"), configuration: { historyLength: 0 } }, "planner-token")))).body.result);
    expect(bare.history).toBeUndefined();
  });

  it("the Resident's answer lands on the context's newest open task and completes it; the peer reads it back, bounded by historyLength; another peer can neither read nor continue it", async () => {
    const { runtime, received } = door();
    await runtime.surface.start("boot");
    const task = TaskShape.parse((await answer(await runtime.webhookHandler?.(rpc("message/send", letter("status?"))))).body.result);
    const route = runtime.deliveryRoute;
    if (route === undefined) throw new Error("no delivery route");
    await expect(route("scout", Outbound.payload("all green"), "k-1")).rejects.toBeInstanceOf(DeliveryNotSent);
    expect((await route("scout", Outbound.payload("all green"), "k-1", { channelId: "no-such-context" })).value).toBe("rejected");
    // Another peer naming the task learns no more than one naming a task that is not there; nothing reaches the handler.
    expect((await answer(await runtime.webhookHandler?.(rpc("message/send", letter("mine now", { taskId: task.id }), "planner-token")))).body.error).toEqual({ code: -32001, message: "Task not found" });
    expect(received).toHaveLength(1);
    expect(await route("scout", Outbound.payload("all green"), "k-1", { channelId: task.contextId })).toEqual({ value: "accepted", externalMessageId: "k-1" });
    const read = TaskShape.parse((await answer(await runtime.webhookHandler?.(rpc("tasks/get", { id: task.id })))).body.result);
    expect(read.status.state).toBe("completed");
    expect(read.status.message?.parts[0]?.text).toBe("all green");
    expect(read.history?.map((entry) => entry.role)).toEqual(["user", "agent"]);
    const sliced = TaskShape.parse((await answer(await runtime.webhookHandler?.(rpc("GetTask", { id: task.id, historyLength: 1 })))).body.result);
    expect(sliced.history?.map((entry) => entry.role)).toEqual(["agent"]);
    expect(TaskShape.parse((await answer(await runtime.webhookHandler?.(rpc("tasks/get", { id: task.id, historyLength: 0 })))).body.result).history).toBeUndefined();
    expect((await answer(await runtime.webhookHandler?.(rpc("tasks/get", { id: task.id }, "planner-token")))).body.error).toEqual({ code: -32001, message: "Task not found" });
    // With no task open in the context, an answer has nowhere to land; nor has a reaction.
    expect((await route("scout", Outbound.payload("more"), "k-2", { channelId: task.contextId })).value).toBe("rejected");
    expect((await route("scout", { kind: "react", messageId: "m-status?", emoji: "👍" }, "k-3", { channelId: task.contextId })).value).toBe("rejected");
    // A follow-up on a finished task is refused; one on an unknown task is not found.
    expect((await answer(await runtime.webhookHandler?.(rpc("message/send", letter("again", { taskId: task.id }))))).body.error?.code).toBe(-32602);
    expect((await answer(await runtime.webhookHandler?.(rpc("message/send", letter("again", { taskId: "t-ghost" }))))).body.error?.code).toBe(-32001);
    // The newest open task in the context takes the next answer.
    const first = TaskShape.parse((await answer(await runtime.webhookHandler?.(rpc("message/send", letter("one", { contextId: task.contextId }))))).body.result);
    const second = TaskShape.parse((await answer(await runtime.webhookHandler?.(rpc("message/send", letter("two", { contextId: task.contextId }))))).body.result);
    expect(await route("scout", Outbound.payload("re: two"), "k-4", { channelId: task.contextId })).toEqual({ value: "accepted", externalMessageId: "k-4" });
    expect(TaskShape.parse((await answer(await runtime.webhookHandler?.(rpc("tasks/get", { id: second.id })))).body.result).status.state).toBe("completed");
    expect(TaskShape.parse((await answer(await runtime.webhookHandler?.(rpc("tasks/get", { id: first.id })))).body.result).status.state).toBe("working");
  });

  it("a blocking send waits for the answer and returns the completed task; past the wait it returns the task as it stands; a second blocking send on the task is woken by the answer after the first expired", async () => {
    let route: ReturnType<ReturnType<typeof createA2AProvider>["create"]>["deliveryRoute"];
    const answering = door(() => undefined, async (message) => {
      await route?.("scout", Outbound.payload(`re: ${message.facts.render}`), `k-${message.facts.eventId}`, { channelId: message.facts.channelId });
    });
    route = answering.runtime.deliveryRoute;
    await answering.runtime.surface.start("boot");
    const completed = TaskShape.parse(
      (await answer(await answering.runtime.webhookHandler?.(rpc("message/send", { ...letter("ping"), configuration: { blocking: true } })))).body.result,
    );
    expect(completed.status.state).toBe("completed");
    expect(completed.status.message?.parts[0]?.text).toBe("re: ping");
    const silent = door();
    await silent.runtime.surface.start("boot");
    const pending = TaskShape.parse(
      (await answer(await silent.runtime.webhookHandler?.(rpc("message/send", { ...letter("ping"), configuration: { blocking: true } })))).body.result,
    );
    expect(pending.status.state).toBe("working");
    // The run port decides when a wait expires: the first blocking send expires, the second stays until the answer lands.
    const expiries: (() => void)[] = [];
    const held = door(() => undefined, undefined, () => new Promise((resolve) => expiries.push(() => resolve(undefined as never))));
    await held.runtime.surface.start("boot");
    const opened = TaskShape.parse((await answer(await held.runtime.webhookHandler?.(rpc("message/send", letter("open"))))).body.result);
    const first = held.runtime.webhookHandler?.(rpc("message/send", { ...letter("first", { taskId: opened.id }), configuration: { blocking: true } }));
    const second = held.runtime.webhookHandler?.(rpc("message/send", { ...letter("second", { taskId: opened.id }), configuration: { blocking: true } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(expiries).toHaveLength(2);
    expiries[0]?.();
    expect(TaskShape.parse((await answer(await first)).body.result).status.state).toBe("working");
    expect(await held.runtime.deliveryRoute?.("scout", Outbound.payload("re: both"), "k-b", { channelId: opened.contextId })).toEqual({ value: "accepted", externalMessageId: "k-b" });
    expect(TaskShape.parse((await answer(await second)).body.result).status.state).toBe("completed");
  });

  it("a peer cancels its open task, never a finished one; the Resident's later answer finds nothing to land on", async () => {
    const infos: string[] = [];
    const { runtime } = door((event, data) => {
      if (event.name === Operational.Events.Info.name) infos.push(z.object({ msg: z.string() }).parse(data).msg);
    });
    await runtime.surface.start("boot");
    const task = TaskShape.parse((await answer(await runtime.webhookHandler?.(rpc("message/send", letter("later"))))).body.result);
    const canceled = TaskShape.parse((await answer(await runtime.webhookHandler?.(rpc("tasks/cancel", { id: task.id })))).body.result);
    expect(canceled.status.state).toBe("canceled");
    expect((await answer(await runtime.webhookHandler?.(rpc("CancelTask", { id: task.id })))).body.error).toEqual({ code: -32002, message: "Task cannot be canceled" });
    expect((await runtime.deliveryRoute?.("scout", Outbound.payload("too late"), "k-9", { channelId: task.contextId }))?.value).toBe("rejected");
    expect(infos).toEqual(["a2a door ready", "a2a message received", "a2a task canceled by its peer"]);
  });

  it("the door remembers a bounded number of tasks: finished ones go first, then the oldest open one is canceled and the Owner told", async () => {
    const warns: { msg: string; context?: Record<string, string | number> }[] = [];
    const { runtime } = door((event, data) => {
      if (event.name === Operational.Events.Warn.name) warns.push(z.object({ msg: z.string(), context: z.record(z.string(), z.union([z.string(), z.number()])).optional() }).parse(data));
    });
    await runtime.surface.start("boot");
    const oldest = TaskShape.parse((await answer(await runtime.webhookHandler?.(rpc("message/send", letter("oldest"))))).body.result);
    const finished = TaskShape.parse((await answer(await runtime.webhookHandler?.(rpc("message/send", letter("finished"))))).body.result);
    await runtime.deliveryRoute?.("scout", Outbound.payload("done"), "k-f", { channelId: finished.contextId });
    for (let index = 0; index < 999; index += 1) await runtime.webhookHandler?.(rpc("message/send", letter(`fill-${index}`)));
    // 1001 held: the finished one went; the oldest open one is still there.
    expect((await answer(await runtime.webhookHandler?.(rpc("tasks/get", { id: finished.id })))).body.error?.code).toBe(-32001);
    expect(TaskShape.parse((await answer(await runtime.webhookHandler?.(rpc("tasks/get", { id: oldest.id })))).body.result).status.state).toBe("working");
    expect(warns).toEqual([]);
    await runtime.webhookHandler?.(rpc("message/send", letter("one more")));
    expect((await answer(await runtime.webhookHandler?.(rpc("tasks/get", { id: oldest.id })))).body.error?.code).toBe(-32001);
    expect(warns).toEqual([{ msg: "a2a door evicted an open task", context: { peer: "scout", task: oldest.id, retained: 1000 } }]);
  });

  it("malformed calls and unsupported operations are the JSON-RPC errors A2A names; a handler throw fails the task loudly", async () => {
    const errors: string[] = [];
    const { runtime } = door(
      (event, data) => {
        if (event.name === Operational.Events.Error.name) errors.push(z.object({ msg: z.string() }).parse(data).msg);
      },
      async () => {
        throw new Error("ledger closed");
      },
    );
    await runtime.surface.start("boot");
    const unparsable = new Request("http://daemon.local/a2a", { method: "POST", headers: { authorization: "Bearer scout-token" }, body: "{" });
    expect((await answer(await runtime.webhookHandler?.(unparsable))).body.error?.code).toBe(-32700);
    const notRpc = new Request("http://daemon.local/a2a", { method: "POST", headers: { authorization: "Bearer scout-token" }, body: JSON.stringify({ method: "x" }) });
    expect((await answer(await runtime.webhookHandler?.(notRpc))).body.error?.code).toBe(-32600);
    expect((await answer(await runtime.webhookHandler?.(rpc("message/send", { message: { role: "user" } })))).body.error?.code).toBe(-32602);
    expect((await answer(await runtime.webhookHandler?.(rpc("message/send", { message: { role: "user", parts: [{ kind: "data", data: {} }], messageId: "m-x" } })))).body.error?.message).toBe("Invalid params: no text part");
    expect((await answer(await runtime.webhookHandler?.(rpc("tasks/list", {})))).body.error?.code).toBe(-32601);
    expect((await answer(await runtime.webhookHandler?.(rpc("message/stream", letter("x"))))).body.error?.code).toBe(-32004);
    expect((await answer(await runtime.webhookHandler?.(rpc("tasks/pushNotificationConfig/set", {})))).body.error?.code).toBe(-32003);
    const failed = TaskShape.parse((await answer(await runtime.webhookHandler?.(rpc("SendMessage", letter("boom"))))).body.result);
    expect(failed.status.state).toBe("failed");
    expect(errors).toEqual(["a2a message handler error"]);
  });

  it("the provider declares what the runtime exposes and admits only a peer's declared shape", () => {
    const { provider } = door();
    expect(provider.capabilities).toMatchObject({ deliver: true, webhook: true, react: false, typing: false, media: false });
    expect(provider.credentials.safeParse({ token: "t" }).success).toBe(true);
    expect(provider.credentials.safeParse({ token: "t", url: "https://peer.example", name: "scout" }).success).toBe(true);
    expect(provider.credentials.safeParse({ token: "t", url: "ftp://peer.example" }).success).toBe(false);
    expect(provider.credentials.safeParse({ url: "https://peer.example" }).success).toBe(false);
    expect(provider.credentials.safeParse({ token: "t", extra: 1 }).success).toBe(false);
  });
});
