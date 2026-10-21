import { messageFixture } from "./message-fixture";

export function actorPolicy(targetActorId: string, maxPerWindow: number) {
  return {
    grants: () => [
      {
        id: "grant",
        senderId: "sender",
        targetActorId,
        operations: ["awaited" as const],
      },
    ],
    budgets: () => [
      {
        id: "budget",
        targetActorId,
        maxPerWindow,
        windowMs: 1000,
        cooldownMs: 0,
      },
    ],
  };
}

export function ungrantedActor(role: "resident" | "child") {
  let calls = 0;
  const fixture = messageFixture(role, {
    deliveryRoutes: new Map([
      [
        "ws",
        async () => {
          calls += 1;
          return { value: "accepted" as const };
        },
      ],
    ]),
    grants: () => [],
  });
  return { fixture, calls: () => calls };
}

export function actorMessage(actorId: string) {
  return { to: { kind: "actor" as const, actorId }, type: "message" as const, content: "hello" };
}
