import { runAgentSync } from "../helpers/executor";
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { Entropy } from "../../src/core/ports/ports";

describe("process entropy", () => {
  it("returns the supplied source untouched", () => {
    const source = { id: () => "fixed", random: () => 0.25 };
    const entropy = runAgentSync(Entropy.pipe(Effect.provide(Entropy.layer(source))));
    expect(entropy.id).toBe(source.id);
    expect(entropy.random).toBe(source.random);
  });
});
