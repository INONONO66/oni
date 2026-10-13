import { expect, test } from "bun:test";
import { LedgerAction } from "@openomni/protocol";
import { armAction, firedAction } from "../src/core/alarm";
import { sessionStopEvidence } from "../src/core/run";
import type { SessionKernel } from "../src/core/entity";
import { runTestSync } from "./helpers/isolated";

const sessionId = "alarm-progress";
const { action: arm, occurrenceId } = armAction({
  parentId: null, sessionId, purpose: "monitor.hit", alarmId: "watch", at: 500,
  supersedes: null, sourceKey: "watch", payload: {}, armSeq: 2, ts: 2,
});
const firing = firedAction({
  parentId: null, sessionId, purpose: "monitor.hit", alarmId: "watch",
  occurrenceId, outcome: "stale", ts: 2,
});

function evidence(action: LedgerAction.Append) {
  const turn = LedgerAction.Node.parse({ ...arm, id: "turn", ordinal: 1, prevHash: "", actionHash: "" });
  const committed = LedgerAction.Node.parse({ ...action, ordinal: 2, prevHash: "", actionHash: "" });
  let reads = 0;
  const kernel = {
    row: () => ({
      id: sessionId, parentId: null, role: "resident" as const, fenceOwner: null, fence: 0,
      revision: reads++ === 0 ? 1 : 2, state: "idle" as const,
      toolsGeneration: 0, systemHash: "", policyGeneration: 0,
    }),
    actionById: (id: string) => id === "turn" ? turn : undefined,
    historyPage: (_id: string, request: { afterRevision?: number }) => ({
      sessionId, afterRevision: request.afterRevision ?? 0, headRevision: 2,
      actions: (request.afterRevision ?? 0) < 2 ? [committed] : [],
      nextRevision: null,
    }),
  } as Pick<SessionKernel, "row" | "actionById" | "historyPage"> as SessionKernel;
  return runTestSync(sessionStopEvidence(kernel, sessionId, "turn", () => undefined)());
}

test("an arm row still counts as progress when open alarms come from the shared fold", () => {
  expect(evidence(arm)).toMatchObject({ progress: true, alarmIds: [arm.id] });
  expect(evidence(firing)).toMatchObject({ progress: false, alarmIds: [] });
});
