import { describe, expect, it } from "bun:test";
import { injectedOptions } from "./helpers/injected";
import { Operational } from "@oni/protocol";
import type { z } from "zod";
import { DiscordAdapter } from "../src/provider/discord/surface";
import { GitHubAdapter } from "../src/provider/github/surface";

const config = {};

describe("GitHubAdapter lifecycle", () => {
  it("refuses to start without a message handler", async () => {
    const adapter = new GitHubAdapter("secret", config, () => undefined, injectedOptions());
    await expect(adapter.start("trace-gh-1")).rejects.toMatchObject({
      _tag: "ChannelsFailure",
      operation: "github.start",
    });
  });

  it("starts after a handler is registered and publishes readiness", async () => {
    const events: z.infer<typeof Operational.Events.Info.schema>[] = [];
    const adapter = new GitHubAdapter(
      "secret",
      config,
      (event, data) => {
        expect(event.name).toBe(Operational.Events.Info.name);
        events.push(Operational.Events.Info.schema.parse(data));
      },
      injectedOptions(),
    );
    adapter.onMessage(async () => undefined);
    await adapter.start("trace-gh-2");
    adapter.stop("trace-gh-2");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ traceId: "trace-gh-2", component: "server" });
  });
});

describe("DiscordAdapter lifecycle", () => {
  it("stop publishes shutdown and is safe before start", () => {
    const events: z.infer<typeof Operational.Events.Info.schema>[] = [];
    const adapter = new DiscordAdapter(
      "token",
      config,
      (event, data) => {
        expect(event.name).toBe(Operational.Events.Info.name);
        events.push(Operational.Events.Info.schema.parse(data));
      },
      injectedOptions(),
    );
    adapter.stop("trace-dc-1");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ traceId: "trace-dc-1", component: "server" });
  });
});
