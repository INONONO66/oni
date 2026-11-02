import { describe, expect, test } from "bun:test";
import { Channel } from "../src/channel/index.js";
import { Ingress } from "../src/ingress/index.js";

/** The identity axis (#1569): a mounted channel is one `(platform, identity)` instance. */
describe("Channel.Identity", () => {
  test("names the two accounts a platform instance can speak as", () => {
    expect(Channel.Identity.options).toEqual(["bot", "owner"]);
    expect(Channel.Identity.safeParse("user").success).toBe(false);
  });

  test("ingress retains instance identity separately from the platform", () => {
    const facts = {
      surface: "slack", instance: "channel:slack:workspace-b",
      eventId: "event", channelId: "C1", addressees: [], dm: false, payload: {}, render: "hello",
    };
    expect(Ingress.Message.parse(facts)).toEqual(facts);
    expect(Ingress.Message.safeParse({ ...facts, instance: "" }).success).toBe(false);
  });
});
