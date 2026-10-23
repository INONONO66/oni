import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Gateway, type Delivery, L0Observation, LedgerAction, type ObservationSink, SessionTransition, } from "@oni/protocol";
import { type ObservationPublishFailure, publishCommitted } from "../../../src/core/store/storage/sqlite-l0-observation";
import { createActions } from "../../../src/core/store/session-file/actions";
import { L0Write } from "../../../src/core/store/session-file";
import { openLedgerDatabase } from "../helpers/ledger";

function action(
  kind: LedgerAction.Kind,
  id: string,
  intent: LedgerAction.Node["intent"]["value"],
  effect: LedgerAction.Node["effect"]["value"] = {},
): LedgerAction.Receipt {
  return {
    revision: 1,
    action: LedgerAction.Node.parse({
      id,
      sessionId: "session",
      parentId: null,
      kind,
      intent: { encodingVersion: 1, value: intent },
      effect: { encodingVersion: 1, value: effect },
      irreversible: true,
      ts: 20,
      ordinal: 1,
    }),
  };
}

function capture() {
  const events: Array<{ name: string; payload: string; sessionId?: string }> = [];
  const sink: ObservationSink = {
    publish(event, payload) {
      events.push({ name: event.name, payload: JSON.stringify(payload) });
    },
    scope(identity) {
      return {
        publish(event, payload) {
          events.push({ name: event.name, payload: JSON.stringify(payload), sessionId: identity.sessionId });
        },
      };
    },
  };
  return { events, sink };
}

function requestRow(db: Database, intent: object = { value: { messageId: "platform-1" } }): void {
  db.run("INSERT INTO session (id, role, state) VALUES ('session', 'resident', 'idle')");
  db.query(
    `INSERT INTO action (
      id, session_id, kind, intent, effect, irreversible, encoding_version,
      ts, ordinal
    ) VALUES ('original', 'session', 'tool', ?, '{}', 1, 1, 8, 1)`,
  ).run(JSON.stringify(intent));
}

test("a committed reply prompt publishes its scoped platform message identity", () => {
  using db = openLedgerDatabase();
  requestRow(db);
  const { events, sink } = capture();
  const origin: Delivery.ReplyOrigin = {
    kind: "external_reply",
    messageId: "reply-1",
    sourceActionId: "original",
    replyTo: "platform-0",
  };

  expect(publishCommitted(db, sink, action("prompt", "reply-action", origin))).toBeUndefined();

  expect(events).toEqual([
    {
      name: L0Observation.ActionCommittedEvent.name,
      payload: JSON.stringify({ id: "reply-action", sessionId: "session", revision: 1, kind: "prompt" }),
    },
    {
      name: Gateway.MessageObserved.name,
      payload: JSON.stringify({
        kind: "message.replied",
        messageId: "platform-1",
        replyTo: "platform-0",
        roundTripMs: 12,
      }),
      sessionId: "session",
    },
  ]);
});

test("a native outbound message uses its request binding for the reply observation", () => {
  using db = openLedgerDatabase();
  requestRow(db);
  const { events, sink } = capture();
  const outbound: SessionTransition.OutboundMessage = {
    messageId: "outbound",
    sourceSessionId: "child",
    sourceActionId: "terminal",
    destinationSessionId: "session",
    requestId: "original",
    replyTo: "platform-0",
    terminal: "completed",
    content: "done",
    digest: "digest",
  };

  expect(publishCommitted(db, sink, action("prompt", "native-reply", outbound))).toBeUndefined();

  expect(events[1]).toEqual({
    name: Gateway.MessageObserved.name,
    payload: JSON.stringify({
      kind: "message.replied",
      messageId: "platform-1",
      replyTo: "platform-0",
      roundTripMs: 12,
    }),
    sessionId: "session",
  });
});

test("a reply deadline publishes a timeout from its original source identity", () => {
  using db = openLedgerDatabase();
  requestRow(db, { value: null });
  const { events, sink } = capture();
  const request = SessionTransition.Request.parse({
    requestId: "original",
    sessionId: "session",
    turnId: null,
    callId: "call",
    mode: "answer",
    parsedInput: {},
    inputHash: "input",
    effectHash: "effect",
    generation: 1,
    toolsGeneration: 1,
    toolsHash: "tools",
    systemHash: "system",
    domainRevisions: {},
    deadline: 20,
    expectedResponders: ["actor"],
    correlation: {},
    allowedActions: ["report_result"],
    bindingDigest: "binding",
    resolution: "first",
    threshold: 1,
    seenReplyIds: [],
    replies: [],
    state: "expired",
    outcome: "outcome_unknown",
    createdAt: 3,
  });

  expect(publishCommitted(db, sink, action("request", "original:resolution", {}, { request }))).toBeUndefined();

  expect(events[1]).toEqual({
    name: Gateway.MessageObserved.name,
    payload: JSON.stringify({ kind: "message.timed_out", messageId: "original", waitedMs: 17 }),
    sessionId: "session",
  });
});

test("observation delivery failure does not revoke the committed action and surfaces as a value", () => {
  using db = openLedgerDatabase();
  const cause = new Error("subscriber unavailable");
  const sink: ObservationSink = {
    publish() {
      throw cause;
    },
  };

  expect(publishCommitted(db, sink, action("turn", "committed", {}))).toEqual({
    actionId: "committed",
    cause,
  });
});

test("a non-Error publish throw is normalized into the failure's Error cause", () => {
  using db = openLedgerDatabase();
  const sink: ObservationSink = {
    publish() {
      // biome-ignore lint/style/useThrowOnlyError: the sink is a foreign port; a non-Error throw is the case under test
      throw "subscriber string";
    },
  };

  expect(publishCommitted(db, sink, action("turn", "committed", {}))).toEqual({
    actionId: "committed",
    cause: new Error("subscriber string"),
  });
});

test("the actions adapter routes a publish failure to its observation failure port", () => {
  using db = openLedgerDatabase();
  db.run("INSERT INTO session (id, role, state) VALUES ('session', 'resident', 'idle')");
  const failures: ObservationPublishFailure[] = [];
  const transaction = <T,>(operation: () => T): T => db.transaction(operation).immediate();
  const actions = createActions(
    db,
    transaction,
    {
      publish() {
        throw new Error("subscriber unavailable");
      },
    },
    (failure) => failures.push(failure),
    { rowByteCap: L0Write.DEFAULT_ROW_BYTE_CAP },
  );

  const receipt = actions.append(
    {
      id: "committed",
      sessionId: "session",
      parentId: null,
      kind: "turn",
      intent: { encodingVersion: 1, value: {} },
      effect: { encodingVersion: 1, value: {} },
      irreversible: true,
      ts: 9,
    },
    0,
  );

  expect(receipt?.action.id).toBe("committed");
  expect(failures).toEqual([
    { actionId: "committed", cause: new Error("subscriber unavailable") },
  ]);
});
