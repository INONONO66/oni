import { sessionTree } from "../../../packages/agent/test/store/helpers/session-tree";
import { Effect } from "effect";
import { expect, spyOn, test } from "bun:test";
import { assertNoLegacyRequestStores } from "./helpers/storage-evidence";
import { ownerStart } from "./helpers/owner-start";
import { Bus, newTraceId } from "./helpers/bus";
import { Core } from "@oni/agent";
import { Gateway, L0Observation, SessionTransition, SessionTurn } from "@oni/protocol";
import { sessionFilePath } from "../src/composition/cluster-runtime";
import type { TestLedgerPlane as AppLedgerPlane } from "./helpers/ledger";
import { planeOf } from "./helpers/ledger";
import { assistantMessage, commissionInput, requestToolStep } from "./helpers/assistant-message";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { receivedMessages } from "./helpers/received-messages";
import { nextFrame } from "./helpers/ws";
import { declarePerson } from "./helpers/declared-channel";
import { nextResidentTurn } from "./helpers/resident-turn";
import { eventSignal } from "./helpers/event-signal";
import { runEffect } from "./helpers/effect";
import { DelegationRefusal } from "../src/bundles/delegation-policy/index";
import type { Message } from "@oni/protocol";

/** The text a model-transcript message carries (fake models read, never guess shapes). */
function messageText(message: Message.WithParts): string {
  return message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

/** The parent-side settlement rows (#1311): prompt rows whose origin parses as an outbound message. */
function settlementRows(plane: AppLedgerPlane, parentId: string) {
  return receivedMessages(plane, parentId).filter(
    (row) => SessionTransition.OutboundMessage.safeParse(row.origin.value).success,
  );
}

/** expect.objectContaining, typed as the value the partial shape matches. */
function containing<T extends object>(shape: Partial<T> & object): T {
  return expect.objectContaining(shape) as T;
}

const suite = residentSuite();

test.each([
  "?actor=owner",
  "",
])("an external turn never dispatches an unsolicited reply for connection %s", async (query) => {
  const unsolicited = suite.config("message-e2e-", {
    wsToken: "token",
    socialBudgets: [
      {
        id: "owner-budget",
        targetActorId: "person:known-owner",
        maxPerWindow: 10,
        windowMs: 1000,
        cooldownMs: 0,
      },
    ],
  });
  declarePerson(unsolicited.catalogPath, { id: "person:known-owner", displayName: "Owner", kind: "human", trustTier: "owner", endpoints: [{ channel: "ws", externalId: "owner" }], reach: true });
  const app = await suite.boot({
    config: unsolicited,
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        sink.onMessage(assistantMessage(input, { text: "FINAL_SENTINEL" }));
        return { type: "stop" };
      }),
    },
  });
  const plane = await planeOf(app.runtime);
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws${query}`, ["auth", "token"]);
  const ingest = spyOn(app.gateway, "ingest");
  suite.defer(() => ingest.mockRestore());
  const receipt = nextFrame(ws, (frame) => frame.type === "receipt");
  const terminal = nextResidentTurn(plane);
  ws.send(JSON.stringify({ eventId: newTraceId(), text: "start" }));
  expect(await receipt).toMatchObject({ type: "receipt", status: "accepted" });
  expect((await terminal).text).toBe("FINAL_SENTINEL");
  expect(ingest.mock.calls.filter(([sender]) => sender.kind === "session")).toEqual([]);
  const actions = plane
    .listSessions()
    .flatMap((row) => sessionTree(row.id, plane.sessionStore(row.id).actions));
  const outbound = (action: (typeof actions)[number]): boolean => {
    const value = action.effect.value;
    return value !== null && typeof value === "object" && !Array.isArray(value) && "outbound" in value;
  };
  expect(actions.filter((action) => action.kind === "message" && outbound(action))).toEqual([]);
});

test("an explicit model send_message routes through MessagePort.ingest to the external surface", async () => {
  const explicit = suite.config("explicit-message-", {
    wsToken: "token",
    socialBudgets: [{ id: "owner-budget", targetActorId: "person:owner", maxPerWindow: 1, windowMs: 1000, cooldownMs: 0 }],
  });
  declarePerson(explicit.catalogPath, { id: "person:owner", displayName: "Owner", kind: "human", trustTier: "owner", endpoints: [{ channel: "ws", externalId: "owner" }], reach: true });
  const app = await suite.boot({
    config: explicit,
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        const result = requestToolStep(input, sink, {
          id: "explicit-send", tool: "send_message",
          input: { to: { kind: "contact", id: "person:owner" }, message: "EXPLICIT_SENTINEL" },
        });
        if (result === undefined) return { type: "stop" };
        expect(result.isError).not.toBe(true);
        sink.onMessage(assistantMessage(input, { text: "LOCAL_ONLY_SENTINEL" }));
        return { type: "stop" };
      }),
    },
  });
  const plane = await planeOf(app.runtime);
  const ingest = spyOn(app.gateway, "ingest");
  suite.defer(() => ingest.mockRestore());
  type IngestCall = Parameters<typeof app.gateway.ingest>;
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws?actor=owner`, ["auth", "token"]);
  const delivered = nextFrame(ws, (frame) => frame.type === "message");
  const terminal = nextResidentTurn(plane);
  ws.send(JSON.stringify({ eventId: newTraceId(), text: "send explicitly" }));
  expect(await delivered).toMatchObject({ text: "EXPLICIT_SENTINEL" });
  expect((await terminal).text).toBe("LOCAL_ONLY_SENTINEL");
  expect(ingest.mock.calls.filter(([sender]) => sender.kind === "session")).toEqual([
    [containing<IngestCall[0]>({ kind: "session" }), containing<IngestCall[1]>({
      to: { kind: "actor", actorId: "person:owner" },
      content: { kind: "message", parts: [{ kind: "text", text: "EXPLICIT_SENTINEL" }] },
    })],
  ]);
});

test("#1600 lane R2: the Owner is always the Resident's to write to — an owner-tier Person declared without `reach`, with no budget, takes the letter and no consent is asked", async () => {
  const ownerMail = suite.config("owner-mail-", { wsToken: "token" });
  declarePerson(ownerMail.catalogPath, { id: "person:owner", displayName: "Owner", kind: "human", trustTier: "owner", endpoints: [{ channel: "ws", externalId: "owner" }] });
  const app = await suite.boot({
    config: ownerMail,
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        const result = requestToolStep(input, sink, {
          id: "owner-mail", tool: "send_message",
          input: { to: { kind: "contact", id: "person:owner" }, message: "OWNER_MAIL_SENTINEL" },
        });
        if (result === undefined) return { type: "stop" };
        expect(result.isError).not.toBe(true);
        sink.onMessage(assistantMessage(input, { text: "OWNER_MAIL_DONE" }));
        return { type: "stop" };
      }),
    },
  });
  const plane = await planeOf(app.runtime);
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws?actor=owner`, ["auth", "token"]);
  const delivered = nextFrame(ws, (frame) => frame.type === "message");
  const terminal = nextResidentTurn(plane);
  ws.send(JSON.stringify({ eventId: newTraceId(), text: "write to me" }));
  expect(await delivered).toMatchObject({ text: "OWNER_MAIL_SENTINEL" });
  expect((await terminal).text).toBe("OWNER_MAIL_DONE");
});

test("#1569 lane 8: a Person the Owner named without `reach` is an inbound identity only — the Resident's letter to it is ungranted; `reach` set on the row makes the next letter land, no reboot", async () => {
  const stranger = suite.config("ungranted-message-", {
    wsToken: "token",
    socialBudgets: [{ id: "stranger-budget", targetActorId: "person:stranger", maxPerWindow: 5, windowMs: 1000, cooldownMs: 0 }],
  });
  declarePerson(stranger.catalogPath, { id: "person:owner", displayName: "Owner", kind: "human", trustTier: "owner", endpoints: [{ channel: "ws", externalId: "owner" }], reach: true });
  declarePerson(stranger.catalogPath, { id: "person:stranger", displayName: "Stranger", kind: "human", trustTier: "observer", endpoints: [{ channel: "ws", externalId: "stranger" }] });
  const refusals: string[] = [];
  let letters = 0;
  const app = await suite.boot({
    config: stranger,
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        const result = requestToolStep(input, sink, {
          id: `letter-${letters}`,
          tool: "send_message",
          input: { to: { kind: "contact", id: "person:stranger" }, message: `COLD_SENTINEL_${letters}` },
        });
        if (result === undefined) return { type: "stop" };
        if (result.isError === true) refusals.push(String(result.content));
        sink.onMessage(assistantMessage(input, { text: `DONE_${letters}` }));
        return { type: "stop" };
      }),
    },
  });
  const plane = await planeOf(app.runtime);
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws?actor=owner`, ["auth", "token"]);
  const strangerWs = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws?actor=stranger`, ["auth", "token"]);
  const first = nextResidentTurn(plane);
  ws.send(JSON.stringify({ eventId: newTraceId(), text: "write to the stranger" }));
  expect((await first).text).toBe("DONE_0");
  // The router's `ungranted` surfaces to the tool as the resident's actor-grant policy row.
  expect(refusals).toEqual(["send_message refused: message.resident.actor_grant"]);
  // The Owner's standing grant is read from the store at each send: reach on the row, and the next letter lands.
  const row = plane.stores.persons.get("person:stranger");
  if (row === undefined) throw new Error("the stranger row vanished");
  plane.stores.persons.put({ ...row, reach: true, revision: row.revision + 1, updatedAt: 2 });
  letters = 1;
  const delivered = nextFrame(strangerWs, (frame) => frame.type === "message");
  const second = nextResidentTurn(plane);
  ws.send(JSON.stringify({ eventId: newTraceId(), text: "write to the stranger again" }));
  expect((await second).text).toBe("DONE_1");
  expect(await delivered).toMatchObject({ text: "COLD_SENTINEL_1" });
  expect(refusals).toHaveLength(1);
});

test("a child settlement opens the parent's next turn as its followUp input after the open turn seals", async () => {
  let commissioned = false;
  // Exact-event trace of the parent session: turn terminals and the
  // settlement's delivery commit, in journal commit order.
  const trace: string[] = [];
  const settled = eventSignal<void>("parent settlement turn", 15_000);
  const planeRef: { current: AppLedgerPlane | undefined } = { current: undefined };
  let acknowledged = false;
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    const eventPlane = planeRef.current;
    if (eventPlane === undefined) return;
    const action = sessionTree(event.sessionId, eventPlane.sessionStore(event.sessionId).actions).find(
      (candidate) => candidate.id === event.id,
    );
    if (action === undefined) return;
    if (eventPlane.openKernel(event.sessionId).row(event.sessionId).role === "resident") {
      const terminal = Core.SessionHandleStore.turnTerminal(action);
      if (terminal !== undefined) {
        trace.push(`terminal:${terminal.text ?? ""}`);
        if (terminal.text === "SETTLED_SENTINEL") settled.resolve();
      }
      if (action.kind === "prompt") {
        const delivery = SessionTurn.Delivery.safeParse(action.effect.value);
        // The consumption mode is the delivery row's intent (#1252).
        const intent = action.intent.value;
        const mode =
          intent !== null && typeof intent === "object" && !Array.isArray(intent) && typeof intent.delivery === "string"
            ? intent.delivery
            : "unset";
        if (delivery.success && delivery.data.content.includes("CHILD_SENTINEL"))
          trace.push(`delivered:${mode}`);
      }
    }
    const effect = action.effect.value;
    if (
      action.kind === "message" &&
      effect !== null &&
      typeof effect === "object" &&
      !Array.isArray(effect)
    ) {
      const outbound = SessionTransition.Outbound.safeParse(effect.outbound);
      if (
        outbound.success &&
        outbound.data.state === "delivered" &&
        outbound.data.message.content.includes("CHILD_SENTINEL")
      )
        acknowledged = true;
    }
  });
  suite.defer(unsubscribe);
  const config = suite.config("message-child-", { wsToken: "token" });
  const app = await suite.boot({
    config,
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        const runPlane = planeRef.current;
        if (runPlane === undefined) throw new Error("plane not resolved before model run");
        if (runPlane.openKernel(input.trace.sessionId).row(input.trace.sessionId).role === "child") {
          sink.onMessage(assistantMessage(input, { text: "CHILD_SENTINEL" }));
          return { type: "stop" };
        }
        if (input.messages.some((message) => messageText(message).includes("CHILD_SENTINEL"))) {
          sink.onMessage(assistantMessage(input, { text: "SETTLED_SENTINEL" }));
          return { type: "stop" };
        }
        if (!commissioned) {
          const output = requestToolStep(input, sink, {
            id: "commission",
            tool: "send_message",
            input: commissionInput({ message: "child request", reply_to: "original-binding" }),
          });
          if (output === undefined) return { type: "stop" };
          expect(output.isError).toBeUndefined();
          commissioned = true;
        }
        sink.onMessage(assistantMessage(input, { text: "PARENT_SENTINEL" }));
        return { type: "stop" };
      }),
    },
  });
  planeRef.current = await planeOf(app.runtime);
  const plane = planeRef.current;
  await ownerStart(app, "initial");
  await settled.promise;
  expect(acknowledged).toBe(true);
  // Exact event order: the parent's open turn seals FIRST, the settlement is
  // delivered as a followUp row after that seal, and only then does the next
  // turn open and seal over the settlement input.
  expect(trace).toEqual(["terminal:PARENT_SENTINEL", "delivered:followUp", "terminal:SETTLED_SENTINEL"]);
  const child = plane.listSessions().find((row) => row.role === "child");
  if (child?.parentId === null || child?.parentId === undefined)
    throw new Error("child parent missing");
  const parentTree = sessionTree(child.parentId, plane.sessionStore(child.parentId).actions);
  const rows = settlementRows(plane, child.parentId);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.origin.value).toMatchObject({
    sourceSessionId: child.id,
    terminal: "completed",
    replyTo: "original-binding",
    delivery: "followUp",
  });
  const envelope = Gateway.DelegationResult.parse(JSON.parse(rows[0]?.content ?? ""));
  expect(envelope).toEqual({
    status: "completed",
    preview: "CHILD_SENTINEL",
    pointer: { session: child.id, action: envelope.pointer.action },
  });
  // The settlement's delivery row names the follow-up turn, not the turn that
  // was open when the child sealed.
  const delivery = parentTree.flatMap((action) => {
    const parsed = SessionTurn.Delivery.safeParse(action.effect.value);
    return parsed.success && parsed.data.deliveryId === rows[0]?.id
      ? [{ record: parsed.data, intent: action.intent.value }]
      : [];
  });
  expect(delivery).toHaveLength(1);
  expect(delivery[0]?.intent).toMatchObject({ delivery: "followUp" });
  const settledTurn = parentTree.find(
    (action) => Core.SessionHandleStore.turnTerminal(action)?.text === "SETTLED_SENTINEL",
  );
  if (settledTurn === undefined) throw new Error("settlement turn terminal missing");
  expect(delivery[0]?.record.turnId).not.toBe(
    parentTree.flatMap((action) =>
      Core.SessionHandleStore.turnTerminal(action)?.text === "PARENT_SENTINEL" ? [action] : [],
    )[0]?.id,
  );
  const outbound = plane.openKernel(child.id).outboundRows(child.id)[0];
  const receipt = parentTree.find(
    (action) => action.id === outbound?.destinationReceipt?.id,
  );
  expect(receipt).toMatchObject({
    kind: "request",
    effect: { value: { answer: { inputId: rows[0]?.id, outbound: rows[0]?.origin.value } } },
  });
  // W5.2 consumed = no longer pending in the parent's kernel delivery.
  expect(
    plane
      .openKernel(child.parentId)
      .pendingMessages(child.parentId)
      .some((item) => item.id === rows[0]?.id),
  ).toBe(false);
  const sessionsDir = config.sessionsDir;
  if (sessionsDir === undefined) throw new Error("suite config is missing sessionsDir");
  assertNoLegacyRequestStores(sessionFilePath(sessionsDir, child.parentId));
});

test("an interrupt-then-resume child settles exactly once and a later seal writes nothing", async () => {
  let commissioned = false;
  let childRuns = 0;
  const entered = Promise.withResolvers<string>();
  const release = Promise.withResolvers<void>();
  const interruptedSeal = eventSignal<void>("child interrupted terminal", 15_000);
  const settledSeal = eventSignal<void>("child settlement acknowledged", 15_000);
  const secondSeal = eventSignal<void>("child second terminal", 15_000);
  const planeRef: { current: AppLedgerPlane | undefined } = { current: undefined };
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    const eventPlane = planeRef.current;
    if (eventPlane === undefined) return;
    if (eventPlane.openKernel(event.sessionId).row(event.sessionId).role !== "child") return;
    const action = sessionTree(event.sessionId, eventPlane.sessionStore(event.sessionId).actions).find(
      (candidate) => candidate.id === event.id,
    );
    if (action === undefined) return;
    const terminal = Core.SessionHandleStore.turnTerminal(action);
    if (terminal?.kind === "interrupted") interruptedSeal.resolve();
    if (terminal?.text === "CHILD_AGAIN_SENTINEL") secondSeal.resolve();
    const effect = action.effect.value;
    if (
      action.kind === "message" &&
      effect !== null &&
      typeof effect === "object" &&
      !Array.isArray(effect)
    ) {
      const outbound = SessionTransition.Outbound.safeParse(effect.outbound);
      if (outbound.success && outbound.data.state === "delivered") settledSeal.resolve();
    }
  });
  suite.defer(() => {
    unsubscribe();
    release.resolve();
  });
  let resumeSent = false;
  let againSent = false;
  const childIdRef: { current: string | undefined } = { current: undefined };
  const app = await suite.boot({
    config: suite.config("message-child-resume-", { wsToken: "token" }),
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.gen(function* () {
        const runPlane = planeRef.current;
        if (runPlane === undefined) throw new Error("plane not resolved before model run");
        if (runPlane.openKernel(input.trace.sessionId).row(input.trace.sessionId).role === "child") {
          childRuns += 1;
          if (childRuns === 1) {
            entered.resolve(input.trace.sessionId);
            yield* Effect.promise(() => release.promise);
          }
          sink.onMessage(assistantMessage(input, {
            text: childRuns >= 3 ? "CHILD_AGAIN_SENTINEL" : "CHILD_SENTINEL",
          }));
          return { type: "stop" as const };
        }
        const transcript = input.messages.map(messageText).join("\n");
        const childId = childIdRef.current;
        if (transcript.includes("GO_AGAIN") && !againSent && childId !== undefined) {
          const output = requestToolStep(input, sink, {
            id: "again",
            tool: "send_message",
            input: { to: { kind: "session", id: childId }, kind: "prompt", message: "go again" },
          });
          if (output === undefined) return { type: "stop" as const };
          expect(output.isError).toBeUndefined();
          againSent = true;
        } else if (transcript.includes("RESUME_CHILD") && !resumeSent && childId !== undefined) {
          const output = requestToolStep(input, sink, {
            id: "resume",
            tool: "send_message",
            input: { to: { kind: "session", id: childId }, kind: "resume", message: "continue" },
          });
          if (output === undefined) return { type: "stop" as const };
          expect(output.isError).toBeUndefined();
          resumeSent = true;
        } else if (!commissioned) {
          const output = requestToolStep(input, sink, {
            id: "commission",
            tool: "send_message",
            input: commissionInput({ message: "child request", reply_to: "resume-binding" }),
          });
          if (output === undefined) return { type: "stop" as const };
          expect(output.isError).toBeUndefined();
          commissioned = true;
        }
        sink.onMessage(assistantMessage(input, { text: "PARENT_SENTINEL" }));
        return { type: "stop" as const };
      }),
    },
  });
  planeRef.current = await planeOf(app.runtime);
  const plane = planeRef.current;
  await ownerStart(app, "initial");
  const childId = await entered.promise;
  childIdRef.current = childId;
  const handle = app.sessions.get(childId);
  if (handle === undefined) throw new Error("missing child handle");
  const interrupt = runEffect(handle.interrupt());
  release.resolve();
  await interrupt;
  await interruptedSeal.promise;
  const child = plane.openKernel(childId).row(childId);
  if (child.parentId === null) throw new Error("child parent missing");
  // #1311: the interrupted seal wrote NOTHING toward the parent.
  expect(plane.openKernel(childId).outboundRows(childId)).toEqual([]);
  expect(settlementRows(plane, child.parentId)).toEqual([]);
  // Resume through the one send door: the owner asks, the parent's model
  // sends `type: "resume"`, the child completes and settles exactly once.
  await runEffect(app.gateway.ingest(
    { kind: "external", surface: "ws", externalId: "owner" },
    { eventId: "resume-step", surface: "ws", channelId: "owner", addressees: [], dm: true, payload: {}, render: "RESUME_CHILD" },
  ));
  await settledSeal.promise;
  const settlements = settlementRows(plane, child.parentId);
  expect(settlements).toHaveLength(1);
  expect(Gateway.DelegationResult.parse(JSON.parse(settlements[0]?.content ?? ""))).toMatchObject({
    status: "completed",
    preview: "CHILD_SENTINEL",
  });
  // A later completed seal writes nothing: the settlement already exists.
  await runEffect(app.gateway.ingest(
    { kind: "external", surface: "ws", externalId: "owner" },
    { eventId: "again-step", surface: "ws", channelId: "owner", addressees: [], dm: true, payload: {}, render: "GO_AGAIN" },
  ));
  await secondSeal.promise;
  expect(plane.openKernel(childId).outboundRows(childId)).toHaveLength(1);
  expect(settlementRows(plane, child.parentId)).toHaveLength(1);
});

test("a cap-denied spawn surfaces the typed DelegationRefusal on the model-facing ToolRefused", async () => {
  const refusalText: { current: string | undefined } = { current: undefined };
  const app = await suite.boot({
    config: suite.config("message-cap-denied-", { wsToken: "token" }),
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        const output = requestToolStep(input, sink, {
          id: "denied-commission",
          tool: "send_message",
          input: commissionInput({ message: "child request", reply_to: "denied-binding" }),
        });
        if (output === undefined) return { type: "stop" };
        expect(output.isError).toBe(true);
        refusalText.current = String(output.content);
        sink.onMessage(assistantMessage(input, { text: "REFUSED_SENTINEL" }));
        return { type: "stop" };
      }),
    },
  });
  const plane = await planeOf(app.runtime);
  // Re-seed the spawn_children row at limit 0 BEFORE the resident session
  // opens: the session snapshot compiles the latest policy generation, so
  // the parent's very first spawn attempt hits the cap.
  plane.catalog.policies.appendGeneration((current) =>
    current.map(({ generation: _generation, ...row }) =>
      row.name === "delegation-policy/tool.pre#2"
        ? {
            ...row,
            verdict: {
              encodingVersion: 1 as const,
              value: { type: "consult", ref: "delegation-policy/spawn-children", config: { limit: 0 } },
            },
          }
        : row,
    ),
  );
  const terminal = nextResidentTurn(plane);
  await ownerStart(app, "cap-denied");
  expect((await terminal).text).toBe("REFUSED_SENTINEL");
  // #1311 merge condition: the ToolRefused content the caller's model reads
  // IS the typed refusal — cap, limit and observed count as parseable JSON.
  const text = refusalText.current ?? "";
  expect(text.startsWith("send_message refused: ")).toBe(true);
  const refusal = DelegationRefusal.parse(JSON.parse(text.slice("send_message refused: ".length)));
  expect(refusal).toEqual({ code: "delegation_refused", cap: "spawn_children", limit: 0, observed: 0 });
  // The refused send created no child row.
  expect(plane.listSessions().filter((row) => row.role === "child")).toEqual([]);
});
