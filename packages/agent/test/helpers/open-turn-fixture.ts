import { generationSnapshot } from "../../src/core/store/configure";
import { turnTerminal } from "../../src/core/store/session-reads";
import type { LedgerAction } from "@oni/protocol";
import { turnIntentAction, turnTerminalAction } from "../../src/core/journal/turn-rows";

/** Canonical generation-1 snapshot shared by FSM and admission fixtures. */
export const fixtureGeneration = generationSnapshot({
  generation: 1,
  revertTo: 0,
  tools: [],
  system: { preset: "", blocks: [] },
  policyGeneration: 1,
});

export function fixtureNode(action: LedgerAction.Append): LedgerAction.Node {
  return { ...action, ordinal: 1, prevHash: "prev", actionHash: "hash" };
}

/** Open turn "T" (result "R") for session "S" at ordinal 1. */
export const fixtureTurn = fixtureNode(
  turnIntentAction({
    id: "T",
    parentId: null,
    sessionId: "S",
    resultId: "R",
    deliveryIds: [],
    generation: fixtureGeneration,
    resumeCount: 0,
    boundaryActionId: null,
    at: 1,
  }),
);

export const fixtureOpenTurn = {
  turnId: fixtureTurn.id,
  resultId: "R",
  resumeCount: 0,
  boundaryActionId: null,
  action: fixtureTurn,
  toolsGeneration: fixtureGeneration.generation,
  toolsHash: fixtureGeneration.toolsHash,
  systemHash: fixtureGeneration.systemHash,
  policyGeneration: fixtureGeneration.policyGeneration,
};

/** Terminal "R" for turn "T"; the parsed effect is required by construction. */
export function fixtureTerminal(kind: "result" | "interrupted") {
  const action = fixtureNode(turnTerminalAction({
    id: "R", parentId: "T", sessionId: "S", turnId: "T", result: { kind, text: "" },
    resumeCount: 0, boundaryActionId: null, at: 2,
  }));
  const effect = turnTerminal(action);
  if (effect === undefined) throw new Error("invalid terminal fixture");
  return { action, effect };
}
