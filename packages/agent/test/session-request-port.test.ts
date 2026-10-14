import { latestGeneration, configureAction } from "../src/core/store/configure";
import { sessionTree } from "./helpers/session-tree";
import { isolated, isolatedLedger } from "./helpers/isolated";
import { Effect, Exit } from "effect";
import { expect, test } from "bun:test";

import { canonicalDigest, type LedgerAction } from "@openomni/protocol";
import {
  appendSourceInvocation,
  gatewayPort,
  materializeSource,
  messageIntent,
  openingRequest as opening,
} from "./helpers/request-port";

const setup = Effect.gen(function* () {
  yield* materializeSource;
  for (const id of ["first", "second"]) appendSourceInvocation(id, messageIntent(id));
});

test("gateway request port commits physical bindings and receiving intake without a live controller", () => isolated(Effect.gen(function* () {
  yield* setup;
  const received: string[] = [];
  const port = yield* gatewayPort({
    onDeliveryCommitted: (ids) => {
      // No release plane: the gateway's fenced intake leaves its adopted owner durable.
      expect(isolatedLedger().kernel.row("source").fenceOwner).not.toBeNull();
      received.push(...ids);
    },
  });
  const opened = yield* port.open(opening("first"));
  const request = yield* port.receipt({
    inputId: "physical",
    requestId: opened.requestId,
    sessionId: "source",
    sourceActionId: opened.requestId,
    externalMessageId: "platform",
    value: "unknown",
    at: 100,
  });
  expect(request.correlation.replyToMessageId).toBe("platform");
  expect(request.state).toBe("open");
  const input = {
    inputId: "answer",
    requestId: request.requestId,
    sessionId: "source",
    receivedAt: 100,
    principal: { kind: "actor" as const, principalId: "peer", evidenceId: "platform-answer" },
    bindingDigest: request.bindingDigest,
    inputHash: request.inputHash,
    effectHash: request.effectHash,
    generation: request.generation,
    toolsHash: request.toolsHash,
    domainRevisions: {},
    decision: "answer" as const,
    allowedAction: "report_result" as const,
    content: "answer",
  };
  expect(yield* port.answer(input)).toBe("resolved");
  const before = sessionTree(isolatedLedger().kernel, "source");
  expect(yield* port.answer({ ...input, receivedAt: 150 })).toBe("resolved");
  expect(sessionTree(isolatedLedger().kernel, "source")).toEqual(before);
  expect(received).toEqual(["source"]);
  expect(isolatedLedger().kernel.pendingMessages("source")).toHaveLength(1);
  expect(port.list()[0]?.state).toBe("resolved");
})));

test("gateway timeout resolves the original action without creating conversational input", () => isolated(Effect.gen(function* () {
  yield* setup;
  let now = 100;
  const port = yield* gatewayPort({ clock: () => now });
  yield* port.open(opening("first"));
  yield* port.timeout("first", 199);
  expect(port.list()[0]?.state).toBe("open");
  now = 200;
  yield* port.timeout("first", now);
  expect(port.list()[0]?.state).toBe("expired");
  expect(isolatedLedger().kernel.pendingMessages("source")).toEqual([]);
  const before = sessionTree(isolatedLedger().kernel, "source");
  yield* port.timeout("first", now);
  expect(sessionTree(isolatedLedger().kernel, "source")).toEqual(before);
})));

test("a deadline for an unknown request dies loudly instead of acking a phantom", () => isolated(Effect.gen(function* () {
  yield* setup;
  const port = yield* gatewayPort();
  const outcome = yield* Effect.exit(port.timeout("never-opened", 100));
  expect(outcome._tag).toBe("Failure");
  expect(String(outcome)).toContain("deadline request missing: never-opened");
})));

test("request opening uses its original turn generation, never a later catalog", () => isolated(Effect.gen(function* () {
  yield* setup;
  const generation = latestGeneration(sessionTree(isolatedLedger().kernel, "source"));
  const append = (action: LedgerAction.Append) => {
    if (
      isolatedLedger().session.actions.append(action, isolatedLedger().kernel.row("source").revision) === undefined
    )
      throw new Error("fixture append failed");
  };
  append({
    id: "turn",
    parentId: "configure",
    sessionId: "source",
    kind: "turn",
    ts: 2,
    irreversible: true,
    intent: {
      encodingVersion: 1,
      value: {
        phase: "intent",
        resultId: "result",
        deliveryIds: [],
        resumeCount: 0,
        boundaryActionId: "configure",
        toolsGeneration: generation.generation,
        toolsHash: generation.toolsHash,
        systemHash: generation.systemHash,
        policyGeneration: generation.policyGeneration,
      },
    },
    effect: { encodingVersion: 1, value: { phase: "pending" } },
  });
  for (const id of ["pinned", "stale", "missing-turn"])
    append({
      id,
      sessionId: "source",
      parentId: "turn",
      kind: "message",
      ts: 3,
      irreversible: true,
      intent: {
        encodingVersion: 1,
        value: {
          phase: "intent",
          turnId: id === "missing-turn" ? "absent" : "turn",
          callId: "call",
          value: {},
          effectHash: canonicalDigest({}),
        },
      },
      effect: { encodingVersion: 1, value: { phase: "pending" } },
    });
  const port = yield* gatewayPort();
  expect(yield* port.open(opening("pinned"))).toMatchObject({
    turnId: "turn",
    callId: "call",
    toolsGeneration: 1,
  });
  expect(Exit.isFailure(yield* Effect.exit(port.open(opening("missing-turn"))))).toBe(true);
  const row = isolatedLedger().kernel.row("source");
  const lease = yield* isolatedLedger().kernel.adoptFence({
    sessionId: "source",
    owner: "configure",
    fence: row.fence + 1,
  });
  const next = { ...generation, generation: 2, revertTo: 1 };
  yield* isolatedLedger().kernel.commit({
    sessionId: "source",
    owner: "configure",
    fence: lease.fence,
    now: 100,
    expectedRevision: row.revision,
    actions: [
      configureAction({
        id: "next",
        sessionId: "source",
        parentId: "configure",
        operation: "tools.add",
        snapshot: next,
        at: 100,
      }),
    ],
    state: "idle",
    generation: {
      toolsGeneration: 2,
      systemHash: next.systemHash,
      policyGeneration: next.policyGeneration,
    },
  });
  expect(Exit.isFailure(yield* Effect.exit(port.open(opening("stale"))))).toBe(true);
})));

test("gateway port refuses missing original actions and mismatched physical receipts", () => isolated(Effect.gen(function* () {
  yield* setup;
  const port = yield* gatewayPort();
  expect(Exit.isFailure(yield* Effect.exit(port.open(opening("missing"))))).toBe(true);
  yield* port.open(opening("first"));
  const before = sessionTree(isolatedLedger().kernel, "source");
  const refused = yield* Effect.exit(port.receipt({
      inputId: "bad",
      requestId: "first",
      sessionId: "source",
      sourceActionId: "second",
      value: "accepted",
      at: 100,
    }));
  expect(Exit.isFailure(refused)).toBe(true);
  expect(sessionTree(isolatedLedger().kernel, "source")).toEqual(before);
})));
