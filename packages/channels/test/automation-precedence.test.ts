import { beforeEach, expect, test } from "bun:test";
import { Effect } from "effect";
import { Channel, Ingress } from "@oni/protocol";
import { ledger } from "./helpers/ledger.js";
import { runEffect } from "./helpers/effect.js";
import { commits, makeRouter, ownerFacts, ownerPrompt, ownerSender, registerOwnerDm, resetRouterState } from "./router/_router-fixture.js";

beforeEach(resetRouterState);

function trigger(runWhen?: string) {
  ledger().stores.automations.add(Ingress.Automation.parse({
    id: "notify", name: "Notify", enabled: true, createdBy: "owner",
    triggers: [{ type: "message", surface: ownerFacts.surface, event: "message" }],
    target: "session:worker", kind: "action",
    ...(runWhen === undefined ? {} : { runWhen }),
  }));
}

test("direct conversation wins over a matching trigger with one prompt and superseded ledger row", async () => {
  registerOwnerDm();
  trigger();
  const result = await runEffect(makeRouter().ingest(ownerSender, ownerFacts));
  expect(result.status).toBe("executed");
  expect(commits).toHaveLength(1);
  expect(commits[0]?.kind).toBe("prompt");
  expect(ledger().stores.automations.decisions("discord:owner-workspace:owner-dm:inbound-owner-dm"))
    .toContainEqual(expect.objectContaining({ decision: "superseded", by: "automation/notify" }));
});

test("unknown judge verdict filters the automation but preserves the ordinary prompt", async () => {
  registerOwnerDm();
  trigger("Is this urgent?");
  const judged = { ...ownerFacts, dm: false, eventId: "judge-one" };
  const result = await runEffect(makeRouter({ judge: () => Effect.succeed("unknown") }).ingest(ownerSender, judged));
  expect(result.status).toBe("executed");
  expect(ledger().stores.automations.decisions("discord:owner-workspace:owner-dm:judge-one"))
    .toEqual([expect.objectContaining({ decision: "filtered",
      runWhen: { verdict: "unknown", reason: "judge_unknown" } })]);
  expect(commits).toEqual([expect.objectContaining({ kind: "prompt", content: [{ kind: "text", text: ownerPrompt(judged) }] })]);
  expect(commits[0]?.sessionId).not.toBe("worker");
});

test.each(["none", "filtered", "limited"] as const)(
  "ordinary routing survives a %s automation outcome", async (outcome) => {
    registerOwnerDm();
    const facts = { ...ownerFacts, dm: false };
    ledger().stores.surfaceKeys.claim(Channel.SurfaceKey.fromChannel({
      surface: facts.surface, namespace: facts.workspaceId ?? facts.surface,
      kind: "channel", id: facts.channelId,
    }), "ordinary");
    if (outcome !== "none") ledger().stores.automations.add(Ingress.Automation.parse({
      id: "trigger", name: "Trigger", enabled: true, createdBy: "owner",
      triggers: [{ type: "message", surface: facts.surface, event: "message" }],
      target: "session:worker",
      ...(outcome === "filtered"
        ? { conditions: { contains: ["missing"] } } : { limits: { maxRunsPerDay: 1 } }),
    }));
    if (outcome === "limited") ledger().stores.automations.record(Ingress.Events.RoutingDecision.schema.parse({
      traceId: "seed", time: 0, inboundId: "seed", surface: facts.surface, mode: "direct",
      stage: "automation", outcome: "record", decision: "matched", by: "automation/trigger",
      reason: "matched", factsUsed: [], factsDigest: "seed",
    }));
    const result = await runEffect(makeRouter().ingest(ownerSender, facts));
    expect(result).toMatchObject({ status: "executed", handle: { target: "ordinary" } });
    expect(commits).toEqual([expect.objectContaining({
      sessionId: "ordinary", kind: "prompt", content: [{ kind: "text", text: ownerPrompt(facts) }],
    })]);
    const rows = ledger().stores.automations.decisions("discord:owner-workspace:owner-dm:inbound-owner-dm");
    expect(rows).toHaveLength(1);
    if (outcome !== "none") expect(rows[0]).toMatchObject({
      by: "automation/trigger",
      decision: outcome === "filtered" ? "filtered" : "refused",
      reason: outcome === "filtered" ? "contains" : "limit",
    });
  },
);
