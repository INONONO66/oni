import { expect, test } from "bun:test";
import { type A2AAnswer, type A2ACardRead, type A2AClient, Vault } from "@openomni/channels";
import { Operational } from "@openomni/protocol";
import { Effect } from "effect";
import { z } from "zod";
import { vaultCredentialReader } from "../src/bundles/provision/declared";
import { a2aContacts } from "../src/composition/a2a-contacts";
import { putChannelCredential } from "./helpers/channel-credential";
import { runEffect } from "./helpers/effect";
import { testPlane } from "./helpers/ledger";

const KEY = new Uint8Array(32).fill(7);
const CARD: A2ACardRead = { kind: "card", card: { name: "Scout", url: "https://scout.example/rpc" } };

/** A plane with one declared peer, its credential sealed. */
function declared(overrides: { readonly enabled?: boolean; readonly url?: string | false; readonly credential?: boolean | "garbled" } = {}) {
  const plane = testPlane();
  const url = overrides.url === undefined ? "https://scout.example" : overrides.url;
  if (overrides.credential !== false)
    putChannelCredential(
      plane.stores.secrets,
      "secret:channel-a2a-scout",
      overrides.credential === "garbled" ? "not json" : JSON.stringify({ token: "scout-token", ...(url === false ? {} : { url }) }),
      KEY,
      1,
    );
  plane.stores.instances.put({
    id: "channel:a2a:scout",
    provider: "a2a",
    identity: "bot",
    enabled: overrides.enabled ?? true,
    settings: {},
    ...(overrides.credential === false ? {} : { credentialRef: "secret:channel-a2a-scout" }),
    revision: 0,
    createdBy: "owner",
    updatedAt: 1,
  });
  return plane;
}

const task = (state: string, text?: string, artifacts: string[] = []): A2AAnswer => ({
  kind: "task",
  task: {
    kind: "task",
    id: "t-1",
    contextId: "c-1",
    status: { state: state as "working", ...(text === undefined ? {} : { message: { kind: "message", role: "agent", parts: [{ kind: "text", text }], messageId: "a-1" } }) },
    artifacts: artifacts.map((part, index) => ({ artifactId: `art-${index}`, parts: [{ kind: "text", text: part }] })),
  },
});
const reply = (text: string, contextId?: string): A2AAnswer => ({
  kind: "message",
  message: { kind: "message", role: "agent", parts: [{ kind: "text", text }], messageId: "a-0", ...(contextId === undefined ? {} : { contextId }) },
});

/** A scripted client: the card, the send's receipt and answer, and the task reads in order (an Error read throws). */
function scripted(script: {
  readonly card?: A2ACardRead;
  readonly send: { receipt: { value: "sent" | "not_sent" | "unknown" }; answer?: A2AAnswer };
  readonly reads?: (A2AAnswer | Error)[];
}) {
  const calls: string[] = [];
  const letters: Parameters<A2AClient["send"]>[2][] = [];
  const reads = [...(script.reads ?? [])];
  const client: Pick<A2AClient, "card" | "send" | "getTask"> = {
    card: async (base, token) => {
      calls.push(`card:${base}:${token}`);
      return script.card ?? CARD;
    },
    send: async (endpoint, token, params, key) => {
      letters.push(params);
      calls.push(`send:${endpoint}:${token}:${key}:${params.message.parts.map((part) => (part.kind === "text" ? part.text : "")).join("")}`);
      return script.send;
    },
    getTask: async (_endpoint, _token, params) => {
      calls.push(`get:${params.id}:${params.historyLength}`);
      const next = reads.shift();
      if (next === undefined) throw new Error("unscripted read");
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { calls, letters, client };
}

function contactsOver(plane: ReturnType<typeof declared>, client: Pick<A2AClient, "card" | "send" | "getTask">, reader?: ReturnType<typeof vaultCredentialReader>) {
  const warns: { msg: string; context?: Record<string, string> }[] = [];
  let now = 1_700_000_000_000;
  let sleeps = 0;
  const contacts = a2aContacts({
    instances: plane.stores.instances,
    readCredential: reader ?? vaultCredentialReader({ kind: "ok", kek: Vault.kekOf(KEY) }, (ref) => plane.stores.secrets.get(ref)),
    client: client as A2AClient,
    publish: (event, data) => {
      if (event.name === Operational.Events.Warn.name)
        warns.push(z.object({ msg: z.string(), context: z.record(z.string(), z.string()).optional() }).parse(data));
    },
    now: () => now,
    id: () => "trace-1",
    // Every sleep elided, and the clock moves on by the poll interval so a deadline is reached.
    run: () => {
      now += 2_000;
      sleeps += 1;
      return Promise.resolve(undefined as never);
    },
  });
  return { contacts, warns, sleeps: () => sleeps };
}

const letter = { id: "scout", idempotencyKey: "sender:call-1", sender: "sender", message: "scout the area" };

test("a declared peer's card is read, the letter sent once under the key, and its answer returned with the thread: a message, or a task's status and artifacts, read back until it settles", async () => {
  const direct = scripted({ send: { receipt: { value: "sent" }, answer: reply("on it") } });
  const plane = declared();
  expect(await runEffect(contactsOver(plane, direct.client).contacts.post(letter))).toEqual({ status: "sent", response: "on it" });
  expect(direct.calls).toEqual(["card:https://scout.example:scout-token", "send:https://scout.example/rpc:scout-token:sender:call-1:scout the area"]);
  expect(direct.letters[0]).toEqual({
    message: { kind: "message", role: "user", parts: [{ kind: "text", text: "scout the area" }], messageId: "sender:call-1" },
    configuration: { blocking: true },
  });
  const threaded = scripted({ send: { receipt: { value: "sent" }, answer: reply("on it", "c-9") } });
  expect(await runEffect(contactsOver(plane, threaded.client).contacts.post(letter))).toEqual({ status: "sent", response: "on it", thread: "context:c-9" });
  const settled = scripted({ send: { receipt: { value: "sent" }, answer: task("completed", "found two", ["map", "notes"]) } });
  expect(await runEffect(contactsOver(plane, settled.client).contacts.post(letter))).toEqual({ status: "sent", response: "found two\nmap\nnotes", thread: "context:c-1" });
  const working = scripted({ send: { receipt: { value: "sent" }, answer: task("working") }, reads: [task("submitted"), task("completed", "done")] });
  expect(await runEffect(contactsOver(plane, working.client).contacts.post(letter))).toEqual({ status: "sent", response: "done", thread: "context:c-1" });
  // Every read back asks for no history: the status and artifacts are the answer.
  expect(working.calls.filter((call) => call.startsWith("get:"))).toEqual(["get:t-1:0", "get:t-1:0"]);
  // Past the deadline the task is reported as it stands, the open task as the thread; a refused or failed read ends the wait the same way, the failure told to the Owner.
  const slow = scripted({ send: { receipt: { value: "sent" }, answer: task("working") }, reads: [task("working"), task("working"), task("working")] });
  expect(await runEffect(contactsOver(plane, slow.client).contacts.post({ ...letter, deadlineMs: 4_000 }))).toEqual({ status: "sent", taskId: "t-1", taskState: "working", thread: "task:t-1" });
  const refused = scripted({ send: { receipt: { value: "sent" }, answer: task("working") }, reads: [{ kind: "error", error: { code: -32001, message: "Task not found" } }] });
  expect(await runEffect(contactsOver(plane, refused.client).contacts.post(letter))).toEqual({ status: "sent", taskId: "t-1", taskState: "working", thread: "task:t-1" });
  const failing = scripted({ send: { receipt: { value: "sent" }, answer: task("working") }, reads: [task("working", "half way"), new Error("a2a.tasks/get: HTTP 502")] });
  const over = contactsOver(plane, failing.client);
  expect(await runEffect(over.contacts.post(letter))).toEqual({ status: "sent", response: "half way", taskId: "t-1", taskState: "working", thread: "task:t-1" });
  expect(over.warns).toEqual([{ msg: "a2a task read failed", context: { task: "t-1", detail: "a2a.tasks/get: HTTP 502" } }]);
  expect(failing.calls.filter((call) => call.startsWith("send:"))).toHaveLength(1);
});

test("a task that did not complete is named with its state and the thread to continue it; the wait is bounded; the answer is bounded", async () => {
  const plane = declared();
  for (const state of ["failed", "rejected", "canceled"]) {
    const ended = scripted({ send: { receipt: { value: "sent" }, answer: task(state, "no") } });
    expect(await runEffect(contactsOver(plane, ended.client).contacts.post(letter))).toEqual({ status: "sent", response: "no", taskId: "t-1", taskState: state, thread: "context:c-1" });
    expect(ended.calls.filter((call) => call.startsWith("get:"))).toEqual([]);
  }
  for (const state of ["input-required", "auth-required", "unknown"]) {
    const waiting = scripted({ send: { receipt: { value: "sent" }, answer: task(state, "which area?") } });
    expect(await runEffect(contactsOver(plane, waiting.client).contacts.post(letter))).toEqual({ status: "sent", response: "which area?", taskId: "t-1", taskState: state, thread: `task:t-1` });
    expect(waiting.calls.filter((call) => call.startsWith("get:"))).toEqual([]);
  }
  // reply_to names the task to continue, or the context to open a new task in (a bare id is a context).
  for (const [replyTo, expected] of [
    ["task:t-1", { taskId: "t-1" }],
    ["context:c-1", { contextId: "c-1" }],
    ["c-2", { contextId: "c-2" }],
  ] as const) {
    const continued = scripted({ send: { receipt: { value: "sent" }, answer: reply("ok") } });
    await runEffect(contactsOver(plane, continued.client).contacts.post({ ...letter, replyTo }));
    expect(continued.letters[0]?.message).toMatchObject({ messageId: "sender:call-1", ...expected });
  }
  // The wait holds the turn: a deadline past five minutes is cut there (150 reads two seconds apart).
  const endless = scripted({ send: { receipt: { value: "sent" }, answer: task("working") }, reads: Array.from({ length: 200 }, () => task("working")) });
  const bounded = contactsOver(plane, endless.client);
  expect(await runEffect(bounded.contacts.post({ ...letter, deadlineMs: 3_600_000 }))).toMatchObject({ status: "sent", taskState: "working" });
  expect(bounded.sleeps()).toBe(150);
  // The answer rides back bounded: 64 KiB of it.
  const verbose = scripted({ send: { receipt: { value: "sent" }, answer: task("completed", undefined, ["x".repeat(70_000)]) } });
  const posted = await runEffect(contactsOver(plane, verbose.client).contacts.post(letter));
  expect(posted.response?.length).toBe(64 * 1024);
});

test("the peer's refusal, a lost send, a replayed call and an undeclared, disabled, url-less, cardless, foreign-carded or unreadable peer are the sender's facts; nothing is sent twice", async () => {
  const plane = declared();
  const error = scripted({ send: { receipt: { value: "not_sent" }, answer: { kind: "error", error: { code: -32005, message: "Incompatible content types" } } } });
  expect(await runEffect(contactsOver(plane, error.client).contacts.post(letter))).toEqual({ status: "not_sent", reason: "-32005: Incompatible content types" });
  const lost = scripted({ send: { receipt: { value: "unknown" } } });
  expect(await runEffect(contactsOver(plane, lost.client).contacts.post(letter))).toEqual({ status: "unknown" });
  // A replayed key keeps its sent receipt with no answer: the answer went to the first call, and nothing is sent again.
  const replayed = scripted({ send: { receipt: { value: "sent" } } });
  expect(await runEffect(contactsOver(plane, replayed.client).contacts.post(letter))).toEqual({ status: "sent" });
  const noCard = scripted({ card: { kind: "none" }, send: { receipt: { value: "sent" } } });
  expect(await runEffect(contactsOver(plane, noCard.client).contacts.post(letter))).toEqual({ status: "not_sent", reason: "a2a peer scout serves no agent card" });
  expect(noCard.calls).toEqual(["card:https://scout.example:scout-token"]);
  // A card naming an endpoint outside the declared url is refused before anything leaves; the Owner learns where it pointed.
  const foreign = scripted({ card: { kind: "foreign", url: "http://169.254.169.254/latest/collect" }, send: { receipt: { value: "sent" } } });
  const refused = contactsOver(plane, foreign.client);
  expect(await runEffect(refused.contacts.post(letter))).toEqual({ status: "not_sent", reason: "a2a peer scout: its card names an endpoint outside its declared url" });
  expect(foreign.calls).toEqual(["card:https://scout.example:scout-token"]);
  expect(refused.warns).toEqual([{ msg: "a2a peer unavailable", context: { peer: "scout", detail: "http://169.254.169.254/latest/collect" } }]);
  const cases: [ReturnType<typeof declared>, ReturnType<typeof vaultCredentialReader> | undefined, string, string, string | undefined][] = [
    [declared(), undefined, "ranger", "no a2a peer ranger is declared", undefined],
    [declared({ enabled: false }), undefined, "scout", "a2a peer scout is disabled", undefined],
    [declared({ credential: false }), undefined, "scout", "a2a peer scout has no credential", undefined],
    [declared({ url: false }), undefined, "scout", "a2a peer scout declares no url", undefined],
    [declared({ credential: "garbled" }), undefined, "scout", "a2a peer scout: its credential is unavailable", "the credential payload is invalid"],
    [declared(), vaultCredentialReader({ kind: "locked", reason: "no vault key" }, () => undefined), "scout", "a2a peer scout: its credential is unavailable", "no vault key"],
  ];
  for (const [held, locked, id, reason, detail] of cases) {
    const untouched = scripted({ send: { receipt: { value: "sent" } } });
    const { contacts, warns } = contactsOver(held, untouched.client, locked);
    expect(await runEffect(contacts.post({ ...letter, id }))).toEqual({ status: "not_sent", reason });
    expect(untouched.calls).toEqual([]);
    expect(warns).toEqual(detail === undefined ? [] : [{ msg: "a2a peer unavailable", context: { peer: id, detail } }]);
  }
  expect(Effect.isEffect(contactsOver(plane, error.client).contacts.post(letter))).toBe(true);
});
