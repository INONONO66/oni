import { describe, expect, test } from "bun:test";
import { Channel } from "../src/channel/index.js";

/** The identity axis (#1569): a mounted channel is one `(platform, identity)` instance. */
describe("Channel.Identity", () => {
  test("names the two accounts a platform instance can speak as", () => {
    expect(Channel.Identity.options).toEqual(["bot", "owner"]);
    expect(Channel.Identity.safeParse("user").success).toBe(false);
  });

  test("instanceId is the surface id the instance mounts under", () => {
    expect(Channel.instanceId("slack", "bot")).toBe("slack:bot");
    expect(Channel.instanceId("slack", "owner")).toBe("slack:owner");
  });
});
