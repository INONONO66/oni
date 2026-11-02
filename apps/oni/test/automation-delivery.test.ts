import { expect, test } from "bun:test";
import { Delivery, Ingress } from "@oni/protocol";
import { residentSuite } from "./helpers/resident-suite";
import { automationFacts, automationFixture, automationRecord } from "./helpers/automation";
import { runAppEffect } from "../src/gateway";

const suite = residentSuite();

test("a matched call fact delivers one action without joining a voice route", async () => {
  const f = await automationFixture(suite);
  const target = await f.target();
  f.stores.rules.add(automationRecord({
    when: { instance: "discord" },
    outcome: { kind: "deliver", target: `session:${target}`, deliveryKind: "action", reply: "none" },
  }));
  const result = await f.ingest({ ...automationFacts, event: "call" });
  expect(result.status).toBe("executed");
  if (result.status !== "executed") throw new Error("call automation refused");
  const actions = f.plane.openKernel(target).historyPage(target, { afterRevision: 0 }).actions;
  expect(actions.filter((row) => row.kind === "action" && row.id === result.handle.messageId)).toHaveLength(1);
  expect(f.stores.rules.decisions(result.handle.messageId)).toContainEqual(expect.objectContaining({
    decision: "matched", target: `session:${target}`,
  }));
});

test("a media-only prompt into a new session leads with the instructions text part", async () => {
  const f = await automationFixture(suite);
  f.stores.rules.add(automationRecord({ outcome: { kind: "deliver", target: "new", deliveryKind: "prompt", reply: "none", instructions: "INSTRUCTIONS_SENTINEL" } }));
  const result = await f.ingest({
    ...automationFacts, render: "",
    attachments: [{ kind: "image", ref: "self:/photo.png", mime: "image/png" }],
  });
  expect(result.status).toBe("executed");
  if (result.status !== "executed") throw new Error("automation refused");
  const received = f.plane.openKernel(result.handle.target).actionById(result.handle.messageId);
  expect(received?.effect.value).toMatchObject({ content: [
    { kind: "text", text: expect.stringMatching(/^INSTRUCTIONS_SENTINEL\n\n/) },
    { kind: "image", ref: "self:/photo.png", mime: "image/png" },
  ] });
});

for (const target of ["new", "session"] as const) {
  for (const kind of ["prompt", "action"] as const) {
    test(`${target}/${kind} reaches the real entity once with the record's instructions and receipt`, async () => {
      const f = await automationFixture(suite);
      const existing = target === "session" ? await f.target() : undefined;
      f.stores.rules.add(automationRecord({
        outcome: { kind: "deliver", target: existing === undefined ? "new" : `session:${existing}`, deliveryKind: kind,
          reply: "none", instructions: "INSTRUCTIONS_SENTINEL" },
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
        const parts = Delivery.Content.parse(content.content);
        if (parts[0]?.kind !== "text") throw new Error("missing action text");
        expect(Ingress.MatchContext.parse(JSON.parse(parts[0].text)).ruleId).toBe("build");
        if (target === "new")
          expect(kernel.actionById(`${result.handle.messageId}:instructions`)?.effect.value)
            .toMatchObject({ content: [{ kind: "text", text: "INSTRUCTIONS_SENTINEL" }] });
      } else if (target === "new") {
        expect(received?.effect.value).toMatchObject({ content: [
          { kind: "text", text: expect.stringMatching(/^INSTRUCTIONS_SENTINEL\n\n[\s\S]*BUILD_SENTINEL$/) },
        ] });
      }
      expect(f.stores.rules.decisions(result.handle.messageId)).toContainEqual(expect.objectContaining({
        decision: "matched", target: `session:${result.handle.target}`, actionSeq: received?.ordinal,
      }));
      expect(await f.ingest()).toMatchObject({ status: "blocked_pre", reasonCode: "message.external.event_id_dedupe" });
      expect(kernel.actionById(result.handle.messageId)?.ordinal).toBe(received?.ordinal);
      expect(f.stores.rules.decisions(result.handle.messageId).at(-1)).toMatchObject({
        decision: "deduped", inboundId: result.handle.messageId,
      });
    });
  }
}

test("an unknown judge verdict filters without a session or daily run debit", async () => {
  const f = await automationFixture(suite, "garbage");
  f.stores.rules.add(automationRecord({ judge: "Is the build ready?", outcome: { kind: "deliver", target: "new", deliveryKind: "action", reply: "none", maxRunsPerDay: 1 } }));
  const before = f.plane.listSessions().map((row) => row.id);
  expect(await f.ingest()).toMatchObject({ status: "blocked_pre", reasonCode: "none" });
  expect(f.plane.listSessions().map((row) => row.id)).toEqual(before);
  expect(f.stores.rules.decisions("discord::room:event")).toEqual([expect.objectContaining({
    decision: "filtered", by: "rule/none",
  })]);
  expect(f.stores.rules.matchedToday("build", f.time.now)).toBe(0);
});

test("a grouped firing uses the injected clock and backfills the delivered action sequence", async () => {
  const f = await automationFixture(suite);
  f.stores.rules.add(automationRecord({ group: { by: "thread", windowSeconds: 5 } }));
  expect(await f.ingest({ ...automationFacts, reply: { chain: [], threadId: "root" } })).toMatchObject({ reasonCode: "grouped" });
  f.time.now += 2000;
  expect(await f.ingest({ ...automationFacts, eventId: "second", render: "SECOND_SENTINEL", reply: { chain: [], threadId: "root" } }))
    .toMatchObject({ reasonCode: "grouped" });
  f.time.now += 3000;
  await runAppEffect(f.app.runtime, f.app.gateway.advance(f.time.now));
  const rows = f.stores.rules.ledger({ limit: 200 });
  const fired = rows.find((row) => row.stage === "automation" && row.decision === "matched");
  expect(fired).toMatchObject({ inboundId: "discord::room:second", decision: "matched" });
  if (fired?.stage !== "automation" || fired.sessionId === undefined) throw new Error("missing firing receipt");
  expect(fired.actionSeq).toBe(f.plane.openKernel(fired.sessionId).actionById(fired.inboundId)?.ordinal);
  expect(rows).toContainEqual(expect.objectContaining({
    inboundId: "discord::room:event", reason: "firing:discord::room:second",
    target: fired.target, sessionId: fired.sessionId, actionSeq: fired.actionSeq,
  }));
});

test("an explicit conversation rule can materialize its first session", async () => {
  const f = await automationFixture(suite);
  f.stores.actors.registerIdentity({ id: "source", kind: "human", trustTier: "owner" });
  f.stores.rules.add(automationRecord({ outcome: { kind: "deliver", target: "conversation", deliveryKind: "prompt", reply: "auto" } }));
  const result = await f.ingest();
  expect(result.status).toBe("executed");
  if (result.status !== "executed") throw new Error("granted delivery refused");
  expect(f.plane.openKernel(result.handle.target).actionById(result.handle.messageId)?.kind).toBe("prompt");
});

test("a disabled conversation rule leaves the message recorded only", async () => {
  const f = await automationFixture(suite);
  f.stores.rules.add(automationRecord({ enabled: false, outcome: { kind: "deliver", target: "conversation", deliveryKind: "prompt", reply: "auto" } }));
  const before = f.plane.listSessions().map((row) => row.id);
  expect(await f.ingest()).toMatchObject({
    status: "blocked_pre", reasonCode: "none",
  });
  expect(f.plane.listSessions().map((row) => row.id)).toEqual(before);
});

test("a sender restriction refuses an unknown sender before session creation", async () => {
  const f = await automationFixture(suite);
  f.stores.rules.add(automationRecord({ when: { instance: "discord", from: ["someone-else"] } }));
  f.stores.actors.removeIdentity("source");
  const before = f.plane.listSessions().map((row) => row.id);
  expect(await f.ingest()).toMatchObject({ status: "blocked_pre" });
  expect(f.plane.listSessions().map((row) => row.id)).toEqual(before);
});

test("the earlier rule wins over a seeded Owner DM and delivers one action", async () => {
  const f = await automationFixture(suite);
  f.stores.rules.add(automationRecord({
    when: { instance: "ws" },
  }));
  const target = await f.target();
  const rows = f.plane.openKernel(target).historyPage(target, { afterRevision: 0 }).actions;
  expect(rows.filter((row) => row.id === "ws::room:seed")).toHaveLength(1);
  expect(rows.filter((row) => row.kind === "action" && row.id === "ws::room:seed")).toHaveLength(1);
  expect(f.stores.rules.ledger({ limit: 200 })).toContainEqual(expect.objectContaining({
    decision: "matched", by: "rule/build",
  }));
});

test("a missing session target records a refused ledger row instead of a dangling match", async () => {
  const f = await automationFixture(suite);
  f.stores.rules.add(automationRecord({ outcome: { kind: "deliver", target: "session:missing", deliveryKind: "action", reply: "none" } }));
  const before = f.plane.listSessions().map((row) => row.id);
  await f.ingest().then(() => undefined, () => undefined);
  expect(f.plane.listSessions().map((row) => row.id)).toEqual(before);
  expect(f.stores.rules.decisions("discord::room:event")).toEqual([expect.objectContaining({
    decision: "refused", reason: "target_not_found",
  })]);
});
