import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Ingress } from "@openomni/protocol";
import { judgeAndMatch } from "../src/automation/judge.js";
import { match } from "../src/automation/matcher.js";

const input = Ingress.Input.parse({
  eventId: "one", surface: "telegram", event: "message", channelId: "room",
  author: { externalId: "user", isBot: false }, dm: false, mentionsBot: true,
  body: "deploy now", receivedAt: 0,
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
    const result = await Effect.runPromise(judgeAndMatch([
      { ...record, id: "other", conditions: { contains: ["missing"] }, runWhen: "No" },
      { ...record, runWhen: "Urgent?" },
    ], input, { now: 0 }, (question) => {
      questions.push(question);
      return Effect.succeed("unknown" as const);
    }));
    expect(questions).toEqual(["Urgent?"]);
    expect(result.rows[1]).toMatchObject({ decision: "filtered", runWhen: { verdict: "unknown", reason: "judge_unknown" } });
  });

  test("a repeated event is ledger-only", () => {
    const result = match([record], input, { now: 0, seen: true });
    expect(result.route).toBeUndefined();
    expect(result.rows[0]).toMatchObject({ decision: "deduped" });
  });

  test("the daily limit refuses the next match", () => {
    const result = match([{ ...record, limits: { maxRunsPerDay: 2 } }], input, {
      now: 0, matchedToday: () => 2,
    });
    expect(result.route).toBeUndefined();
    expect(result.rows[0]).toMatchObject({ decision: "refused", reason: "limit" });
  });
});
