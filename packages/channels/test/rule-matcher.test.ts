import { expect, test } from "bun:test";
import { Effect } from "effect";
import { Ingress } from "@oni/protocol";
import { match } from "../src/router/automation/match.js";
import { routeRule } from "../src/automation/matcher.js";
import { runEffect } from "./helpers/effect.js";

const input: Ingress.Input = {
  eventId: "one", instance: "chat", surface: "telegram", event: "message", channelId: "room", threadId: "root",
  author: { externalId: "user", isBot: false }, dm: false, mentionsBot: true, body: "deploy now", receivedAt: 0,
};
const record: Ingress.Rule = {
  id: "addressed", position: 1, enabled: true, createdBy: "owner",
  when: { instance: "chat", addressed: true, isBot: false },
  then: { target: "conversation", kind: "prompt", reply: "auto" },
};
const dm: Ingress.Rule = { ...record, id: "dm", position: 0, when: { instance: "chat", dm: true, isBot: false } };

const cases: readonly { name: string; message: Ingress.Input; rules: readonly Ingress.Rule[]; expected?: string }[] = [
  { name: "DM", message: { ...input, dm: true }, rules: [record, dm], expected: "dm" },
  { name: "mention", message: { ...input, event: "mention" }, rules: [record, dm], expected: "addressed" },
  { name: "bound thread followup", message: input, rules: [record], expected: "addressed" },
  { name: "bot author", message: { ...input, author: { ...input.author, isBot: true } }, rules: [record, dm] },
  { name: "reaction", message: { ...input, event: "reaction", mentionsBot: false }, rules: [record, dm] },
  { name: "explicit reaction", message: { ...input, event: "reaction" }, rules: [{ ...record, id: "react", when: { instance: "chat", event: "reaction" } }], expected: "react" },
  { name: "unknown sender", message: input, rules: [{ ...record, when: { instance: "chat", from: ["someone"] } }] },
  { name: "Owner mention", message: { ...input, instance: "owner" }, rules: [{ ...record, id: "owner-draft", when: { ...record.when, instance: "owner" }, then: { ...record.then, reply: "draft", as: "owner" } }], expected: "owner-draft" },
  { name: "alarm", message: { ...input, instance: "alarm", event: "schedule" }, rules: [{ ...record, id: "alarm", when: { instance: "alarm" }, then: { target: "session:main", kind: "action", reply: "none" } }], expected: "alarm" },
  { name: "webhook", message: { ...input, instance: "hook", event: "webhook" }, rules: [{ ...record, id: "hook", when: { instance: "hook" } }], expected: "hook" },
  { name: "Linear event", message: { ...input, instance: "linear", event: "linear" }, rules: [{ ...record, id: "linear", when: { instance: "linear" } }], expected: "linear" },
  { name: "position precedence", message: input, rules: [{ ...record, id: "later", position: 2 }, record], expected: "addressed" },
  { name: "empty table", message: input, rules: [] },
];

test.each(cases)("matches the first rule for $name", async ({ message, rules, expected }) => {
  const matched = await runEffect(match(rules, message));
  expect(matched?.id).toBe(expected);
  if (expected === "owner-draft") expect(matched?.then).toMatchObject({ reply: "draft", as: "owner" });
  if (expected === "alarm") expect(matched?.then).toEqual({ target: "session:main", kind: "action", reply: "none" });
});

test.each(["yes", "no", "unknown"] as const)("judge %s selects only a yes answer", async (verdict) => {
  const matched = await runEffect(match([{ ...record, judge: "Urgent?" }], input, () => Effect.succeed(verdict)));
  expect(matched?.id).toBe(verdict === "yes" ? "addressed" : undefined);
});

test("only structurally matching rows invoke the judge and matching stops immediately", async () => {
  const questions: string[] = [];
  const matched = await runEffect(match([
    { ...record, id: "disabled", position: 0, enabled: false, judge: "disabled" },
    { ...record, id: "other", position: 1, when: { instance: "other" }, judge: "other" },
    { ...record, position: 2, judge: "match" },
    { ...record, id: "later", position: 3, judge: "later" },
  ], input, (question) => { questions.push(question); return Effect.succeed("yes"); }));
  expect(matched?.id).toBe(record.id);
  expect(questions).toEqual(["match"]);
});

test("a missing judge falls through to the next eligible rule", async () => {
  const matched = await runEffect(match([{ ...record, judge: "Unavailable?" }, { ...dm, position: 2, when: { instance: "chat" } }], input));
  expect(matched?.id).toBe("dm");
});

test.each([
  { channel: "other" }, { dm: true }, { event: "reaction" }, { from: ["other"] }, { addressed: false }, { isBot: true },
] satisfies Partial<Ingress.Rule["when"]>[]) ("every supplied when field constrains matching %#", async (fields) => {
  expect(await runEffect(match([{ ...record, when: { instance: "chat", ...fields } }], input))).toBeUndefined();
});

test("no match records one decision without a delivery route", () => {
  const result = routeRule(undefined, input, { now: 0, pending: [], matchedToday: () => 0 });
  expect(result.route).toBeUndefined();
  expect(result.rows).toEqual([expect.objectContaining({ decision: "filtered", reason: "none", by: "rule/none" })]);
});

test("the selected rule's daily limit refuses without falling through", () => {
  const result = routeRule({ ...record, then: { ...record.then, maxRunsPerDay: 2 } }, input,
    { now: 0, pending: [], matchedToday: () => 2 });
  expect(result.route).toBeUndefined();
  expect(result.rows[0]).toMatchObject({ decision: "refused", reason: "limit", by: "rule/addressed" });
});
