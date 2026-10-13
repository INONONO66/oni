import { Effect } from "effect";
import { expect, it } from "bun:test";
import type { LedgerAction } from "@openomni/protocol";
import type { ExecutionApprovalRequest, ExecutionApprovals } from "../src/core/gate/decide";
import { sessionStopEvidence } from "../src/core/run";
import { armAction, firedAction } from "../src/core/alarm";
import { fencedTurnFixture, type FencedTurnFixture } from "./helpers/fenced-writer";
import { isolated, isolatedLedger } from "./helpers/isolated";
import { sessionTree } from "./helpers/session-tree";

function approvalsWith(ids: readonly string[]): ExecutionApprovals {
  return {
    pending: () => ids.map((id: string) => ({ id }) as ExecutionApprovalRequest),
    answer: () => Effect.void,
  };
}
/** Chain rows: a capability arm and the fired row that settles its occurrence. */
function armed(parentId: string, ts: number) {
  return armAction({
    parentId, sessionId: "evidence", purpose: "test.tick", at: ts + 1, supersedes: null,
    alarmId: "alarm-1", sourceKey: "test", payload: {}, armSeq: 1, ts,
  });
}
function fired(occurrenceId: string, parentId: string, ts: number): LedgerAction.Append {
  return firedAction({
    parentId, sessionId: "evidence", purpose: "test.tick", alarmId: "alarm-1", occurrenceId,
    outcome: "delivered", ts,
  });
}
function commitAlarm(fixture: FencedTurnFixture, action: LedgerAction.Append) {
  const kernel = isolatedLedger().kernel;
  return kernel.commit({
    sessionId: "evidence", owner: fixture.owner, fence: fixture.fence, now: action.ts,
    expectedRevision: kernel.row("evidence").revision, state: "running", actions: [action],
  });
}

it("reports armed alarms of this turn and every open intent from obligations and pending approvals", () => isolated(Effect.gen(function* () {
  const kernel = isolatedLedger().kernel;
  const fixture = yield* fencedTurnFixture(kernel, { id: "evidence", clock: () => 0 });
  const evidence = sessionStopEvidence(kernel, "evidence", fixture.turnId, () => approvalsWith(["approval-1"]), () => Effect.succeed([{ actionId: "obligation-1", kind: "message" as const }]));
  const arm = armed(fixture.turnId, 5_000);
  yield* commitAlarm(fixture, arm.action);
  expect(yield* evidence()).toEqual({ progress: true, blocked: false, openIntent: ["obligation-1", "approval-1"], alarmIds: [arm.action.id] });
})));

it("ignores alarms that are no longer armed and reports nothing when no obligations exist", () => isolated(Effect.gen(function* () {
  const kernel = isolatedLedger().kernel;
  const fixture = yield* fencedTurnFixture(kernel, { id: "evidence", clock: () => 0 });
  const evidence = sessionStopEvidence(kernel, "evidence", fixture.turnId, () => undefined);
  const arm = armed(fixture.turnId, 5_000);
  yield* commitAlarm(fixture, arm.action);
  yield* commitAlarm(fixture, fired(arm.occurrenceId, arm.action.id, 5_000));
  expect(sessionTree(kernel, "evidence").some((action: LedgerAction.Node) => action.kind === "alarm")).toBe(true);
  expect(yield* evidence()).toEqual({ progress: true, blocked: false, openIntent: [], alarmIds: [] });
})));

it("treats a retired chain (arm at: null) as settled wait evidence", () => isolated(Effect.gen(function* () {
  const kernel = isolatedLedger().kernel;
  const fixture = yield* fencedTurnFixture(kernel, { id: "evidence", clock: () => 0 });
  const evidence = sessionStopEvidence(kernel, "evidence", fixture.turnId, () => undefined);
  const arm = armed(fixture.turnId, 5_000);
  yield* commitAlarm(fixture, arm.action);
  // The retire is an `arm{at: null}` row superseding the live occurrence.
  const retire = armAction({
    parentId: arm.action.id, sessionId: "evidence", purpose: "test.tick", at: null,
    supersedes: arm.occurrenceId, alarmId: "alarm-1", sourceKey: "test",
    payload: { reason: "cancel" }, armSeq: 2, ts: 5_001,
  });
  yield* commitAlarm(fixture, retire.action);
  expect(yield* evidence()).toEqual({ progress: true, blocked: false, openIntent: [], alarmIds: [] });
})));
