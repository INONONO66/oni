import { Core } from "@oni/agent";
import { makeLlmService } from "@oni/llm";
const ObservationSink = Core.ObservationSink;
import { Bus } from "./bus";
const Llm = Core.Llm;
import { Effect } from "effect";
import { createCompletionPort } from "../../src/composition/completion";
import type { FixtureLlm } from "./app-fixture";
import { testIds } from "./test-entropy";

/** The sub-model fixture never reads a real credential file: resolution and runs that reach the SDK fail on this path. */
const ABSENT_AUTH_FILE = "/nonexistent/oni-test/auth.json";

export function completionFixture(model: Parameters<typeof createCompletionPort>[0], service: Partial<FixtureLlm> = {}) {
  const port = createCompletionPort(model, { now: () => 1000, id: testIds("completion") });
  return (call: Parameters<typeof port>[0]) => port(call).pipe(
    Effect.provideService(Llm, { ...makeLlmService(ABSENT_AUTH_FILE), ...service }),
    Effect.provideService(ObservationSink, Bus),
  );
}
