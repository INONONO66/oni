import { sessionTree } from "../helpers/session-tree";
import { beforeEach, expect, test } from "bun:test";
import { canonicalDigest, type LedgerAction, type SessionTransition } from "@oni/protocol";
import { materializeSession } from "../helpers/session";
import { useMemoryStores } from "../helpers/storage";

const stores = useMemoryStores();
beforeEach(() => {
  materializeSession(stores.kernel, "source");
});

function append(action: LedgerAction.Append) {
  const receipt = stores.session.actions.append(action, stores.kernel.row("source").revision);
  if (receipt === undefined) throw new Error("projection fixture commit failed");
}

test("outbound projection folds a verified acknowledgement without erasing its pending history", () => {
  const payload = {
    messageId: "terminal:reply",
    sourceSessionId: "source",
    sourceActionId: "terminal",
    destinationSessionId: "receiver",
    requestId: "original",
    replyTo: "binding",
    terminal: "completed" as const,
    content: "answer",
  };
  const message: SessionTransition.OutboundMessage = {
    ...payload,
    digest: canonicalDigest(payload),
  };
  append({
    id: "pending",
    parentId: "source:configure",
    sessionId: "source",
    kind: "message",
    ts: 2,
    irreversible: true,
    intent: { encodingVersion: 1, value: { op: "open" } },
    effect: {
      encodingVersion: 1,
      value: { outbound: { message, state: "pending", destinationReceipt: null } },
    },
  });
  expect(stores.kernel.outboundRows("source")).toEqual([
    { message, state: "pending", destinationReceipt: null },
  ]);
  append({
    id: "ack",
    parentId: "pending",
    sessionId: "source",
    kind: "message",
    ts: 3,
    irreversible: true,
    intent: { encodingVersion: 1, value: { op: "ack" } },
    effect: {
      encodingVersion: 1,
      value: {
        outbound: {
          message,
          state: "delivered",
          destinationReceipt: { id: "received", revision: 2 },
        },
      },
    },
  });
  expect(stores.kernel.outboundRows("source")).toEqual([
    { message, state: "delivered", destinationReceipt: { id: "received", revision: 2 } },
  ]);
  expect(sessionTree("source", stores.session.actions).map((action) => action.id)).toEqual([
    "source:configure",
    "pending",
    "ack",
  ]);
});

test("corrupt outbound evidence cannot silently disappear from recovery", () => {
  append({
    id: "corrupt",
    parentId: "source:configure",
    sessionId: "source",
    kind: "message",
    ts: 2,
    irreversible: true,
    intent: { encodingVersion: 1, value: { op: "open" } },
    effect: { encodingVersion: 1, value: null },
  });
  expect(() => stores.kernel.outboundRows("source")).toThrow("invalid outbound action effect");
});
