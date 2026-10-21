import type { SubmitRecipe } from "../pack.js";

export function submit(text: string): SubmitRecipe {
  return {
    writes: [{ kind: "text", value: text }, { kind: "enter" }],
    enterDelayMs: 100,
    stallWindowMs: 10_000,
    refuseWhenWaiting: true,
  };
}
