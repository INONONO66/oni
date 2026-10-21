import { Effect } from "effect";
import { isolated } from "../helpers/isolated";
import { createTestAgent } from "../helpers/effect-g2";
import { describe, expect, it } from "bun:test";
import type { Model } from "@oni/protocol";
import { Bus } from "../helpers/bus";
import { createStopOutcome } from "../helpers/mock-llm";
import { runInput } from "../helpers/run-input";

const model = { provider: "anthropic", id: "tiny-window" };

describe("model context admission", () => {
  it("compacts before the attempt and refuses admission when the window still overflows", async () => {
    let calls = 0;
    const llm = {
      run: () =>
        Effect.sync(() => {
          calls += 1;
          return createStopOutcome();
        }),
      resolveModel: (ref: Model.Ref) =>
        Effect.promise(async () => ({
          id: ref.id,
          name: ref.id,
          providerID: ref.provider,
          limit: { context: 1, output: 1_000 },
        })),
    };
    expect(
      await isolated(
        Effect.flip(
          createTestAgent({ events: Bus, model, llm }).run(
            runInput([{ role: "user", content: "a prompt wider than a one-token window" }]),
          ),
        ),
      ),
    ).toMatchObject({ _tag: "ContextAdmissionError" });
    expect(calls).toBe(0);
  });
});
