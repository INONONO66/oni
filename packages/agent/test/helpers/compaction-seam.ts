import type { ChatFixture as ChatAgentConfig } from "./chat-services";
import { createRunState, recordCallContext, type RunState } from "../../src/core/turn";
import { resolveCompactionGeometry } from "../../src/plugins/compaction/geometry";
import { CompactionRun } from "../../src/plugins/compaction/policy";
import type { CompactionSession } from "../../src/plugins/compaction/speculate";
import type {} from "../../src/core/types";
import { runInput } from "./run-input";
import { testMessageSource } from "./message-source";

export function stateAtGrace(window: number, offset: number) {
  const state = createRunState(runInput([{ role: "user", content: "hi" }]), testMessageSource());
  recordCallContext(state, resolveCompactionGeometry({ contextWindowTokens: window }).graceTokens + offset);
  return state;
}

export function applyThreshold(state: RunState, config: ChatAgentConfig, session: CompactionSession) {
  return new CompactionRun(
    {
      options: config.compaction,
      identity: { traceId: "trace", sessionId: state.sessionId, runId: "run", actorId: "actor" },
      events: config.events,
      executor: config.executor,
      signal: config.signal,
    },
    session,
  ).maybeCompact(state, "threshold");
}
