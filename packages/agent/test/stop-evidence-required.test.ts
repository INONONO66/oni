/**
 * `stopEvidence` is a REQUIRED port on `ChatAgentConfig`: the deleted
 * `?? Effect.succeed({progress:false,...})` fallback has no replacement, so a
 * runner wired without it is a compile error, and a wired port is consulted
 * by the loop's stop judgment on every turn.
 */
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { isolated } from "./helpers/isolated";
import { createTestAgent } from "./helpers/effect-g3";
import type { ChatAgentConfig } from "../src/core/ports/types";
import { Bus } from "./helpers/bus";
import { completeModel, mockLlm } from "./helpers/mock-llm";
import { runInput } from "./helpers/run-input";

const model = { provider: "anthropic", id: "claude-3-haiku-20240307" };

test("runAgent without stopEvidence does not compile; the port has no runtime default", () => {
  const config = { model } as const;
  // @ts-expect-error — stopEvidence is required on ChatAgentConfig
  const missing: ChatAgentConfig = config;
  // The loop itself is never reached here; the assertion is the type error.
  expect(missing.stopEvidence).toBeUndefined();
});

test("a wired stopEvidence port is consulted by the turn's stop judgment", async () => {
  let consulted = 0;
  const stopEvidence: ChatAgentConfig["stopEvidence"] = () =>
    Effect.sync(() => {
      consulted += 1;
      return { progress: true, blocked: false, openIntent: [], alarmIds: [] };
    });
  const result = await isolated(
    createTestAgent({ events: Bus, model, llm: mockLlm(completeModel), stopEvidence }).run(
      runInput([{ role: "user", content: "go" }]),
    ),
  );
  expect(result.text).toBe("done");
  expect(consulted).toBeGreaterThanOrEqual(1);
});
