import { beforeEach, expect, test } from "bun:test";
import { Effect } from "effect";
import { Ingress } from "@openomni/protocol";
import { ledger } from "./helpers/ledger.js";
import { runEffect } from "./helpers/effect.js";
import { commits, makeRouter, ownerFacts, ownerSender, registerOwnerDm, resetRouterState } from "./router/_router-fixture.js";

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

test("unknown judge verdict filters an ambient trigger and records why without session writes", async () => {
  registerOwnerDm();
  trigger("Is this urgent?");
  const result = await runEffect(makeRouter({ judge: () => Effect.succeed("unknown") }).ingest(ownerSender,
    { ...ownerFacts, dm: false, eventId: "judge-one" }));
  expect(result).toMatchObject({ status: "blocked_pre", reasonCode: "filtered" });
  expect(ledger().stores.automations.decisions("discord:owner-workspace:owner-dm:judge-one"))
    .toEqual([expect.objectContaining({ decision: "filtered",
      runWhen: { verdict: "unknown", reason: "judge_unknown" } })]);
  expect(commits).toHaveLength(0);
  expect(ledger().kernel.actionById("discord:owner-workspace:owner-dm:judge-one")).toBeUndefined();
});
