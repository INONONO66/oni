import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Ingress } from "@openomni/protocol";
import { judgeAndMatch } from "../src/automation/judge.js";
import { match } from "../src/automation/matcher.js";
import { runEffect } from "./helpers/effect.js";

const input = Ingress.Input.parse({
  eventId: "one", surface: "telegram", event: "message", channelId: "room",
  author: { externalId: "user", isBot: false }, dm: false, mentionsBot: true,
  body: "deploy now", receivedAt: 0,
});

test.each([
  { trigger: { type: "webhook", secretRef: "hook" }, event: "webhook", selector: { secretRef: "hook" } },
  { trigger: { type: "github", event: "pull_request.opened" }, event: "github", selector: { githubEvent: "pull_request.opened" } },
  { trigger: { type: "schedule", cron: "* * * * *", tz: "UTC" }, event: "schedule", selector: { channelId: "cron:* * * * *" } },
] as const)("specialized trigger matches its input and rejects the wrong selector", ({ trigger, event, selector }) => {
  const automation = Ingress.Automation.parse({ ...record, triggers: [trigger] });
  expect(match([automation], { ...input, event, ...selector }, { now: 0 }).route?.kind).toBe("action");
  expect(match([automation], { ...input, event, channelId: "other", secretRef: "other", githubEvent: "other" }, { now: 0 }).rows).toEqual([]);
});

test("disabled and on-demand records do not consume external events", () => {
  expect(match([{ ...record, enabled: false }, { ...record, triggers: [{ type: "on_demand" }] }],
    input, { now: 0 })).toEqual({ rows: [], pending: [] });
});

test("regex conditions match cached expressions and conversation precedence skips the judge", async () => {
  const regex = { ...record, conditions: { regex: ["^deploy"] }, runWhen: "Should run?" };
  let calls = 0;
  const result = await runEffect(judgeAndMatch([regex], input, {
    now: 0, conversation: "session:existing",
  }, () => { calls++; return Effect.succeed("yes"); }));
  expect(result.route?.target).toBe("session:existing");
  expect(result.rows[0]).toMatchObject({ decision: "superseded" });
  expect(calls).toBe(0);
  expect(match([{ ...regex, runWhen: undefined }], { ...input, body: "other" }, { now: 0 }).rows[0])
    .toMatchObject({ decision: "filtered", reason: "regex" });
});
const record = Ingress.Automation.parse({
  id: "deploy", name: "Deploy", enabled: true, createdBy: "owner",
  triggers: [{ type: "message", surface: "telegram", event: "message" }],
  target: "session:worker", conditions: { contains: ["deploy"], includeBots: false },
});

describe("automation matcher", () => {
  test("trigger produces one action", () => {
    const result = match([record], input, { now: 0 });
    expect(result.route?.kind).toBe("action");
    if (result.route?.kind === "action") {
      expect(result.route.handlerRef).toBe("automation/deploy");
      expect(result.route.body.event.messages).toHaveLength(1);
    }
    expect(result.rows.map((row) => row.stage === "automation" && row.decision)).toEqual(["matched"]);
  });

  test("conversation wins and records the losing trigger", () => {
    const result = match([record], input, { now: 0, conversation: "session:existing" });
    expect(result.route).toEqual({ kind: "prompt", target: "session:existing", origin: input });
    expect(result.rows.map((row) => row.stage === "automation" && row.decision)).toEqual(["superseded"]);
  });

  test("bot filter and judge uncertainty never produce a session route", () => {
    const bot = match([record], { ...input, author: { ...input.author, isBot: true } }, { now: 0 });
    expect(bot.route).toBeUndefined();
    expect(bot.rows[0]).toMatchObject({ decision: "filtered", factsUsed: ["includeBots"] });
    const uncertain = match([{ ...record, runWhen: "Is this urgent?" }], input, {
      now: 0, judge: () => ({ verdict: "unknown", reason: "insufficient evidence" }),
    });
    expect(uncertain.route).toBeUndefined();
    expect(uncertain.rows[0]).toMatchObject({ decision: "filtered", runWhen: { verdict: "unknown", reason: "insufficient evidence" } });
  });

  test("only structurally eligible records invoke the Effect judge", async () => {
    const questions: string[] = [];
    const result = await runEffect(judgeAndMatch([
      { ...record, id: "other", conditions: { contains: ["missing"] }, runWhen: "No" },
      { ...record, runWhen: "Urgent?" },
    ], input, { now: 0 }, (question) => {
      questions.push(question);
      return Effect.succeed("unknown" as const);
    }));
    expect(questions).toEqual(["Urgent?"]);
    expect(result.rows).toEqual([expect.objectContaining({ decision: "filtered", runWhen: { verdict: "unknown", reason: "judge_unknown" } })]);
  });

  test("a repeated event creates no new decision", () => {
    const result = match([record], input, { now: 0, seen: true });
    expect(result.route).toBeUndefined();
    expect(result.rows).toEqual([]);
  });

  test("the daily limit refuses the next match", () => {
    const result = match([{ ...record, limits: { maxRunsPerDay: 2 } }], input, {
      now: 0, matchedToday: () => 2,
    });
    expect(result.route).toBeUndefined();
    expect(result.rows[0]).toMatchObject({ decision: "refused", reason: "limit" });
  });
});
