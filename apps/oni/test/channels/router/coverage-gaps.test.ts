import { expect, test } from "bun:test";
import type { SessionTransition } from "@oni/protocol";
import { ingressEvidence, responderCandidates } from "../../../src/bundles/messaging/request/matcher.js";

test("unresolved actor cannot prove a claimed endpoint", () => {
  const correlation = {
    endpointId: "endpoint-1",
    channelId: "channel-1",
  } satisfies SessionTransition.Correlation;
  const evidence = ingressEvidence({ meta: { correlation } }, correlation);

  expect(evidence.provesEndpoint("endpoint-1")).toBe(false);
  expect(
    responderCandidates(
      [{ responderId: "actor-1", targetActorId: "actor-1", endpointId: "endpoint-1" }],
      evidence,
    ),
  ).toEqual([]);
});
