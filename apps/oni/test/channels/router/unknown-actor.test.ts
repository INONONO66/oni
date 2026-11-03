import { expect, test } from "bun:test";
import { ledger } from "../helpers/ledger.js";
import { resolveIngressActor } from "../../../src/bundles/messaging/actor-resolver.js";
import { makeEvent, setupIngressActorResolverTest } from "./_actor-resolver-fixture.js";

setupIngressActorResolverTest();

test("an unknown sender does not acquire a durable actor from inbound policy", () => {
  const result = resolveIngressActor(ledger().stores, makeEvent("stranger"));
  expect(result.meta?.actor).toEqual({ role: "user", id: "stranger" });
  expect(ledger().stores.actors.resolveEndpoint("discord", "stranger", "guild")).toBeUndefined();
});
