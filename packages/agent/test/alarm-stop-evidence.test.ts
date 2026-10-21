import { expect, test } from "bun:test";
import { LedgerAction, LedgerSession, SessionHistory } from "@oni/protocol";
import { armAction, firedAction } from "../src/core/ports/alarm";
import { sessionStopEvidence } from "../src/core/session/run";
import type { SessionKernel } from "../src/core/session/entity";
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
  const kernel: Pick<SessionKernel, "row" | "actionById" | "historyPage"> = {
    row: () => LedgerSession.Row.parse({
      id: sessionId, parentId: null, role: "resident", fenceOwner: null, fence: 0,
      revision: reads++ === 0 ? 1 : 2, state: "idle",
    }),
    actionById: (id) => id === "turn" ? turn : undefined,
    historyPage: (_id, request = {}) => {
      const afterRevision = request.afterRevision ?? 0;
      return SessionHistory.Page.parse({
        sessionId, afterRevision, headRevision: 2,
        actions: afterRevision < 2 ? [committed] : [],
        nextRevision: null,
      });
    },
  };
  return runTestSync(sessionStopEvidence(kernel, sessionId, "turn", () => undefined)());
}

test("an arm row still counts as progress when open alarms come from the shared fold", () => {
  expect(evidence(arm)).toMatchObject({ progress: true, alarmIds: [arm.id] });
  expect(evidence(firing)).toMatchObject({ progress: false, alarmIds: [] });
});
