import { expect, test } from "bun:test";
import { controlledTimeouts } from "./helpers/timeouts";
import { Operational, Outbound } from "@openomni/protocol";
import { deliveryFixture, installDeliveryFetch } from "./helpers/delivery";
import type { PublishPort } from "../src/types";

type ChunkOutcome = "accepted" | "missing" | "forbidden" | "rate-limit" | "network" | "server";
const cases: {
  name: string;
  outcomes: ChunkOutcome[];
  value: "accepted" | "rejected" | "unknown";
  acceptedChunks: { index: number; externalMessageId: string }[];
  reason?: "missing_receipt" | "send_failed";
}[] = [
  {
    name: "missing-first",
    outcomes: ["missing", "accepted"],
    value: "unknown",
    acceptedChunks: [{ index: 2, externalMessageId: "chunk-2" }],
    reason: "missing_receipt",
  },
  {
    name: "missing-final",
    outcomes: ["accepted", "missing"],
    value: "unknown",
    acceptedChunks: [{ index: 1, externalMessageId: "chunk-1" }],
    reason: "missing_receipt",
  },
  {
    name: "missing-middle",
    outcomes: ["accepted", "missing", "accepted"],
    value: "unknown",
    acceptedChunks: [
      { index: 1, externalMessageId: "chunk-1" },
      { index: 3, externalMessageId: "chunk-3" },
    ],
    reason: "missing_receipt",
  },
  { name: "all-missing", outcomes: ["missing", "missing"], value: "unknown", acceptedChunks: [] },
  { name: "accepted", outcomes: ["accepted", "accepted"], value: "accepted", acceptedChunks: [] },
  {
    name: "first-forbidden",
    outcomes: ["forbidden", "accepted"],
    value: "rejected",
    acceptedChunks: [],
  },
  {
    name: "partial-forbidden",
    outcomes: ["accepted", "forbidden", "accepted"],
    value: "unknown",
    acceptedChunks: [{ index: 1, externalMessageId: "chunk-1" }],
    reason: "send_failed",
  },
  {
    name: "uncertain-forbidden",
    outcomes: ["missing", "forbidden"],
    value: "unknown",
    acceptedChunks: [],
    reason: "send_failed",
  },
  {
    name: "partial-network",
    outcomes: ["accepted", "network"],
    value: "unknown",
    acceptedChunks: [{ index: 1, externalMessageId: "chunk-1" }],
    reason: "send_failed",
  },
  {
    name: "partial-server",
    outcomes: ["accepted", "server"],
    value: "unknown",
    acceptedChunks: [{ index: 1, externalMessageId: "chunk-1" }],
    reason: "send_failed",
  },
  {
    name: "rate-limit-exhausted",
    outcomes: ["rate-limit", "accepted"],
    value: "rejected",
    acceptedChunks: [],
  },
  {
    name: "partial-rate-limit",
    outcomes: ["accepted", "rate-limit"],
    value: "unknown",
    acceptedChunks: [{ index: 1, externalMessageId: "chunk-1" }],
    reason: "send_failed",
  },
  {
    name: "network-not-refusal",
    outcomes: ["network", "accepted"],
    value: "unknown",
    acceptedChunks: [],
  },
];

for (const provider of ["discord", "slack", "telegram"] as const) {
  for (const scenario of cases) {
    test(`${provider} logical delivery preserves ${scenario.name} chunk evidence`, async () => {
      let sends = 0;
      let attemptedChunks = 0;
      const rateLimited = scenario.outcomes.includes("rate-limit");
      const timer = rateLimited ? controlledTimeouts() : undefined;
      const partial: object[] = [];
      const traceIds: string[] = [];
      const publish: PublishPort = (event, data) => {
        if (event.name !== Operational.Events.Warn.name) return;
        const warning = Operational.Events.Warn.schema.parse(data);
        traceIds.push(warning.traceId);
        if (warning.context?.delivery === "partial") partial.push(warning.context);
      };
      const restoreFetch = installDeliveryFetch(() => {
        sends += 1;
        const outcome = scenario.outcomes[attemptedChunks];
        if (outcome === "rate-limit") {
          return Response.json({ retry_after: 5, parameters: { retry_after: 5 } }, { status: 429 });
        }
        attemptedChunks += 1;
        // A network error with rate-limit-looking prose is still ambiguous.
        if (outcome === "network") throw new TypeError("rate limited after 3 retries (429)");
        if (outcome === "forbidden" || outcome === "server")
          return Response.json({ ok: false }, { status: outcome === "forbidden" ? 403 : 503 });
        if (outcome === "missing") return Response.json({ ok: true, result: {} });
        if (outcome !== "accepted") throw new Error("unexpected extra physical send");
        return Response.json({
          id: `chunk-${attemptedChunks}`,
          ts: `chunk-${attemptedChunks}`,
          ok: true,
          result: { message_id: `chunk-${attemptedChunks}` },
        });
      });
      const { adapter, address, limit } = deliveryFixture(provider, publish);
      try {
        const content = "X".repeat(limit * (scenario.outcomes.length - 1) + 1);
        // Subscription precedes delivery; the test bound covers a missing retry signal.
        const delivery = adapter.deliver(address, Outbound.payload(content), "stable-key");
        if (timer !== undefined) {
          for (let retry = 0; retry < 3; retry++) await timer.fireNext();
          expect(timer.delays).toEqual([5000, 5000, 5000]);
        }
        const receipt = await delivery;
        const failureIndex = scenario.outcomes.findIndex(
          (outcome) => outcome !== "accepted" && outcome !== "missing",
        );
        const expectedChunks = failureIndex === -1 ? scenario.outcomes.length : failureIndex + 1;
        const expectedSends = expectedChunks + (rateLimited ? 3 : 0);
        expect(sends).toBe(expectedSends);
        expect(receipt).toEqual(
          scenario.value === "accepted"
            ? { value: "sent", externalMessageId: "chunk-2" }
            : { value: scenario.value === "rejected" ? "not_sent" : scenario.value },
        );
        expect(partial).toEqual(
          scenario.reason === undefined
            ? []
            : [
                {
                  delivery: "partial",
                  idempotencyKey: "stable-key",
                  acceptedChunks: scenario.acceptedChunks,
                  attemptedChunks: expectedChunks,
                  totalChunks: scenario.outcomes.length,
                  reason: scenario.reason,
                },
              ],
        );
        if (traceIds.length > 0) {
          expect(new Set(traceIds).size).toBe(1);
          expect(traceIds[0]).not.toBe("");
        }
        // A cached uncertain receipt cannot retry or invent a correlation anchor.
        if (receipt.value !== "not_sent") {
          expect(await adapter.deliver(address, Outbound.payload(content), "stable-key")).toEqual(receipt);
          expect(sends).toBe(expectedSends);
        }
        expect(partial).toHaveLength(scenario.reason === undefined ? 0 : 1);
      } finally {
        timer?.restore();
        restoreFetch();
      }
    }, 15000);
  }
}
