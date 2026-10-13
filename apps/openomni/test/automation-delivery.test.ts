import { expect, test } from "bun:test";
import { Ingress } from "@openomni/protocol";
import { residentSuite } from "./helpers/resident-suite";
import { automationFacts, automationFixture, automationRecord } from "./helpers/automation";
import { runAppEffect } from "../src/gateway";

const suite = residentSuite();

for (const target of ["new", "session"] as const) {
  for (const kind of ["prompt", "action"] as const) {
    test(`${target}/${kind} reaches the real entity once with the record's instructions and receipt`, async () => {
      const f = await automationFixture(suite);
      const existing = target === "session" ? await f.target() : undefined;
      f.stores.automations.add(automationRecord({
        target: existing === undefined ? "new" : `session:${existing}`, kind,
        instructions: "INSTRUCTIONS_SENTINEL",
      }));
      const result = await f.ingest();
      expect(result.status).toBe("executed");
      if (result.status !== "executed") throw new Error("automation refused");
      const kernel = f.plane.openKernel(result.handle.target);
      const rows = kernel.historyPage(result.handle.target, { afterRevision: 0 }).actions;
      const received = kernel.actionById(result.handle.messageId);
      expect(received?.kind).toBe(kind);
      if (existing !== undefined) expect(result.handle.target).toBe(existing);
      else expect(rows.filter((row) => row.kind === "session.configure" && row.parentId === null)).toHaveLength(1);
      if (kind === "action") {
        const content = received?.effect.value;
        if (content === null || typeof content !== "object" || Array.isArray(content)) throw new Error("missing action content");
        expect(Ingress.TriggerContext.parse(JSON.parse(String(content.content))).automationId).toBe("build");
        if (target === "new")
          expect(kernel.actionById(`${result.handle.messageId}:instructions`)?.effect.value)
            .toMatchObject({ content: "INSTRUCTIONS_SENTINEL" });
      } else if (target === "new") {
        expect(received?.effect.value).toMatchObject({ content: "INSTRUCTIONS_SENTINEL\n\nBUILD_SENTINEL" });
      }
      expect(f.stores.automations.decisions(result.handle.messageId)).toContainEqual(expect.objectContaining({
        decision: "matched", target: `session:${result.handle.target}`, actionSeq: received?.ordinal,
      }));
      expect(await f.ingest()).toMatchObject({ status: "blocked_pre", reasonCode: "message.external.event_id_dedupe" });
      expect(kernel.actionById(result.handle.messageId)?.ordinal).toBe(received?.ordinal);
      expect(f.stores.automations.decisions(result.handle.messageId).at(-1)).toMatchObject({
        decision: "deduped", inboundId: result.handle.messageId,
      });
    });
  }
}

test("an unknown judge verdict filters without a session or daily run debit", async () => {
  const f = await automationFixture(suite, "garbage");
  f.stores.automations.add(automationRecord({ runWhen: "Is the build ready?", limits: { maxRunsPerDay: 1 } }));
  const before = f.plane.listSessions().map((row) => row.id);
  expect(await f.ingest()).toMatchObject({ status: "blocked_pre", reasonCode: "filtered" });
  expect(f.plane.listSessions().map((row) => row.id)).toEqual(before);
  expect(f.stores.automations.decisions("discord::room:event")).toEqual([expect.objectContaining({
    decision: "filtered", runWhen: { verdict: "unknown", reason: "judge_unknown" },
  })]);
  expect(f.stores.automations.matchedToday("build", f.time.now)).toBe(0);
});

test("a grouped firing uses the injected clock and backfills the delivered action sequence", async () => {
  const f = await automationFixture(suite);
  f.stores.automations.add(automationRecord({ grouping: { by: "channel", windowSeconds: 5 } }));
  expect(await f.ingest()).toMatchObject({ reasonCode: "grouped" });
  f.time.now += 2000;
  expect(await f.ingest({ ...automationFacts, eventId: "second", render: "SECOND_SENTINEL" }))
    .toMatchObject({ reasonCode: "grouped" });
  f.time.now += 3000;
  await runAppEffect(f.app.runtime, f.app.gateway.advance(f.time.now));
  const rows = f.stores.automations.ledger({ limit: 200 });
  const fired = rows.find((row) => row.stage === "automation" && row.decision === "matched");
  expect(fired).toMatchObject({ inboundId: "discord::room:second", decision: "matched" });
  if (fired?.stage !== "automation" || fired.sessionId === undefined) throw new Error("missing firing receipt");
  expect(fired.actionSeq).toBe(f.plane.openKernel(fired.sessionId).actionById(fired.inboundId)?.ordinal);
  expect(rows).toContainEqual(expect.objectContaining({
    inboundId: "discord::room:event", reason: "firing:discord::room:second",
  }));
});

test.each(["identity", "blacklist"] as const)("a matched record never bypasses the %s denial", async (denial) => {
  const f = await automationFixture(suite);
  f.stores.automations.add(automationRecord());
  if (denial === "identity") f.stores.actors.removeIdentity("source");
  else f.stores.blacklist.put({ id: "deny", kind: "actor", value: "source", createdBy: "owner" });
  const before = f.plane.listSessions().map((row) => row.id);
  expect(await f.ingest()).toMatchObject({ status: "blocked_pre" });
  expect(f.plane.listSessions().map((row) => row.id)).toEqual(before);
});

test("an Owner DM wins over an automation and delivers one prompt", async () => {
  const f = await automationFixture(suite);
  f.stores.automations.add(automationRecord({
    triggers: [{ type: "message", surface: "ws", event: "message" }],
  }));
  const target = await f.target();
  const rows = f.plane.openKernel(target).historyPage(target, { afterRevision: 0 }).actions;
  expect(rows.filter((row) => row.id === "ws::room:seed")).toHaveLength(1);
  expect(rows.filter((row) => row.kind === "action")).toEqual([]);
  expect(f.stores.automations.ledger({ limit: 200 })).toContainEqual(expect.objectContaining({
    decision: "superseded", by: "automation/build",
  }));
});
