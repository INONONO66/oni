import type { EffectRunner } from "../../src/types";
import { runEffect } from "./effect";

/** Deterministic injected sources for driver tests: fixed clock, sequential UUIDs, zero jitter. */
export const FIXED_NOW = 1_700_000_000_000;

/** The package test runner as the drivers' injected run port (wall clock). */
export const testRun: EffectRunner = (effect) => runEffect(effect);

/** UUID-shaped id source: nth call yields `00000000-0000-4000-8000-…n`. */
export function sequentialIds(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  };
}

export function injectedOptions(run: EffectRunner = testRun): {
  readonly now: () => number;
  readonly id: () => string;
  readonly random: () => number;
  readonly run: EffectRunner;
} {
  return { now: () => FIXED_NOW, id: sequentialIds(), random: () => 0, run };
}
