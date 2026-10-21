import { Gateway, Outbound } from "@oni/protocol";
import { expect } from "bun:test";
import { ledger } from "./ledger";

type SendInput = Gateway.SendInput;
type SenderTargetGrant = Gateway.SenderTargetGrant;

export function expectRequestSpecViolation(input: Gateway.SendInput) {
  const result = Gateway.SendInput.safeParse(input);
  if (result.success) throw new Error("invalid request specification was accepted");
  expect(result.error.issues.map(({ code, path }) => ({ code, path }))).toEqual([
    { code: "custom", path: ["requestSpec"] },
  ]);
}

export function expectDenied(receipt: Gateway.SendReceipt, code: Gateway.MessageDenialCode) {
  if (receipt.kind !== "denied") throw new Error(`expected denied receipt, got ${receipt.kind}`);
  expect(receipt.code).toBe(code);
  return receipt;
}

export function expectAwaited(receipt: Gateway.SendReceipt) {
  if (receipt.kind !== "sent" || receipt.operation !== "awaited")
    throw new Error("expected awaited sent receipt");
  return receipt;
}

/** Shared messaging-domain fixture builders for oni tests (#215). */

export const messagingNow = 5_000_000_000_000;

export function registerAgentFixture(
  actorId: string,
  endpoints: readonly { id: string; externalId: string }[] = [],
): void {
  const actors = ledger().stores.actors;
  actors.registerIdentity({
    id: actorId,
    kind: "ai_agent",
    trustTier: "collaborator",
    createdAt: messagingNow,
    updatedAt: messagingNow,
  });
  for (const endpoint of endpoints) {
    actors.registerEndpoint({
      id: endpoint.id,
      actorId,
      channel: "qa",
      externalId: endpoint.externalId,
      createdAt: messagingNow,
      updatedAt: messagingNow,
    });
  }
}

export function buildGrant(
  id: string,
  overrides: Partial<SenderTargetGrant> = {},
): SenderTargetGrant {
  return {
    id,
    senderId: "actor:sender",
    targetActorId: "actor:target",
    operations: ["fire_and_forget", "awaited"],
    ...overrides,
  };
}

export function buildSendInput(overrides: Partial<SendInput> = {}): SendInput {
  return {
    messageId: "message:test",
    senderId: "actor:sender",
    target: { actorId: "actor:target" },
    operation: "fire_and_forget",
    payload: Outbound.payload("test message"),
    at: messagingNow,
    traceId: "trace-messaging",
    ...overrides,
  };
}

export function buildAwaitedSendInput(overrides: Partial<SendInput> = {}): SendInput {
  return buildSendInput({
    messageId: "message:test-awaited",
    operation: "awaited",
    requestSpec: {
      requestId: "request:test-awaited",
      sessionId: "session:owner",
      allowedActions: ["report_result"],
      expectedResponders: ["actor:responder-1", "actor:responder-2", "actor:responder-3"],
      resolution: "quorum",
      threshold: 2,
      deadline: messagingNow + 600_000,
    },
    ...overrides,
  });
}
