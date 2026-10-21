import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { runSyncEffect } from "./helpers/effect";
import { AgentProcessLive } from "../src/agent-layers";
import { Core } from "@oni/agent";
const Entropy = Core.Entropy;
import { Bus } from "./helpers/bus";

describe("agent process layers", () => {
  it("AgentProcessLive threads the composition root's entropy, no ambient fallback", () => {
    let n = 0;
    const source = { id: () => { n += 1; return `root-${n}`; }, random: () => 0.5 };
    const entropy = runSyncEffect(Entropy.pipe(Effect.provide(AgentProcessLive(Bus, source))));
    expect(entropy.id()).toBe("root-1");
    expect(entropy.id()).toBe("root-2");
    expect(entropy.random()).toBe(0.5);
  });
});
