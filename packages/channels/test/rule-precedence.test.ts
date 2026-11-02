import { beforeEach, expect, test } from "bun:test";
import { Effect } from "effect";
import { ledger } from "./helpers/ledger.js";
import { runEffect } from "./helpers/effect.js";
import { commits, makeRouter, ownerFacts, ownerSender, registerOwnerDm, resetRouterState } from "./router/_router-fixture.js";

beforeEach(resetRouterState);

function rule(judge?: string) {
  ledger().stores.rules.add({
    id: "notify", position: 0, enabled: true, createdBy: "owner", when: { instance: ownerFacts.surface },
    outcome: { kind: "deliver", target: "session:worker", deliveryKind: "action", reply: "none" }, judge,
  });
}

test("a rule before the conversation seed wins with one action", async () => {
  registerOwnerDm();
  rule();
  expect(await runEffect(makeRouter().ingest(ownerSender, ownerFacts))).toMatchObject({ status: "executed", handle: { target: "worker" } });
  expect(commits).toHaveLength(1);
  expect(commits[0]?.kind).toBe("action");
  expect(ledger().stores.rules.decisions("discord:owner-workspace:owner-dm:inbound-owner-dm"))
    .toEqual([expect.objectContaining({ decision: "matched", by: "rule/notify" })]);
});

test("unknown judgment falls through to an explicit matching conversation seed", async () => {
  registerOwnerDm();
  rule("Urgent?");
  expect((await runEffect(makeRouter({ judge: () => Effect.succeed("unknown") }).ingest(ownerSender, ownerFacts))).status).toBe("executed");
  expect(commits).toHaveLength(1);
  expect(commits[0]?.kind).toBe("prompt");
  expect(ledger().stores.rules.decisions("discord:owner-workspace:owner-dm:inbound-owner-dm"))
    .toEqual([expect.objectContaining({ decision: "matched", by: "rule/seed-owner-dm" })]);
});

test("unknown judgment with no other matching rule records without fallback delivery", async () => {
  registerOwnerDm();
  rule("Urgent?");
  expect(await runEffect(makeRouter({ judge: () => Effect.succeed("unknown") }).ingest(ownerSender, { ...ownerFacts, dm: false })))
    .toEqual({ status: "blocked_pre", reasonCode: "none" });
  expect(commits).toEqual([]);
});
