import { ledger } from "../helpers/ledger";
import { describe, expect, test } from "bun:test";
import { resolveIngressActor } from "../../src/router/actor-resolver";
import {
  actorFixtureSchema,
  makeEvent,
  registerOwnerEndpoint,
  setupIngressActorResolverTest,
} from "./_actor-resolver-fixture";

setupIngressActorResolverTest();

describe("internal ingress actor projection", () => {
  test("registered endpoint replaces claimed authority with canonical actor fields", () => {
    registerOwnerEndpoint("guild");
    const actor = actorFixtureSchema.parse(
      resolveIngressActor(
        ledger().stores,
        makeEvent("user-1", {
          id: "user-1",
          role: "manager",
          type: "system",
          trusted: true,
          isTrustedManager: true,
        }),
        1,
      ).meta?.actor,
    );
    expect(actor).toMatchObject({
      role: "user",
      id: "user-1",
      actorId: "act_owner",
      kind: "human",
      trustTier: "owner",
      endpointId: "ep_discord_user_1",
    });
    for (const key of ["type", "trusted", "isTrustedManager"])
      expect(actor).not.toHaveProperty(key);
  });

  test("an endpoint in another workspace cannot resolve a guild event", () => {
    registerOwnerEndpoint("guild-a");
    const actor = actorFixtureSchema.parse(
      resolveIngressActor(
        ledger().stores,
        makeEvent("user-1", {
          id: "user-1",
          role: "user",
          actorId: "spoofed",
          trustTier: "owner",
        }),
        1,
      ).meta?.actor,
    );
    expect(actor).toEqual({ id: "user-1", role: "user" });
  });

  test("#1600: a workspace-less endpoint resolves a guild event — a Person declared without a workspace is known in every workspace of the platform", () => {
    registerOwnerEndpoint(undefined);
    const actor = actorFixtureSchema.parse(
      resolveIngressActor(
        ledger().stores,
        makeEvent("user-1", {
          id: "user-1",
          role: "user",
          actorId: "spoofed",
          trustTier: "owner",
        }),
        1,
      ).meta?.actor,
    );
    expect(actor).toMatchObject({ id: "user-1", role: "user", actorId: "act_owner", trustTier: "owner" });
  });

  test("workspace match resolves the canonical endpoint", () => {
    registerOwnerEndpoint("guild");
    expect(
      actorFixtureSchema.parse(resolveIngressActor(ledger().stores, makeEvent("user-1"), 1).meta?.actor),
    ).toMatchObject({
      actorId: "act_owner",
      endpointId: "ep_discord_user_1",
      trustTier: "owner",
    });
  });
});
