import { Llm, LlmLive } from "../../src/model";
import { type Context, Effect, Layer } from "effect";
import type { ChatAgentConfig, ObservedChatAgentConfig } from "../../src/core/types";
import type { createSessionChatRunner } from "../../src/core/run";
import { ObservationSink } from "../../src/core/ports";
import { fixtureCompactionSeam } from "./fixture-compaction";
import { observationService } from "./service-layers";
import { TEST_BUDGET } from "./approval-policy";

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
  readonly llm?: Partial<Context.Service.Shape<typeof Llm>>;
}

export function chatServices(fixture: ChatFixture) {
  return Layer.mergeAll(
    Layer.succeed(ObservationSink, observationService(fixture.events)),
    Layer.effect(
      Llm,
      Effect.map(Llm, (service) => ({ ...service, ...fixture.llm })),
    ).pipe(Layer.provide(LlmLive)),
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
