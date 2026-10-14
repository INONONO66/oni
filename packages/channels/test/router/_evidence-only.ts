import { expect } from "bun:test";
import { commits, ownerFacts, ownerPrompt, routingDecisions } from "./_router-fixture";

/** `from` is the registered contact, or the platform external id when the sender is unknown. */
export function expectEvidenceOnlyCommit(from = "actor-owner"): void {
  expect(routingDecisions()[0]).toMatchObject({
    outcome: "route",
    inboundTreatment: "evidence_only",
  });
  expect(commits).toHaveLength(1);
  expect(commits[0]?.content).toBe(ownerPrompt(ownerFacts, from));
  expect(commits[0]?.origin.value).toMatchObject({ inboundTreatment: "evidence_only" });
}
