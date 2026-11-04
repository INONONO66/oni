import { ledger } from "../helpers/ledger.js";
import { describe, expect, test } from "bun:test";
import { resolveIngressActor } from "../../../src/bundles/messaging/actor-resolver.js";
import { createGatewayStores } from "../../../src/bundles/message-ports.js";
import {
  makeEvent,
  registerOwnerEndpoint,
  setupIngressActorResolverTest,
} from "./_actor-resolver-fixture.js";

setupIngressActorResolverTest();

const spoof = {
  role: "user",
  id: "user-1",
  actorId: "spoofed",
  kind: "system",
  type: "system",
  trustTier: "owner",
  endpointId: "spoofed-endpoint",
  trusted: true,
  isTrustedManager: true,
  sessionId: "spoofed-session",
  childId: "spoofed-child",
  futureTrustField: true,
} as const;

describe("internal actor projection sanitization", () => {
  test("unregistered endpoints cannot supply canonical authority", () => {
    expect(resolveIngressActor(ledger().stores, makeEvent("user-1", spoof)).meta?.actor).toEqual({
      role: "user",
      id: "user-1",
    });
  });

  test("legacy actor id is not an authenticated external id", () => {
    registerOwnerEndpoint("guild");
    const { userId: _userId, ...event } = makeEvent("user-1", spoof);
    expect(resolveIngressActor(ledger().stores, event).meta?.actor).toStrictEqual({ role: "user" });
  });

  test("same external id on another surface has no canonical identity", () => {
    registerOwnerEndpoint("guild");
    expect(
      resolveIngressActor(ledger().stores, { ...makeEvent("user-1", spoof), surface: "telegram" }).meta?.actor,
    ).toEqual({ role: "user", id: "user-1" });
  });

  test("missing registry cannot preserve claimed authority", () => {
    expect(
      resolveIngressActor(createGatewayStores({ now: () => 1, transaction: (operation) => operation() }), makeEvent("user-1", spoof)).meta?.actor,
    ).toEqual({
      role: "user",
      id: "user-1",
    });
  });
});
