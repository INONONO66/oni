import { ledger } from "../helpers/ledger";
import { beforeEach } from "bun:test";
import { type Gateway, Ingress } from "@oni/protocol";
import { z } from "zod";

export const actorFixtureSchema = Ingress.ActorSchema.catchall(z.json());

import { resetStores } from "./_router-fixture";

export function setupIngressActorResolverTest(): void {
  beforeEach(() => {
    resetStores();
    for (const [surface, workspace] of [
      ["discord", "guild"],
      ["discord", "guild-b"],
      ["telegram", "guild"],
    ] as const) {
      ledger().stores.channelGrants.put({
        id: `grant-${surface}-${workspace}`,
        surface,
        workspace,
        channel: "dev",
        kind: "trusted_channel",
        defaultTier: "owner",
        createdBy: "act_owner",
      });
    }
  });
}

export function makeEvent(
  userId: string,
  actor: z.infer<typeof actorFixtureSchema> = { role: "user", id: userId },
): Gateway.DeliveredEvent {
  return {
    id: `event-${userId}`,
    traceId: "trace-test",
    surface: "discord",
    workspace: "guild",
    channel: "dev",
    userId,
    mode: "direct",
    payload: "hello",
    meta: { actor },
  };
}

export function registerOwnerEndpoint(workspace?: string): void {
  ledger().stores.actors.registerIdentity({ id: "act_owner", kind: "human", trustTier: "owner" });
  ledger().stores.actors.registerEndpoint({
    id: "ep_discord_user_1",
    actorId: "act_owner",
    channel: "discord",
    externalId: "user-1",
    workspace,
  });
}
