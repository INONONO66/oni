import { ledger } from "../../helpers/ledger";
import { sessionTree } from "../../../../agent/test/store/helpers/session-tree";
import { effectFailure } from "../../helpers/effect-failure";
import { channelRequests } from "../../helpers/channel-requests";
import { channelTransaction } from "../../helpers/channel-transaction";
import { seededRequests } from "../../helpers/requests";
import { runEffect } from "../../helpers/effect";
import { replaceDecisionFacts } from "../../helpers/ledger";
import { beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { type Gateway, Outbound, type PlainObject, type SessionTransition, type Storage } from "@openomni/protocol";
import { Bus } from "../../helpers/observation";
import { createExistingAgentMessaging } from "../../../src/router/messaging/send.js";
import type { KernelDeliveryReceipt } from "../../../src/support/deliver";

type OutboundMessage = Parameters<Parameters<typeof createExistingAgentMessaging>[0]["deliver"]>[0];
import { expectAwaited, expectDenied, expectRequestSpecViolation, buildAwaitedSendInput, buildGrant, buildSendInput, messagingNow, registerAgentFixture, } from "../../helpers/messaging.js";
import { resetStores } from "../_router-fixture";

type SenderTargetGrant = Gateway.SenderTargetGrant;

import { bounded } from "../../helpers/bounded";

let deliveries: OutboundMessage[];
let grants: SenderTargetGrant[];

function inspectDebitCount(): number {
  let count: number | undefined;
  ledger().stores.egressBudgets.claim(
    {
      id: "test:inspection-never-recorded",
      senderId: "actor:sender",
      targetActorId: "actor:target",
      class: "notify",
      at: messagingNow,
    },
    0,
    (state: { countInWindow: number; notifyInWindow: number; converseInWindow: number; lastSendAt?: number | undefined; }) => {
      count = state.countInWindow;
      return "inspect" as const;
    },
  );
  if (count === undefined) throw new Error("egress claim evaluator was not called");
  return count;
}

function messagingPorts() {
  return {
    stores: ledger().stores,
    transaction: channelTransaction,
    requests: channelRequests(seededRequests()),
    deliver: (message: OutboundMessage) => {
      deliveries.push(message);
      return { value: "accepted" as const };
    },
    grants: () => grants,
    publish: Bus.publish,
  };
}

function messaging() {
  return createExistingAgentMessaging(messagingPorts());
}

type DecisionFacts = Storage.DecisionFactSubAdapter;
type DecisionFact = Parameters<DecisionFacts["record"]>[0];
type RecordResult = ReturnType<DecisionFacts["record"]>;

function overrideAdmissionRecord(record: (facts: DecisionFacts, fact: DecisionFact) => RecordResult): void {
  replaceDecisionFacts((facts: DecisionFacts) => ({
    ...facts,
    record: (fact: DecisionFact) =>
      fact.type === "gateway.send.admitted" ? record(facts, fact) : facts.record(fact),
  }));
}

beforeEach(() => {
  resetStores();
  deliveries = [];
  grants = [buildGrant("grant:sender->target")];
  registerAgentFixture("actor:sender");
  registerAgentFixture("actor:target", [{ id: "endpoint:target", externalId: "target-1" }]);
});

test("preflight reads authority without debiting, opening requests, or delivering", () => {
  expect(messaging().preflight(buildAwaitedSendInput())).toBeUndefined();
  expect(inspectDebitCount()).toBe(0);
  expect(ledger().kernel.requestRows()).toHaveLength(0);
  expect(deliveries).toEqual([]);
});

test("receipt assertions reject wrong discriminants and denial codes", async () => {
  grants = [];
  const denied = await runEffect(messaging().send(buildSendInput()));
  expect(() => expectDenied(denied, "target_missing")).toThrow();
  expect(() => expectAwaited(denied)).toThrow();
  grants = [buildGrant("grant:sender->target")];
  const sent = await runEffect(messaging().send(buildSendInput()));
  expect(() => expectDenied(sent, "ungranted")).toThrow();
  expect(() => expectAwaited(sent)).toThrow();
});

describe("sender-target grant (policy plane)", () => {
  test("send without any covering grant is denied ungranted and delivers nothing", async () => {
    grants = [];
    const audits: { code: string; time: number; traceId: string }[] = [];
    const observed = Promise.withResolvers<void>();
    Bus.observe((event: { readonly name: string; }, payload: string | number | bigint | boolean | symbol | object | null | undefined) => {
      if (event.name !== "messaging.denied") return;
      const data = payload as { code: string; time: number; traceId: string };
      audits.push({ code: data.code, time: data.time, traceId: data.traceId });
      observed.resolve();
    });

    const receipt = await runEffect(messaging().send(buildSendInput()));

    expectDenied(receipt, "ungranted");
    expect(deliveries).toHaveLength(0);
    expect(ledger().kernel.requestRows()).toHaveLength(0);
    await bounded(observed.promise);
    // Pin (D11): the denial audit inherits the send input's trace.
    expect(audits).toEqual([{ code: "ungranted", time: messagingNow, traceId: "trace-messaging" }]);
  });

  test("a grant bounds the operation: fire_and_forget-only grant denies awaited delivery", async () => {
    grants = [buildGrant("grant:notify-only", { operations: ["fire_and_forget"] })];

    const receipt = await runEffect(messaging().send(buildAwaitedSendInput()));

    expectDenied(receipt, "ungranted");
    expect(ledger().kernel.requestRows()).toHaveLength(0);
  });

  test("an expired grant is not active — time is an input, denial is ungranted", async () => {
    grants = [buildGrant("grant:expired", { expiresAt: messagingNow - 1 })];

    expectDenied(await runEffect(messaging().send(buildSendInput())), "ungranted");
  });
});

describe("explicit target resolution (fail closed)", () => {
  test("grant evaluation precedes target resolution: an ungranted sender learns nothing from the registry", async () => {
    expectDenied(
      await runEffect(messaging().send(buildSendInput({ target: { actorId: "actor:ghost" } }))),
      "ungranted",
    );
  });

  test("granted but unregistered target actor is denied target_missing", async () => {
    grants = [buildGrant("grant:ghost", { targetActorId: "actor:ghost" })];

    const receipt = await runEffect(messaging().send(buildSendInput({ target: { actorId: "actor:ghost" } })));

    expectDenied(receipt, "target_missing");
    expect(deliveries).toHaveLength(0);
  });

  test("actor without any allocated endpoint is denied target_stale", async () => {
    grants = [buildGrant("grant:endpointless", { targetActorId: "actor:endpointless" })];
    registerAgentFixture("actor:endpointless");

    const receipt = await runEffect(messaging().send(
      buildSendInput({ target: { actorId: "actor:endpointless" } }),
    ));

    expectDenied(receipt, "target_stale");
  });

  test("pinned endpoint that no longer exists is denied target_stale", async () => {
    const receipt = await runEffect(messaging().send(
      buildSendInput({ target: { actorId: "actor:target", endpointId: "endpoint:gone" } }),
    ));

    expectDenied(receipt, "target_stale");
  });

  test("pinned endpoint re-bound to another actor is denied target_stale", async () => {
    registerAgentFixture("actor:other", [{ id: "endpoint:other", externalId: "other-1" }]);

    const receipt = await runEffect(messaging().send(
      buildSendInput({ target: { actorId: "actor:target", endpointId: "endpoint:other" } }),
    ));

    expectDenied(receipt, "target_stale");
  });

  test("multi-endpoint actor without a pin is denied target_ambiguous; a pin resolves it", async () => {
    ledger().stores.actors.registerEndpoint({
      id: "endpoint:target-b",
      actorId: "actor:target",
      channel: "qa",
      externalId: "target-2",
      createdAt: messagingNow,
      updatedAt: messagingNow,
    });

    const unpinned = await runEffect(messaging().send(buildSendInput()));
    const pinned = await runEffect(messaging().send(
      buildSendInput({ target: { actorId: "actor:target", endpointId: "endpoint:target-b" } }),
    ));

    expectDenied(unpinned, "target_ambiguous");
    expect(pinned.kind).toBe("sent");
    if (pinned.kind !== "sent") throw new Error("expected sent");
    expect(pinned.target.endpointId).toBe("endpoint:target-b");
    expect(deliveries).toHaveLength(1);
  });

  test("a surface hint narrows a multi-channel actor to that channel's endpoint (#1485)", async () => {
    ledger().stores.actors.registerEndpoint({
      id: "endpoint:target-slack",
      actorId: "actor:target",
      channel: "slack",
      externalId: "T1:U1",
      createdAt: messagingNow,
      updatedAt: messagingNow,
    });

    const onSlack = await runEffect(messaging().send(
      buildSendInput({ target: { actorId: "actor:target", surface: "slack" } }),
    ));
    const onQa = await runEffect(messaging().send(
      buildSendInput({ messageId: "message:test-qa", target: { actorId: "actor:target", surface: "qa" } }),
    ));
    const elsewhere = await runEffect(messaging().send(
      buildSendInput({ messageId: "message:test-none", target: { actorId: "actor:target", surface: "discord" } }),
    ));

    expect(onSlack.kind).toBe("sent");
    if (onSlack.kind !== "sent") throw new Error("expected sent");
    expect(onSlack.target.endpointId).toBe("endpoint:target-slack");
    expect(onQa.kind).toBe("sent");
    if (onQa.kind !== "sent") throw new Error("expected sent");
    expect(onQa.target.endpointId).toBe("endpoint:target");
    expectDenied(elsewhere, "target_stale");
    expect(deliveries.map((delivery) => delivery.target.channel)).toEqual(["slack", "qa"]);
  });

  test("a conversation rides on the delivery target under its surface pin and is stale without one (#1490)", async () => {
    ledger().stores.actors.registerEndpoint({
      id: "endpoint:target-slack",
      actorId: "actor:target",
      channel: "slack",
      externalId: "T1:U1",
      createdAt: messagingNow,
      updatedAt: messagingNow,
    });
    const conversation = { channelId: "C1", threadId: "1710.0001", replyToMessageId: "1710.0002" };

    const inThread = await runEffect(messaging().send(
      buildSendInput({ target: { actorId: "actor:target", surface: "slack", conversation } }),
    ));
    const unpinned = await runEffect(messaging().send(
      buildSendInput({ messageId: "message:test-unpinned", target: { actorId: "actor:target", conversation } }),
    ));

    expect(inThread.kind).toBe("sent");
    if (inThread.kind !== "sent") throw new Error("expected sent");
    expect(inThread.target).toEqual({
      actorId: "actor:target",
      endpointId: "endpoint:target-slack",
      channel: "slack",
      externalId: "T1:U1",
      conversation,
    });
    expectDenied(unpinned, "target_stale");
    expect(deliveries.map((delivery) => delivery.target.conversation)).toEqual([conversation]);
  });
});

describe("fire-and-forget delivery", () => {
  test("records one sent audit and creates NO Request", async () => {
    const audits: { operation: string; requestId?: string; grantId: string; traceId: string }[] =
      [];
    const observed = Promise.withResolvers<void>();
    Bus.observe((event: { readonly name: string; }, payload: string | number | bigint | boolean | symbol | object | null | undefined) => {
      if (event.name !== "messaging.sent") return;
      const data = payload as {
        operation: string;
        requestId?: string;
        grantId: string;
        traceId: string;
      };
      audits.push({
        operation: data.operation,
        grantId: data.grantId,
        traceId: data.traceId,
        ...(data.requestId === undefined ? {} : { requestId: data.requestId }),
      });
      observed.resolve();
    });

    const receipt = await runEffect(messaging().send(buildSendInput()));

    expect(receipt.kind).toBe("sent");
    if (receipt.kind !== "sent") throw new Error("expected sent");
    expect(receipt.operation).toBe("fire_and_forget");
    expect(receipt.target).toEqual({
      actorId: "actor:target",
      endpointId: "endpoint:target",
      channel: "qa",
      externalId: "target-1",
    });
    expect(ledger().kernel.requestRows()).toHaveLength(0);
    expect(deliveries).toEqual([
      {
        messageId: "message:test",
        idempotencyKey: "message:test",
        senderId: "actor:sender",
        operation: "fire_and_forget",
        payload: Outbound.payload("test message"),
        target: receipt.target,
      },
    ]);
    await bounded(observed.promise);
    expect(audits).toEqual([
      // Pin (D11): the sent audit inherits the send input's trace.
      { operation: "fire_and_forget", grantId: "grant:sender->target", traceId: "trace-messaging" },
    ]);
  });

  test("fire_and_forget carrying a requestSpec is a schema violation, not a silent Request", async () => {
    expectRequestSpecViolation(buildAwaitedSendInput({ operation: "fire_and_forget" }));
  });
});

describe("awaited delivery", () => {
  test("appends exactly one owner-correct Request with correlation, responders, policy, and deadline", async () => {
    const receipt = expectAwaited(await runEffect(messaging().send(buildAwaitedSendInput())));
    const stored = ledger().kernel.requestById("request:test-awaited");
    expect(stored).toEqual(receipt.request);
    expect(stored).toMatchObject({
      sessionId: "session:owner",
      correlation: {
        endpointId: "endpoint:target",
        replyToMessageId: "message:test-awaited",
      },
      expectedResponders: ["actor:responder-1", "actor:responder-2", "actor:responder-3"],
      resolution: "quorum",
      threshold: 2,
      state: "open",
      deadline: messagingNow + 600_000,
      createdAt: messagingNow,
    });
    expect(ledger().kernel.requestRows()).toHaveLength(1);
    expect(deliveries[0]?.requestId).toBe("request:test-awaited");
  });

  test("a second awaited send for the same message is denied request_duplicate with an audit event", async () => {
    const audits: string[] = [];
    const observed = Promise.withResolvers<void>();
    Bus.observe((event: { readonly name: string; }, payload: string | number | bigint | boolean | symbol | object | null | undefined) => {
      if (event.name !== "messaging.denied") return;
      audits.push((payload as { code: string }).code);
      observed.resolve();
    });
    await runEffect(messaging().send(buildAwaitedSendInput()));

    const secondSpec = buildAwaitedSendInput().requestSpec;
    if (secondSpec === undefined) throw new Error("awaited fixture must carry a requestSpec");
    const duplicate = await runEffect(messaging().send(
      buildAwaitedSendInput({
        requestSpec: { ...secondSpec, requestId: "request:test-awaited-2" },
      }),
    ));

    expectDenied(duplicate, "request_duplicate");
    expect(ledger().kernel.requestRows()).toHaveLength(1);
    expect(deliveries).toHaveLength(1);
    await bounded(observed.promise);
    expect(audits).toEqual(["request_duplicate"]);
  });

  test("awaited without a requestSpec is a schema violation owned by the SendInput refinement", async () => {
    expectRequestSpecViolation(buildSendInput({ operation: "awaited" }));
  });
});

describe("delivery receipt", () => {
  test("a platform message id from the owner re-keys the request correlation to it", async () => {
    const withReceipt = createExistingAgentMessaging({
    stores: ledger().stores,
    transaction: channelTransaction,
      requests: channelRequests(seededRequests()),
      deliver: () => ({ value: "accepted", externalMessageId: "platform:msg-77" }),
      grants: () => grants,
      publish: Bus.publish,
    });

    const receipt = expectAwaited(await runEffect(withReceipt.send(buildAwaitedSendInput())));
    // The send receipt carries the receipt-updated record (revision bumped
    // from 1 at create — head === revision on the owner stream, #510).
    expect(receipt.request.correlation.replyToMessageId).toBe("platform:msg-77");
    expect(
      sessionTree(receipt.request.sessionId, ledger().sessions.actions).filter(
        (action: import("@openomni/protocol").LedgerAction.Node) => action.kind === "request",
      ),
    ).toHaveLength(2);
    const stored = ledger().kernel.requestById("request:test-awaited");
    expect(stored?.correlation.replyToMessageId).toBe("platform:msg-77");
    // Correlation now answers the platform id, not the internal message id.
    expect(
      ledger().kernel.requestRows().filter(
        (row: import("@openomni/protocol").SessionTransition.Request) => row.correlation.replyToMessageId === "platform:msg-77",
      ),
    ).toHaveLength(1);
    expect(
      ledger().kernel.requestRows().filter(
        (row: import("@openomni/protocol").SessionTransition.Request) => row.correlation.replyToMessageId === "message:test-awaited",
      ),
    ).toHaveLength(0);
  });

  test("no receipt from the owner leaves the internal-id correlation unchanged", async () => {
    const receipt = expectAwaited(await runEffect(messaging().send(buildAwaitedSendInput())));
    expect(receipt.request.correlation.replyToMessageId).toBe("message:test-awaited");
    expect(receipt.request.requestId).toBe("request:test-awaited");
  });

  test("a fire-and-forget receipt records nothing — there is no request to re-key", async () => {
    const withReceipt = createExistingAgentMessaging({
    stores: ledger().stores,
    transaction: channelTransaction,
      requests: channelRequests(seededRequests()),
      deliver: () => ({ value: "accepted", externalMessageId: "platform:msg-88" }),
      grants: () => grants,
      publish: Bus.publish,
    });

    const receipt = await runEffect(withReceipt.send(buildSendInput()));

    expect(receipt.kind).toBe("sent");
    expect(ledger().kernel.requestRows()).toHaveLength(0);
  });
});

describe("durable send admission faults", () => {
  test.each([
    ["unexpected type", "other.fact", {}],
    ["corrupt payload", "gateway.send.admitted", { signature: 7 }],
  ] as const)("fails closed on an %s", async (_name: "unexpected type" | "corrupt payload", type: "other.fact" | "gateway.send.admitted", data: PlainObject | { readonly signature: 7 }) => {
    const input = buildSendInput({ messageId: `message:bad-${_name}` });
    const facts = ledger().sessions.decisionFacts;
    if (facts === undefined) throw new Error("decision fact sub-adapter missing");
    const recorded = facts.record({
      key: `gateway_send:${encodeURIComponent(input.messageId)}`,
      type,
      data,
      timeCreated: input.at,
    });
    expect(recorded.kind).toBe("recorded");

    expect(await effectFailure(messaging().send(input))).toMatchObject({ _tag: "ChannelsFailure", operation: "message.transaction" });
    expect(deliveries).toEqual([]);
  });

  test("fails closed when a budget callback replaces the active adapter before admission", async () => {
    const input = buildSendInput({ messageId: "message:reentrant-adapter-swap" });
    const detachedFacts = ledger().sessions.decisionFacts;
    const reentrant = createExistingAgentMessaging({
      ...messagingPorts(),
      budgets: () => {
        ledger().setDecisionFacts(undefined);
        return [
          {
            id: "budget:reentrant-adapter-swap",
            targetActorId: "actor:target",
            maxPerWindow: 10,
            windowMs: 60_000,
            cooldownMs: 0,
          },
        ];
      },
    });

    try {
      expect(await effectFailure(reentrant.send(input))).toMatchObject({ _tag: "ChannelsFailure", operation: "message.transaction" });
      expect(
        detachedFacts.head(`gateway_send:${encodeURIComponent(input.messageId)}`),
      ).toBeUndefined();
      expect(deliveries).toEqual([]);
    } finally {
      ledger().setDecisionFacts(detachedFacts);
    }
  });

  test("fails closed when decision facts disappear before admission lookup", async () => {
    const detachedFacts = ledger().sessions.decisionFacts;
    const withoutFacts = createExistingAgentMessaging({
      ...messagingPorts(),
      grants: () => {
        ledger().setDecisionFacts(undefined);
        return grants;
      },
    });

    try {
      expect(await effectFailure(withoutFacts.send(buildSendInput()))).toMatchObject({ _tag: "ChannelsFailure", operation: "message.transaction" });
      expect(deliveries).toEqual([]);
    } finally {
      ledger().setDecisionFacts(detachedFacts);
    }
  });

  test("fails closed when a concurrent record returns a corrupt winner", async () => {
    overrideAdmissionRecord((facts, fact) => {
      facts.record({ ...fact, data: { signature: 7 } });
      return facts.record(fact);
    });

    expect(await effectFailure(messaging().send(buildSendInput()))).toMatchObject({ _tag: "ChannelsFailure", operation: "message.transaction" });
    expect(deliveries).toEqual([]);
  });

  test("an incompatible concurrent admission still rejects an awaited send", async () => {
    overrideAdmissionRecord((facts, fact) => {
      const data = z.record(z.string(), z.json()).parse(fact.data);
      expect(facts.record({ ...fact, data: { ...data, signature: "conflicting" } }).kind).toBe(
        "recorded",
      );
      return facts.record(fact);
    });
    expect(await effectFailure(messaging().send(buildAwaitedSendInput()))).toMatchObject({ _tag: "ChannelsFailure", operation: "message.transaction" });
    expect(deliveries).toEqual([]);
  });

  test("uses the matching admission that won a concurrent record race", async () => {
    overrideAdmissionRecord((facts, fact) => {
      const result = facts.record(fact);
      expect(result.kind).toBe("recorded");
      return facts.record(fact);
    });

    const receipt = await runEffect(messaging().send(buildSendInput()));

    expect(receipt.kind).toBe("sent");
    expect(deliveries).toHaveLength(1);
  });

  test("propagates an unexpected request-store failure before delivery", async () => {
    const service = createExistingAgentMessaging({
    stores: ledger().stores,
    transaction: channelTransaction,
      requests: {
        ...channelRequests(seededRequests()),
        open: () => {
          throw new Error("request commit unavailable");
        },
      },
      deliver: (message: OutboundMessage) => {
        deliveries.push(message);
        return { value: "accepted" };
      },
      grants: () => grants,
      publish: Bus.publish,
    });
    expect(await effectFailure(service.send(buildAwaitedSendInput()))).toMatchObject({ _tag: "ChannelsFailure", operation: "message.transaction" });
    expect(deliveries).toEqual([]);
  });

  test("reusing a fire-and-forget message id with different bytes throws before delivery", async () => {
    const first = buildSendInput({ messageId: "message:immutable" });
    expect((await runEffect(messaging().send(first))).kind).toBe("sent");

    expect(await effectFailure(messaging().send({ ...first, payload: Outbound.payload("mutated body") }))).toMatchObject({ _tag: "ChannelsFailure", operation: "message.transaction" });
    expect(deliveries).toHaveLength(1);
  });

  test("a Request id owned by another message is denied before a second delivery", async () => {
    const first = buildAwaitedSendInput({ messageId: "message:first-owner" });
    const spec = first.requestSpec;
    if (spec === undefined) throw new Error("awaited fixture requires requestSpec");
    const second = buildAwaitedSendInput({
      messageId: "message:second-owner",
      requestSpec: { ...spec, correlation: { tokenHash: "second" } },
    });

    expect((await runEffect(messaging().send(first))).kind).toBe("sent");
    expect(await effectFailure(messaging().send(second))).toMatchObject({ _tag: "ChannelsFailure", operation: "message.transaction" });
    expect(deliveries).toHaveLength(1);
    expect(ledger().kernel.requestById(spec.requestId)?.correlation.replyToMessageId).toBe(
      "message:first-owner",
    );
  });
});

const activeBudget: Gateway.SocialBudget = {
  id: "budget:reconciliation",
  targetActorId: "actor:target",
  maxPerWindow: 10,
  windowMs: 60_000,
  cooldownMs: 0,
};

type FaultPoint = "after_debit" | "after_wait" | "after_effect" | "after_receipt_cas";

type Probe = Readonly<{
  receipts: readonly Gateway.SendReceipt[];
  effects: number;
  attempts: number;
  debits: number;
  request: SessionTransition.Request | undefined;
}>;

async function probe(point: FaultPoint): Promise<Probe> {
  const external = new Map<string, KernelDeliveryReceipt>();
  let attempts = 0;
  let failBeforeEffect = point === "after_debit" || point === "after_wait";
  let failAfterEffect = point === "after_effect";
  let failAfterReceipt = point === "after_receipt_cas";

  const messaging = createExistingAgentMessaging({
    stores: ledger().stores,
    transaction: channelTransaction,
    requests: channelRequests(seededRequests()),
    deliver: (message: OutboundMessage) => {
      attempts += 1;
      if (failBeforeEffect) {
        failBeforeEffect = false;
        throw new Error(`fault:${point}`);
      }
      const recorded = external.get(message.messageId);
      if (recorded !== undefined) return recorded;
      const receipt = {
        value: "accepted" as const,
        externalMessageId: `platform:${message.messageId}`,
      };
      external.set(message.messageId, receipt);
      if (failAfterEffect) {
        failAfterEffect = false;
        throw new Error(`fault:${point}`);
      }
      return receipt;
    },
    grants: () => [buildGrant("grant:reconciliation")],
    budgets: () => [activeBudget],
    publish: <T>(event: import("@openomni/protocol").BusEvent.Descriptor<T>) => {
      if (event.name === "messaging.sent" && failAfterReceipt) {
        failAfterReceipt = false;
        throw new Error(`fault:${point}`);
      }
    },
  });

  const input =
    point === "after_debit"
      ? buildSendInput({ messageId: `message:${point}` })
      : buildAwaitedSendInput({
          messageId: `message:${point}`,
          requestSpec: (() => {
            const spec = buildAwaitedSendInput().requestSpec;
            if (spec === undefined) throw new Error("awaited fixture requires requestSpec");
            return { ...spec, requestId: `request:${point}` };
          })(),
        });

  expect(await effectFailure(messaging.send(input))).toMatchObject(point === "after_receipt_cas" ? { name: "Error" } : { _tag: "ChannelsFailure", operation: "message.deliver" });
  const resumed = await runEffect(messaging.send(input));

  return {
    receipts: [resumed],
    effects: external.size,
    attempts,
    debits: inspectDebitCount(),
    request:
      input.requestSpec === undefined
        ? undefined
        : ledger().kernel.requestById(input.requestSpec.requestId),
  };
}

describe("gateway send crash reconciliation transition table", () => {
  test.each([
    ["after_debit", 2],
    ["after_wait", 2],
    ["after_effect", 2],
    ["after_receipt_cas", 2],
  ] as const)("%s resumes with one debit and one external effect", async (point: "after_debit" | "after_wait" | "after_effect" | "after_receipt_cas", attempts: 2) => {
    const result = await probe(point);

    expect(result.receipts[0]?.kind).toBe("sent");
    expect(result.effects).toBe(1);
    expect(result.attempts).toBe(attempts);
    expect(result.debits).toBe(1);
    if (point !== "after_debit") {
      expect(result.request?.state).toBe("open");
      expect(result.request?.correlation.replyToMessageId).toBe(`platform:message:${point}`);
    }
  });
});
