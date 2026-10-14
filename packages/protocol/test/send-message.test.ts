import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import { Actor, Gateway, LedgerAction, type Outbound, SessionTransition } from "../src/index.js";

function issues<T>(result: z.ZodSafeParseResult<T>) {
  expect(result.success).toBe(false);
  if (result.success) throw new Error("expected invalid input");
  return result.error.issues.map((issue) => ({
    code: issue.code,
    path: issue.path,
    ...(issue.code === "unrecognized_keys" ? { keys: issue.keys } : {}),
  }));
}

const targets = [
  { kind: "session", id: "session-1" },
  { kind: "new_session", role: "child", runner: "inline", parent: "me" },
  { kind: "actor", actorId: "actor-1" },
] as const;
const send = { to: targets[0], type: "message", content: "hello" } as const;
const handle = { messageId: "message-1", target: "session-1" };
const sender = { kind: "external", surface: "discord", externalId: "user-1" } as const;
const ingress = {
  eventId: "event-1",
  surface: "discord",
  channelId: "channel-1",
  addressees: [{ externalId: "bot-1" }],
  dm: false,
  payload: { text: "hello", attachments: [] },
  render: "hello",
};

const rowA = {
  id: "a",
  table: "A",
  sender: "external",
  effect: "allow",
  check: "identity",
} as const;
const rowB = {
  id: "child-external-deny",
  table: "B",
  sender: "session",
  senderRole: "child",
  targetKind: "actor",
  effect: "deny",
  check: { kind: "actor_send" },
} as const;

const observations = [
  { kind: "message.sent", sender, targetKind: "session", type: "message", bytes: 5 },
  { kind: "message.admitted", matchedRuleIds: ["a"] as string[], verdict: "allow", ingestMs: 0 },
  { kind: "message.rejected", matchedRuleIds: ["b"] as string[], verdict: "deny", ingestMs: 1.5 },
  { kind: "message.committed", commitMs: 2 },
  { kind: "message.drained", queueMs: 3, boundary: "before_llm" },
  { kind: "message.replied", replyTo: "original-1", roundTripMs: 4 },
  { kind: "message.timed_out", waitedMs: 5 },
] as const;

describe("sendMessage stage-1 protocol", () => {
  test("all target/type combinations round trip without executing policy", () => {
    for (const to of targets) {
      for (const type of ["message", "interrupt", "resume"] as const) {
        const input = { to, type, content: "hello", replyTo: "m-0", deadline: 2_000 };
        const parsed: Gateway.SendMessage = Gateway.SendMessage.parse(input);
        expect(parsed).toEqual(input);
      }
    }
    expect(Object.keys(Gateway.SendMessage.parse(send))).toEqual(["to", "type", "content"]);
    expect(LedgerAction.Kind.parse("message")).toBe("message");
    expect(Gateway.SendMessage.parse({ ...send, content: "", deadline: 0 }).content).toBe("");
  });

  test("content is a string or one outbound payload (#1497)", () => {
    const parts: Outbound.Payload = {
      kind: "message",
      parts: [{ kind: "code", text: "ls", lang: "sh" }],
    };
    expect(Gateway.SendMessage.parse({ ...send, content: parts }).content).toEqual(parts);
    const react: Outbound.Payload = { kind: "react", messageId: "m-9", emoji: "\u{1F44D}" };
    expect(Gateway.SendMessage.parse({ ...send, content: react }).content).toEqual(react);
  });

  test("handles contain only message identity and resolved target identity", () => {
    for (const target of ["session-1", "new-child-1", "actor-1"]) {
      const value: Gateway.SendMessageHandle = Gateway.SendMessageHandle.parse({
        ...handle,
        target,
      });
      expect(value).toEqual({ messageId: "message-1", target });
    }
    expect(issues(Gateway.SendMessageHandle.safeParse({ ...handle, requestId: "w-1" }))).toEqual([
      { code: "unrecognized_keys", path: [], keys: ["requestId"] },
    ]);
  });

  test("rejects stale verbs, target aliases, parent impersonation and malformed content", () => {
    expect(issues(Gateway.SendMessage.safeParse({ ...send, kind: "prompt" }))).toEqual([
      { code: "unrecognized_keys", path: [], keys: ["kind"] },
    ]);
    expect(issues(Gateway.SendMessage.safeParse({ ...send, type: "prompt" }))).toEqual([
      { code: "invalid_value", path: ["type"] },
    ]);
    expect(
      issues(Gateway.SendMessage.safeParse({ ...send, to: { kind: "subordinate", id: "s" } })),
    ).toEqual([{ code: "invalid_union", path: ["to", "kind"] }]);
    expect(
      issues(Gateway.SendMessage.safeParse({ ...send, to: { ...targets[1], parent: "other" } })),
    ).toEqual([{ code: "invalid_value", path: ["to", "parent"] }]);
    expect(issues(Gateway.SendMessage.safeParse({ ...send, content: {} }))).toEqual([
      { code: "invalid_union", path: ["content"] },
    ]);
    for (const deadline of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(issues(Gateway.SendMessage.safeParse({ ...send, deadline }))[0]?.path).toEqual([
        "deadline",
      ]);
    }
    expect(issues(Gateway.SendMessage.safeParse({ ...send, replyTo: "" }))).toEqual([
      { code: "too_small", path: ["replyTo"] },
    ]);
  });
});

describe("gateway ingest", () => {
  test("sender identity is separate from driver facts and policy verdicts", () => {
    const external: Gateway.IngestSender = Gateway.IngestSender.parse(sender);
    expect(external).toEqual(sender);
    expect(Gateway.IngestSender.parse({ kind: "session", id: "s-1" })).toEqual({
      kind: "session",
      id: "s-1",
    });
    expect(issues(Gateway.IngestSender.safeParse({ ...sender, tier: "owner" }))).toEqual([
      { code: "unrecognized_keys", path: [], keys: ["tier"] },
    ]);
    expect(issues(Gateway.IngestSender.safeParse({ kind: "system", id: "s-1" }))).toEqual([
      { code: "invalid_union", path: ["kind"] },
    ]);
  });

  test("preserves event identity, mentions, DM, reply chain, payload and rendering", () => {
    const value: Gateway.IngressFacts = Gateway.IngressFacts.parse(ingress);
    expect(value).toEqual(ingress);
    const dm = {
      ...ingress,
      dm: true,
      addressees: [],
      workspaceId: "workspace-1",
      reply: {
        replyToMessageId: "m-0",
        threadId: "thread-1",
        chain: ["m-0", "m-root"],
      },
    };
    expect(Gateway.IngressFacts.parse(dm)).toEqual(dm);
    expect(
      issues(
        Gateway.IngressFacts.safeParse({
          ...ingress,
          addressees: [{ externalId: "bot-1", axis: "bot" }],
        }),
      ),
    ).toEqual([{ code: "unrecognized_keys", path: ["addressees", 0], keys: ["axis"] }]);
    expect(
      issues(Gateway.IngressFacts.safeParse({ ...ingress, senderTier: "owner", admitted: true })),
    ).toEqual([{ code: "unrecognized_keys", path: [], keys: ["senderTier", "admitted"] }]);
    const { eventId: _eventId, ...missingEvent } = ingress;
    expect(issues(Gateway.IngressFacts.safeParse(missingEvent))).toEqual([
      { code: "invalid_type", path: ["eventId"] },
    ]);
  });

  test("normalized reply facts preserve shared correlation fields and precedence", () => {
    const pins = { endpointId: "endpoint-1", channelId: ingress.channelId };
    const cases: SessionTransition.Correlation[] = [
      { tokenHash: "token-1" },
      { externalConversationId: "conversation-1" },
      { tokenHash: "token-1", externalConversationId: "conversation-1" },
      {
        replyToMessageId: "message-0",
        threadId: "thread-1",
        tokenHash: "token-1",
        externalConversationId: "conversation-1",
      },
    ];
    for (const correlation of cases) {
      const shared = SessionTransition.Correlation.parse(correlation);
      const input = { ...ingress, reply: { ...shared, chain: [] } };
      const parsed = Gateway.IngressFacts.parse(input);
      expect(parsed).toEqual(input);
      expect(SessionTransition.Correlation.parse({ ...parsed.reply, ...pins })).toEqual({
        ...shared,
        chain: [],
        ...pins,
      });
    }
  });

  test("reply facts reject resolved identity and authority but retain correlation validation", () => {
    for (const key of ["endpointId", "channelId", "senderTier", "verdict"]) {
      expect(
        issues(
          Gateway.IngressFacts.safeParse({
            ...ingress,
            reply: {
              tokenHash: "token-1",
              externalConversationId: "conversation-1",
              chain: [],
              [key]: "forged",
            },
          }),
        ),
      ).toEqual([{ code: "unrecognized_keys", path: ["reply"], keys: [key] }]);
    }
    for (const key of ["tokenHash", "externalConversationId"]) {
      expect(
        issues(Gateway.IngressFacts.safeParse({ ...ingress, reply: { chain: [], [key]: "" } })),
      ).toEqual([{ code: "too_small", path: ["reply", key] }]);
    }
  });

  test("only actor executed delivery carries the three exhaustive receipt values", () => {
    for (const value of ["accepted", "rejected", "unknown"] as const) {
      const result = { status: "executed", handle, delivery: { kind: "actor", value } } as const;
      const parsed: Gateway.IngestResult = Gateway.IngestResult.parse(result);
      expect(parsed).toEqual(result);
      expect(
        issues(Gateway.IngestResult.safeParse({ ...result, delivery: { kind: "session", value } })),
      ).toEqual([{ code: "unrecognized_keys", path: ["delivery"], keys: ["value"] }]);
    }
    const committed = { status: "executed", handle, delivery: { kind: "session" } } as const;
    expect(Gateway.IngestResult.parse(committed)).toEqual(committed);
    expect(Gateway.IngestResult.parse({ status: "blocked_pre", reasonCode: "denied" })).toEqual({
      status: "blocked_pre",
      reasonCode: "denied",
    });
    expect(
      Gateway.IngestResult.parse({ status: "blocked_post", handle, reasonCode: "obligation" }),
    ).toEqual({ status: "blocked_post", handle, reasonCode: "obligation" });
    for (const value of ["delivered", "failed", "no_response"]) {
      expect(
        issues(
          Gateway.IngestResult.safeParse({ ...committed, delivery: { kind: "actor", value } }),
        ),
      ).toEqual([{ code: "invalid_value", path: ["delivery", "value"] }]);
    }
    expect(issues(Gateway.IngestResult.safeParse({ ...committed, status: "failed" }))).toEqual([
      { code: "invalid_union", path: ["status"] },
    ]);
  });
});

describe("rule table shapes", () => {
  test("every sender tier is orthogonal to every resolved addressee", () => {
    for (const senderTier of Actor.TrustTier.options) {
      for (const addressee of ["bot", "owner", "ambient"] as const) {
        const row = { ...rowA, senderTier, addressee };
        const parsed: Gateway.RuleTableA = Gateway.RuleTableA.parse(row);
        expect(parsed).toEqual(row);
      }
    }
    for (const check of [
      "identity",
      "grant_tier",
      "egress_budget",
      "event_id_dedupe",
      "reply_correlation",
    ] as const) {
      expect(Gateway.RuleTableA.parse({ ...rowA, check }).check).toBe(check);
    }
    expect(issues(Gateway.RuleTableA.safeParse({ ...rowA, sender: "session" }))).toEqual([
      { code: "invalid_value", path: ["sender"] },
    ]);
  });

  test("session rows express bounded checks and the child deny fixtures", () => {
    const actorDeny: Gateway.RuleTableB = Gateway.RuleTableB.parse(rowB);
    expect(actorDeny).toEqual(rowB);
    const interruptDeny = {
      ...rowB,
      targetKind: "session",
      targetRole: "resident",
      type: "interrupt",
      check: { kind: "type" },
    } as const;
    expect(Gateway.RuleTableB.parse(interruptDeny)).toEqual(interruptDeny);
    for (const check of [
      { kind: "parent_child" },
      { kind: "fanout", max: 4 },
      { kind: "depth", max: 2 },
      { kind: "deadline", withinParent: true },
      { kind: "type" },
      { kind: "actor_send" },
    ] as const) {
      expect(Gateway.RuleTableB.parse({ ...rowB, check }).check).toEqual(check);
    }
    expect(issues(Gateway.RuleTableB.safeParse({ ...rowB, sender: "external" }))).toEqual([
      { code: "invalid_value", path: ["sender"] },
    ]);
    expect(
      issues(Gateway.RuleTableB.safeParse({ ...rowB, check: { kind: "fanout", max: -1 } })),
    ).toEqual([{ code: "too_small", path: ["check", "max"] }]);
    expect(
      issues(
        Gateway.RuleTableB.safeParse({ ...rowB, check: { kind: "deadline", withinParent: false } }),
      ),
    ).toEqual([{ code: "invalid_value", path: ["check", "withinParent"] }]);
  });
});

describe("six message observation families", () => {
  test("each event round trips its measured fields; no later duration is invented", () => {
    for (const observation of observations) {
      const value = { messageId: "m-1", ...observation };
      const parsed: Gateway.MessageObservation = Gateway.MessageObservation.parse(value);
      expect(parsed).toEqual(value);
      expect(Object.keys(parsed).sort()).toEqual(Object.keys(value).sort());
    }
    const child = { messageId: "m-1", ...observations[5], childTurnMs: 3, tokens: 7 };
    expect(Gateway.MessageObservation.parse(child)).toEqual(child);
  });

  test("durations are required at their event and reject negative/nonfinite values", () => {
    for (const [kind, field, extra] of [
      ["message.admitted", "ingestMs", { verdict: "allow", matchedRuleIds: [] }],
      ["message.committed", "commitMs", {}],
      ["message.drained", "queueMs", { boundary: "after_tools" }],
      ["message.replied", "roundTripMs", { replyTo: "m-0" }],
      ["message.timed_out", "waitedMs", {}],
    ] as const) {
      const base = { messageId: "m-1", kind, ...extra };
      expect(issues(Gateway.MessageObservation.safeParse(base))).toEqual([
        { code: "invalid_type", path: [field] },
      ]);
      for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(
          issues(Gateway.MessageObservation.safeParse({ ...base, [field]: value }))[0]?.path,
        ).toEqual([field]);
      }
    }
  });

  test("rejects sibling durations, verdict reversal, and unknown fields", () => {
    expect(
      issues(
        Gateway.MessageObservation.safeParse({
          messageId: "m-1",
          ...observations[1],
          verdict: "deny",
        }),
      ),
    ).toEqual([{ code: "invalid_value", path: ["verdict"] }]);
    expect(
      issues(
        Gateway.MessageObservation.safeParse({ messageId: "m-1", ...observations[3], queueMs: 2 }),
      ),
    ).toEqual([{ code: "unrecognized_keys", path: [], keys: ["queueMs"] }]);
    const stamped = Gateway.MessageObservation.safeParse({
      messageId: "m-1",
      ...observations[0],
      sessionId: "stamped-session",
      traceId: "stamped-trace",
      runId: "stamped-run",
    });
    expect(stamped.success).toBe(true);
    expect(stamped.data).toMatchObject({
      sessionId: "stamped-session",
      traceId: "stamped-trace",
      runId: "stamped-run",
    });
    expect(
      issues(
        Gateway.MessageObservation.safeParse({
          messageId: "m-1",
          ...observations[0],
          unknownField: "rejected",
        }),
      ),
    ).toEqual([{ code: "unrecognized_keys", path: [], keys: ["unknownField"] }]);
  });
});

describe("Gateway.DelegationResult", () => {
  const pointer = { session: "child-1", action: "terminal-1" };

  test("parses a bounded settlement and keeps the 4 KiB preview ceiling exact", () => {
    const parsed = Gateway.DelegationResult.parse({
      status: "completed",
      preview: "x".repeat(4096),
      pointer,
    });
    expect(parsed.status).toBe("completed");
    expect(parsed.preview).toHaveLength(4096);
    expect(parsed.pointer).toEqual(pointer);
    expect(
      Gateway.DelegationResult.parse({ status: "failed", preview: "", pointer }).status,
    ).toBe("failed");
  });

  test("an oversize preview is a parse failure, never a silent truncation", () => {
    expect(
      issues(
        Gateway.DelegationResult.safeParse({
          status: "completed",
          preview: "x".repeat(4097),
          pointer,
        }),
      ),
    ).toEqual([{ code: "too_big", path: ["preview"] }]);
  });

  test("a missing pointer, a partial pointer, and an unknown status are parse failures", () => {
    expect(
      issues(Gateway.DelegationResult.safeParse({ status: "completed", preview: "ok" })),
    ).toEqual([{ code: "invalid_type", path: ["pointer"] }]);
    expect(
      issues(
        Gateway.DelegationResult.safeParse({
          status: "completed",
          preview: "ok",
          pointer: { session: "child-1" },
        }),
      ),
    ).toEqual([{ code: "invalid_type", path: ["pointer", "action"] }]);
    expect(
      issues(
        Gateway.DelegationResult.safeParse({ status: "interrupted", preview: "ok", pointer }),
      ),
    ).toEqual([{ code: "invalid_value", path: ["status"] }]);
  });
});
