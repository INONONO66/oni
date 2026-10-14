import { describe, expect, it } from "bun:test";
import { Cause } from "effect";
import { AgentFailure, Interrupted } from "../src/core/ports/failure";
import * as Failure from "../src/core/ports/failure";

describe("Failure.of", () => {
  it("returns the typed error instance a Cause carries", () => {
    const error = new Failure.BundleError({ code: "metadata", bundle: "fixture", detail: "invalid" });
    const failure = Failure.of(Cause.fail(error), "op");
    expect(failure).toBe(error);
    expect(failure.message).toBe("metadata: fixture: invalid");
  });

  it("synthesizes a AgentFailure for a defect, carrying the pretty-printed cause", () => {
    const cause = Cause.die(new Error("boom"));
    const failure = Failure.of(cause, "stage.op");
    expect(failure).toBeInstanceOf(AgentFailure);
    expect(failure).toMatchObject({ _tag: "AgentFailure", operation: "stage.op", cause: expect.stringContaining("boom") });
  });

  it("synthesizes a AgentFailure for an interrupt", () => {
    const failure = Failure.of(Cause.interrupt(), "stage.op.completion");
    expect(failure).toBeInstanceOf(AgentFailure);
    expect(failure).toMatchObject({ operation: "stage.op.completion" });
  });
});

describe("Failure.fromCause", () => {
  it("applies the synthesizer to defects and returns the typed error otherwise", () => {
    const error = new Interrupted();
    const synthesize = (pretty: string) => ({ synthesized: pretty });
    expect(Failure.fromCause(Cause.fail(error), synthesize)).toBe(error);
    expect(Failure.fromCause(Cause.die("bad"), synthesize)).toEqual({ synthesized: expect.stringContaining("bad") });
  });
});

describe("Failure.pretty", () => {
  const withoutStacks = <A>(body: () => A): A => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    try {
      return body();
    } finally {
      Error.stackTraceLimit = limit;
    }
  };

  it("renders byte-identically to Cause.pretty while stacks are captured", () => {
    // The premise is pinned, not hoped for: Bun materializes `stack` lazily and
    // under load the getter yields undefined (the defect this renderer absorbs),
    // so both errors carry an own stack string before either renderer reads it.
    const inner = new Error("inner");
    inner.stack = "Error: inner\n    at inner (test.ts:2:3)";
    const outer = new Error("outer", { cause: inner });
    outer.stack = "Error: outer\n    at outer (test.ts:1:1)";
    const cause = Cause.die(outer);
    expect(Failure.pretty(cause)).toBe(Cause.pretty(cause));
    expect(Failure.pretty(cause)).toBe(
      "Error: outer\n    at outer (test.ts:1:1) {\n  [cause]: Error: inner\n      at inner (test.ts:2:3)\n}",
    );
    // A non-Error defect makes the renderer synthesize its own Error; the head
    // line is the contract (effect's renderer is not asserted here: its
    // synthesized stack is exactly what the lazy getter can drop).
    expect(Failure.pretty(Cause.die("bad")).split("\n")[0]).toBe("Error: bad");
  });

  it("falls back to name and message when an Error carries no stack string", () => {
    expect(withoutStacks(() => Cause.pretty(Cause.die("bad")))).toBe("");
    expect(withoutStacks(() => Failure.pretty(Cause.die("bad")))).toBe("Error: bad");
    expect(withoutStacks(() => Failure.pretty(Cause.die(new Error("outer", { cause: "crash" }))))).toBe(
      "Error: outer {\n  [cause]: Error: crash\n}",
    );
    expect(withoutStacks(() => Failure.fromCause(Cause.die("bad"), (pretty) => pretty))).toBe("Error: bad");
  });
});
