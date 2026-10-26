import { APPROVAL_POLICY } from "../src/composition/policy";
import { expect, test } from "bun:test";
import { Core } from "@oni/agent";
const createExecutor = Core.createExecutor;
import { Delivery, SessionGeneration, type LedgerSession, type SessionTransition } from "@oni/protocol";
import { Effect } from "effect";
import {
  createMessageDeliveryCommit,
  deliverPayload,
  materializeDeliveryTarget,
  messageMaterialization,
  pendingDeliveryRow,
} from "../src/composition/message-session";
import { outboundMessage } from "../src/composition/terminal-message";
import { runnerTestLayer } from "../../../packages/agent/test/helpers/isolated";
import { runEffect } from "./helpers/effect";
import { testPlane } from "./helpers/ledger";
import { testIds } from "./helpers/test-entropy";

const origin = {
  encodingVersion: 1,
  value: {
    kind: "message",
    messageId: "source-message",
    senderSessionId: "source",
    sourceActionId: "source-action",
  },
} as const;

function deliveryCommit(
  id: string,
  createSession?: LedgerSession.Materialize,
  limits?: { readonly fanout: number; readonly depth: number },
): Delivery.Commit {
  return Delivery.Commit.parse({
    id: `${id}:message`,
    sessionId: id,
    kind: "prompt",
    content: [{ kind: "text", text: "hello" }],
    origin,
    createdAt: 100,
    parentActionId: null,
    ...(createSession === undefined ? {} : { createSession }),
    ...(limits === undefined ? {} : { limits }),
  });
}

test("delivery target materialization refuses a child beyond its pinned fanout", async () => {
  const plane = testPlane();
  const materialize = messageMaterialization(() => 1, testIds("materialize"));
  try {
    await runEffect(
      materializeDeliveryTarget(
        plane,
        deliveryCommit(
          "parent",
          materialize({
            id: "parent",
            parentId: null,
            role: "resident",
            tools: [],
            preset: "",
            runner: "resident",
            at: 100,
          }),
        ),
        () => 100,
      ),
    );
    await runEffect(
      materializeDeliveryTarget(
        plane,
        deliveryCommit(
          "first-child",
          materialize({
            id: "first-child",
            parentId: "parent",
            role: "child",
            tools: [],
            preset: "",
            runner: "child",
            at: 101,
          }),
          { fanout: 1, depth: 2 },
        ),
        () => 101,
      ),
    );
    await expect(
      runEffect(
        materializeDeliveryTarget(
          plane,
          deliveryCommit(
            "second-child",
            materialize({
              id: "second-child",
              parentId: "parent",
              role: "child",
              tools: [],
              preset: "",
              runner: "child",
              at: 102,
            }),
            { fanout: 1, depth: 2 },
          ),
          () => 102,
        ),
      ),
    ).rejects.toMatchObject({
      _tag: "AgentFailure",
      operation: "message.commit",
      cause: "child fanout limit exhausted",
    });
    expect(plane.listSessions().map((row) => row.id).sort()).toEqual([
      "first-child",
      "parent",
    ]);
  } finally {
    plane.close();
  }
});

test("delivery target creation indexes the genesis in one core write and a repeat is the idempotent outcome", async () => {
  // #1346 boundary: the app no longer materializes then indexes in two calls;
  // the catalog row and the configure genesis exist together or not at all.
  const plane = testPlane();
  const materialize = messageMaterialization(() => 1, testIds("materialize"));
  const target = () =>
    deliveryCommit(
      "target",
      materialize({
        id: "target",
        parentId: null,
        role: "resident",
        tools: [],
        preset: "",
        runner: "resident",
        at: 100,
        settings: { steering: "one", followUp: "all", forkCopyByteCap: 2048 },
      }),
    );
  try {
    await runEffect(materializeDeliveryTarget(plane, target(), () => 100));
    const kernel = plane.openKernel("target");
    const genesis = kernel.latestAction("target");
    expect(genesis?.kind).toBe("session.configure");
    expect(kernel.row("target").revision).toBe(1);
    expect(plane.catalog.sessionIndex("target")).toMatchObject({ id: "target", parentId: null, role: "resident" });
    expect(SessionGeneration.ConfigureIntent.parse(genesis?.intent.value).settings).toEqual({
      steering: "one",
      followUp: "all",
      forkCopyByteCap: 2048,
    });
    // A second creator racing the same id neither rewrites genesis nor fails the delivery.
    await runEffect(materializeDeliveryTarget(plane, target(), () => 200));
    expect(kernel.row("target").revision).toBe(1);
    expect(kernel.latestAction("target")?.id).toBe(genesis?.id);
    expect(plane.listSessions().map((row) => row.id)).toEqual(["target"]);
  } finally {
    plane.close();
  }
});

const message: SessionTransition.OutboundMessage = {
  messageId: "letter",
  sourceSessionId: "child",
  sourceActionId: "terminal",
  destinationSessionId: "parent",
  requestId: "request",
  replyTo: "request",
  terminal: "completed",
  content: "CHILD_RESULT",
  digest: "digest",
};

async function outboundExecutor() {
  return runEffect(
    createExecutor({
      approvalPolicy: APPROVAL_POLICY,
      identity: { sessionId: "child", role: "child", parentActionId: "terminal" },
      ledger: { commit: () => Effect.die(new Error("unused executor commit")) },
    }).pipe(Effect.provide(runnerTestLayer)),
  );
}

for (const { name, id, content } of [
  {
    name: "bytes that do not match the outbound letter",
    id: "different-letter",
    content: [{ kind: "text", text: message.content }],
  },
  {
    name: "an appended text part with matching outbound ids",
    id: message.messageId,
    content: [{ kind: "text", text: message.content }, { kind: "text", text: "extra" }],
  },
  {
    name: "an appended image part with matching outbound ids",
    id: message.messageId,
    content: [
      { kind: "text", text: message.content },
      { kind: "image", ref: "self:/extra.png", mime: "image/png" },
    ],
  },
] satisfies { name: string; id: string; content: Delivery.Commit["content"] }[]) {
  test(`entity delivery refuses ${name}`, async () => {
    const plane = testPlane();
    const executor = await outboundExecutor();
    const unreachable = () => Effect.die(new Error("entity client must not run"));
    const commit = createMessageDeliveryCommit({
      plane,
      client: () => ({
        Deliver: unreachable,
        Resolve: unreachable,
        Alarm: unreachable,
        Read: unreachable,
      }),
      clock: () => 100,
    });
    try {
      await expect(
        runEffect(
          commit({
            id,
            sessionId: message.destinationSessionId,
            kind: "prompt",
            content,
            origin: { encodingVersion: 1, value: message },
            createdAt: 100,
            parentActionId: null,
          }).pipe(
            Effect.provideService(outboundMessage, {
              input: { message, ledger: { commit: () => Effect.die(new Error("unused source ledger")) } },
              executor,
            }),
          ),
        ),
      ).rejects.toMatchObject({
        _tag: "AgentFailure",
        operation: "message.commit",
        cause: "outbound delivery binding mismatch",
      });
      expect(plane.listSessions()).toEqual([]);
    } finally {
      plane.close();
    }
  });
}

test("entity delivery accepts the exact one-text-part outbound letter", async () => {
  const input: Delivery.Commit = {
    id: message.messageId,
    sessionId: message.destinationSessionId,
    kind: "prompt",
    content: [{ kind: "text", text: message.content }],
    origin: { encodingVersion: 1, value: message },
    createdAt: 100,
    parentActionId: null,
  };
  const executor = await outboundExecutor();
  const payload = await runEffect(
    deliverPayload(input).pipe(
      Effect.provideService(outboundMessage, {
        input: { message, ledger: { commit: () => Effect.die(new Error("unused source ledger")) } },
        executor,
      }),
    ),
  );
  expect(payload.idempotencyKey).toBe(message.messageId);
  expect(JSON.parse(payload.body)).toEqual({
    content: input.content,
  });
});

test("entity delivery serializes ordered text and media with its consumption boundary", async () => {
  const input: Delivery.Commit = {
    ...deliveryCommit("media"),
    content: [
      { kind: "text", text: "look" },
      { kind: "image", ref: "self:/image.png", mime: "image/png" },
    ],
  };
  const payload = await runEffect(deliverPayload(input));
  expect(JSON.parse(payload.body)).toEqual({
    content: input.content,
  });
  expect(pendingDeliveryRow(input, 3)).toMatchObject({
    content: input.content,
  });
});
