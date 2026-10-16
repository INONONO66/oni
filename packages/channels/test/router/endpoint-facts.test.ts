import { describe, expect, test } from "bun:test";
import { endpointFacts, endpointFromFacts } from "../../src/router/endpoint-facts";

/**
 * The initiator-endpoint facts on `route.decided` (#1569): their prefixes are
 * persisted vocabulary from the retired reply-grant materialization (#708)
 * and stay byte-frozen, so a recorded decision replays equal; the reader
 * tolerates everything a stored fact list can carry.
 */
describe("endpoint facts", () => {
  test("the two fact strings keep their frozen prefixes and round-trip", () => {
    const facts = endpointFacts({ channel: "slack", externalId: "T1:U1" });
    expect(facts).toEqual([
      "reply_grant.endpoint.channel:slack",
      "reply_grant.endpoint.external_id:T1%3AU1",
    ]);
    expect(endpointFromFacts(["unrelated", ...facts])).toEqual({
      channel: "slack",
      externalId: "T1:U1",
    });
  });

  test.each([
    ["no endpoint facts", ["unrelated"]],
    ["a missing half", ["reply_grant.endpoint.channel:slack"]],
    [
      "two channels",
      [
        "reply_grant.endpoint.channel:slack",
        "reply_grant.endpoint.channel:discord",
        "reply_grant.endpoint.external_id:u",
      ],
    ],
    ["an empty value", ["reply_grant.endpoint.channel:", "reply_grant.endpoint.external_id:u"]],
    [
      "a malformed escape",
      ["reply_grant.endpoint.channel:%E0%A4%A", "reply_grant.endpoint.external_id:u"],
    ],
  ])("%s reads as no endpoint", (_name, facts) => {
    expect(endpointFromFacts(facts)).toBeUndefined();
  });
});
