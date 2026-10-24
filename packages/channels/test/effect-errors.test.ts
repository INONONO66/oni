import { expect, test } from "bun:test";
import { Effect } from "effect";
import * as Errors from "../src/errors";
import type { ChannelError } from "../src/errors";

const failures = {
  AttachmentRefused: new Errors.AttachmentRefused({ reason: "too_large", maxBytes: 2 }),
  AutomationEnableRefused: new Errors.AutomationEnableRefused({
    id: "fixture",
    reason: "approval_required",
  }),
  AutomationConfigurationError: new Errors.AutomationConfigurationError({
    reason: "store_unconfigured",
  }),
  DeliveryNotSent: new Errors.DeliveryNotSent({ operation: "fixture.preflight", cause: "refused" }),
  ChannelsFailure: Errors.decodeChannelFailure("fixture")(new Error("foreign")),
  InvalidInbound: new Errors.InvalidInbound({
    operation: "websocket.frame",
    reason: "invalid_json",
  }),
  DiscordApiError: new Errors.DiscordApiError({ message: "fixture", rejected: true }),
  DiscordHandlerMissingError: new Errors.DiscordHandlerMissingError({ message: "fixture" }),
  SlackApiError: new Errors.SlackApiError({ message: "fixture", rejected: false }),
  SlackHandlerMissingError: new Errors.SlackHandlerMissingError({ message: "fixture" }),
  SlackEndpointKeyError: new Errors.SlackEndpointKeyError({ message: "fixture" }),
  TelegramApiError: new Errors.TelegramApiError({ message: "fixture", rejected: true }),
  IngressRoutingError: new Errors.IngressRoutingError("route_blocked", "fixture", {
    traceId: "trace",
    time: 1,
    inboundId: "inbound",
    surface: "ws",
    mode: "direct",
    reason: "fixture",
    factsUsed: [],
    stage: "blacklist",
    outcome: "drop",
  }),
  SendAdmissionConflict: new Errors.SendAdmissionConflict({ message: "fixture" }),
  RateLimited: new Errors.RateLimited({
    message: "fixture",
    status: 429,
    attempts: 4,
    responseHeaders: { "retry-after": "7" },
    responseBody: "{}",
  }),
} satisfies { [Tag in ChannelError["_tag"]]: Extract<ChannelError, { _tag: Tag }> };

test("every channel error export is a unique yieldable tagged failure in the closed union", () => {
  const constructors = Object.values(Errors).filter(
    (value) => typeof value === "function" && value.prototype instanceof Error,
  );
  const instances = Object.values(failures);
  expect(new Set(instances.map((failure) => failure.constructor))).toEqual(new Set(constructors));
  expect(new Set(instances.map((failure) => failure._tag)).size).toBe(instances.length);
  for (const [tag, failure] of Object.entries(failures)) {
    expect(failure).toBeInstanceOf(Error);
    expect(tag).toBe(failure._tag);
    expect(Effect.isEffect(failure)).toBe(true);
  }
});

test.each([
  new Error("foreign"),
  { code: 503 },
  null,
  false,
  "diagnostic",
])("foreign channel diagnostics have a string cause", (foreign) => {
  const decoded = Errors.decodeChannelFailure("fixture")(foreign);
  const failure = new Errors.ChannelsFailure(decoded);
  expect(failure._tag).toBe("ChannelsFailure");
  expect(failure.operation).toBe("fixture");
  expect(typeof failure.cause).toBe("string");
});
