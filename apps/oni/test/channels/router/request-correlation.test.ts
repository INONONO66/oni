import { expect, test } from "bun:test";
import { requestFixture } from "../helpers/request-record.js";
import { findRequestCandidates } from "../../../../../packages/channels/src/router/request/correlation.js";

test("injected action-derived requests retain terminals instead of falling into surface routing", () => {
  const record = requestFixture({ state: "expired", outcome: "outcome_unknown" });
  expect(
    findRequestCandidates([record], {
      endpointId: "endpoint",
      channelId: "dm",
      replyToMessageId: "sent",
    }),
  ).toEqual({ kind: "match", candidate: { key: "request:original-action", request: record } });
});

test("direct reply then ordered chain beats broad thread matches", () => {
  const direct = requestFixture();
  const broad = requestFixture({ requestId: "broad", correlation: { threadId: "thread" } });
  const claim = {
    endpointId: "endpoint",
    channelId: "dm",
    replyToMessageId: "other",
    chain: ["sent"],
    threadId: "thread",
  };
  expect(findRequestCandidates([broad, direct], claim)).toMatchObject({
    kind: "match",
    candidate: { request: { requestId: "original-action" } },
  });
});

test("same-tier ambiguity is sorted and deduplicated without mutation", () => {
  const a = requestFixture({ requestId: "a" });
  const z = requestFixture({ requestId: "z" });
  expect(
    findRequestCandidates([z, a, a], { replyToMessageId: "sent", channelId: "dm" }),
  ).toMatchObject({ kind: "ambiguous", candidates: [{ key: "request:a" }, { key: "request:z" }] });
  expect(a.state).toBe("open");
});

test.each([
  undefined,
  {},
])("absent correlation evidence cannot claim a request: %j", (correlation) => {
  expect(findRequestCandidates([requestFixture()], correlation)).toEqual({ kind: "none" });
});

test.each([
  "threadId",
  "tokenHash",
  "externalConversationId",
] as const)("%s correlation remains available below reply precedence", (key) => {
  const record = requestFixture({ correlation: { [key]: "bound" } });
  expect(findRequestCandidates([record], { [key]: "bound" })).toMatchObject({ kind: "match" });
});

test("scoped endpoint fallback is used only without a conversation id", () => {
  const pins = { endpointId: "endpoint", channelId: "dm" };
  const record = requestFixture({ correlation: pins });
  expect(findRequestCandidates([record], pins).kind).toBe("match");
  expect(findRequestCandidates([record], { ...pins, externalConversationId: "other" }).kind).toBe(
    "none",
  );
});

test.each([1, 2])("channel mismatch excludes a %s-responder request", (count) => {
  const record = requestFixture({ expectedResponders: ["a", "b"].slice(0, count) });
  expect(
    findRequestCandidates([record], { channelId: "other", replyToMessageId: "sent" }).kind,
  ).toBe("none");
});

test("delivery endpoint pin constrains a single responder but not other quorum responders", () => {
  const one = requestFixture({
    correlation: { endpointId: "target", channelId: "dm", tokenHash: "token" },
  });
  const many = requestFixture({
    ...one,
    expectedResponders: ["a", "b"],
    resolution: "all",
    threshold: 2,
  });
  const claim = { endpointId: "responder", channelId: "dm", tokenHash: "token" };
  expect(findRequestCandidates([one], claim).kind).toBe("none");
  expect(findRequestCandidates([many], claim).kind).toBe("match");
});

test.each([
  "open",
  "resolved",
  "expired",
  "cancelled",
  "refused",
] as const)("%s requests stay visible for kernel late and duplicate decisions", (state) => {
  const outcomes = {
    open: null,
    resolved: "answered",
    expired: "outcome_unknown",
    cancelled: "cancelled",
    refused: "denied",
  } as const;
  const record = requestFixture({ state, outcome: outcomes[state] });
  expect(findRequestCandidates([record], { channelId: "dm", replyToMessageId: "sent" }).kind).toBe(
    "match",
  );
});
