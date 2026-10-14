import { Llm, type LlmPort } from "../../src/core/ports/llm";
import { Effect, Layer } from "effect";
import type { ChatAgentConfig, ObservedChatAgentConfig } from "../../src/core/ports/types";
import type { createSessionChatRunner } from "../../src/core/session/run";
import { ObservationSink } from "../../src/core/ports/ports";
import { fixtureCompactionSeam } from "./fixture-compaction";
import { observationService } from "./service-layers";
import { TEST_BUDGET } from "./approval-policy";
import { fakeLlm } from "./fake-llm";

export { fixtureCompactionSeam } from "./fixture-compaction";

/**
 * Fixture stop evidence: the port is required on `ChatAgentConfig`,
 * so fixtures state the former implicit answer — no progress, not blocked,
 * nothing open — explicitly instead of relying on a deleted core default.
 */
export const fixtureStopEvidence: ChatAgentConfig["stopEvidence"] = () =>
  Effect.succeed({ progress: false, blocked: false, openIntent: [], alarmIds: [] });

/**
 * `stopEvidence` is overridable ONLY on the fixture: `ChatAgentConfig`
 * requires the port; test helpers inject `fixtureStopEvidence` when a case
 * omits it.
 */
export interface ChatFixture
  extends Omit<ObservedChatAgentConfig, "stopEvidence" | "budget">,
    Partial<Pick<ObservedChatAgentConfig, "stopEvidence">>,
    Partial<Pick<ChatAgentConfig, "budget" | "defaultBudget">> {
  readonly llm?: Partial<LlmPort>;
}

export function chatServices(fixture: ChatFixture) {
  return Layer.mergeAll(
    Layer.succeed(ObservationSink, observationService(fixture.events)),
    Layer.succeed(Llm, fakeLlm(fixture.llm)),
  );
}

type Prepared = Effect.Success<
  ReturnType<Parameters<typeof createSessionChatRunner>[0]["prepare"]>
>;

/** Shared trace identity of a turn-dispatcher chat fixture. */
export function fixtureTraceContext(input: {
  readonly sessionId: string;
  readonly resultId: string;
}) {
  return { traceId: "trace", sessionId: input.sessionId, runId: input.resultId };
}

/** Shared config head of a turn-dispatcher chat fixture: silent events, test model. */
export function fixtureConfigHead(executor: Prepared["config"]["executor"]) {
  return {
    events: { publish: () => undefined },
    executor,
    model: { provider: "test", id: "test" },
  };
}

export function prepareChatFixture(
  prepared: Omit<Prepared, "config"> & {
    readonly config: ChatFixture & Pick<Prepared["config"], "executor">;
  },
): Prepared {
  const { events: _events, llm: _llm, ...rest } = prepared.config;
  const seamed = "compactionSeam" in rest ? rest : { ...rest, compactionSeam: fixtureCompactionSeam };
  // The budget defaults are composition-owned; fixtures state them.
  const config = { stopEvidence: fixtureStopEvidence, defaultBudget: TEST_BUDGET, ...seamed };
  return {
    ...prepared,
    config: config satisfies ChatAgentConfig & Pick<Prepared["config"], "executor">,
    around: (work) =>
      (prepared.around?.(work) ?? work).pipe(Effect.provide(chatServices(prepared.config))),
  };
}
