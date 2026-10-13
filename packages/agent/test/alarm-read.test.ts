import { describe, expect, test } from "bun:test";
import { LedgerAction, type PlainObject } from "@openomni/protocol";
import { armAction, firedAction } from "../src/core/alarm";
import { foldAlarmChains, openAlarmIds } from "../src/core/alarm-read";
import type { SessionKernel } from "../src/core/entity";

const sessionId = "alarm-read";

function arm(ordinal: number, purpose: string, alarmId: string, at: number | null, supersedes: string | null = null) {
  return armAction({
    parentId: null, sessionId, purpose, alarmId, at, supersedes,
    sourceKey: "watch", payload: {} as PlainObject, armSeq: ordinal, ts: ordinal,
  });
}

function node(action: LedgerAction.Append, ordinal: number): LedgerAction.Node {
  return LedgerAction.Node.parse({ ...action, ordinal, prevHash: "", actionHash: "" });
}

function chains(actions: readonly LedgerAction.Node[], afterRevision = 0, throughRevision = actions.length) {
  const kernel = {
    historyPage: (_sessionId: string, request: { afterRevision?: number; limit?: number }) => {
      const remaining = actions.filter((action) => action.ordinal > (request.afterRevision ?? 0));
      const page = remaining.slice(0, request.limit ?? 100);
      return {
        actions: page,
        nextRevision: remaining.length > page.length ? page.at(-1)?.ordinal ?? null : null,
      };
    },
  } as unknown as Pick<SessionKernel, "historyPage">;
  return foldAlarmChains(kernel, sessionId, { afterRevision, throughRevision });
}

describe("shared alarm chain read", () => {
  test("reserved purpose stays in the rich read but never parks the loop", () => {
    const retry = arm(1, "retry", "retry-1", 500);
    const result = chains([node(retry.action, 1)]);
    expect(result.get("retry-1")?.latest.occurrenceId).toBe(retry.occurrenceId);
    expect(openAlarmIds(result)).toEqual([]);
  });

  test("at: null retains the final arm and excludes the retired chain", () => {
    const first = arm(1, "monitor.hit", "watch-1", 500);
    const retire = arm(2, "monitor.hit", "watch-1", null, first.occurrenceId);
    const result = chains([node(first.action, 1), node(retire.action, 2)]);
    expect(result.get("watch-1")?.latest).toMatchObject({ at: null, occurrenceId: retire.occurrenceId });
    expect(result.get("watch-1")?.armCount).toBe(2);
    expect(openAlarmIds(result)).toEqual([]);
  });

  test("matching stale firing closes loop evidence without settling the app chain", () => {
    const current = arm(1, "monitor.hit", "watch-1", 500);
    const stale = firedAction({
      parentId: null, sessionId, purpose: "monitor.hit", alarmId: "watch-1",
      occurrenceId: current.occurrenceId, outcome: "stale", ts: 2,
    });
    const result = chains([node(current.action, 1), node(stale, 2)]);
    expect(result.get("watch-1")?.settled.has(current.occurrenceId)).toBe(false);
    expect(result.get("watch-1")?.delivered).toBe(0);
    expect(openAlarmIds(result)).toEqual([]);
    expect(openAlarmIds(chains([node(current.action, 1), node(stale, 2)], 0, 1))).toEqual([current.action.id]);
  });

  test("stale firing of superseded occurrence leaves the current arm open", () => {
    const first = arm(1, "monitor.hit", "watch-1", 500);
    const current = arm(2, "monitor.hit", "watch-1", 600, first.occurrenceId);
    const stale = firedAction({
      parentId: null, sessionId, purpose: "monitor.hit", alarmId: "watch-1",
      occurrenceId: first.occurrenceId, outcome: "stale", ts: 3,
    });
    const result = chains([node(first.action, 1), node(current.action, 2), node(stale, 3)]);
    expect(result.get("watch-1")?.latest.occurrenceId).toBe(current.occurrenceId);
    expect(openAlarmIds(result)).toEqual([current.action.id]);
  });
});
