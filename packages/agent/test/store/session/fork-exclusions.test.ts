import { Effect, Result } from "effect";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Alarm } from "@oni/protocol";
import { runLedgerSync } from "../helpers/effect";
import { adoptWriter } from "../helpers/session";
import { CHILD, PARENT, useForkFixture } from "../helpers/fork-fixture";
import * as SessionHandleStore from "../../../src/core/store/fence";
import { receivedMessageAction } from "../../../src/core/journal/delivery";
import { turnTerminalAction } from "../../../src/core/journal/turn-rows";
import { alarmDisposition, armAction, firedAction, type AlarmChainReads } from "../../../src/core/ports/alarm";

const { stores, child, fixture } = useForkFixture();

const ArmIntent = z.looseObject({ op: z.literal("arm"), alarmId: z.string(), at: z.number().nullable() });
const ArmEffect = z.looseObject({ occurrenceId: z.string() });
const FiredIntent = z.looseObject({ op: z.literal("fired"), occurrenceId: z.string(), outcome: z.string() });

/** The chain-guard reads, folded from one kernel's committed chain. */
function chainReads(kernel: SessionHandleStore.SessionKernel, sessionId: string): AlarmChainReads {
  const arms = new Map<string, { occurrenceId: string; at: number | null }>();
  const settled = new Set<string>();
  for (const action of kernel.historyPage(sessionId, { afterRevision: 0, limit: 256 }).actions) {
    if (action.kind !== "alarm") continue;
    const arm = ArmIntent.safeParse(action.intent.value);
    const armEffect = ArmEffect.safeParse(action.effect.value);
    if (arm.success && armEffect.success)
      arms.set(arm.data.alarmId, { occurrenceId: armEffect.data.occurrenceId, at: arm.data.at });
    const fired = FiredIntent.safeParse(action.intent.value);
    if (fired.success && fired.data.outcome !== "stale") settled.add(fired.data.occurrenceId);
  }
  return {
    latestArm: (alarmId) => arms.get(alarmId),
    settled: (occurrenceId) => settled.has(occurrenceId),
  };
}

describe("Session.fork exclusions", () => {
  // The real firing proof — one parent delivery through the live entity,
  // zero child registrations/deliveries — lives in
  // `test/session/fork-alarm-firing.test.ts` (r3 M-1); this test pins the
  // durable facts the guard folds from.
  test("the fork drops a PRE-ANCHOR arm from the child index and chain", () => {
    const parent = fixture.buildParent();
    // Anchor at msg-2: the armed alarm PRECEDES the anchor, yet is excluded.
    fixture.forked("msg-2");
    const childKernel = SessionHandleStore.createSessionKernel(child(), stores.catalog);

    // No arm row was copied and the child's armed-alarm index is empty; the
    // parent keeps its armed cron untouched (child 0, parent 1).
    expect(child().armedAlarms()).toEqual([]);
    expect(stores.session.armedAlarms().map((alarm) => alarm.alarmId)).toEqual(["alarm-1"]);

    // The chain guard folds from exactly these facts: the parent
    // occurrence is on the latest live arm in the parent chain and has no arm
    // at all in the child chain.
    const occurrence = { alarmId: "alarm-1", occurrenceId: parent.occurrenceId };
    expect(alarmDisposition(chainReads(stores.kernel, PARENT), occurrence)).toEqual({ op: "run" });
    expect(alarmDisposition(chainReads(childKernel, CHILD), occurrence)).toEqual({
      op: "skip",
      reason: "unknown",
    });
  });

  test("a copied orphan alarm.fired folds to skip{unknown} in the child", () => {
    const parent = fixture.buildParent();
    // Arm and fire alarm-0 pre-anchor, then seal a second terminal to fork at.
    const armed = armAction({
      parentId: "msg-2", sessionId: PARENT, purpose: "cron", at: 50, supersedes: null,
      alarmId: "alarm-0", sourceKey: "cron:alarm-0", payload: {}, armSeq: 1, ts: 6,
    });
    const fired = firedAction({
      parentId: armed.action.id, sessionId: PARENT, purpose: "cron",
      alarmId: "alarm-0", occurrenceId: armed.occurrenceId, outcome: "delivered", ts: 7,
    });
    const terminal = turnTerminalAction({
      id: "turn-2:terminal", parentId: fired.id, sessionId: PARENT, turnId: "turn-2",
      result: { kind: "result", text: "later" }, resumeCount: 0, boundaryActionId: null, at: 8,
    });
    fixture.commit(parent.authority, [armed.action, fired, terminal]);
    const anchor = stores.kernel
      .historyPage(PARENT, { afterRevision: 0, limit: 50 })
      .actions.find((action) => action.id === "turn-2:terminal");
    if (anchor === undefined) throw new Error("second terminal missing");
    fixture.forked(anchor.id);
    const childKernel = SessionHandleStore.createSessionKernel(child(), stores.catalog);

    // The fired row was copied; both arm rows were not.
    const alarms = childKernel
      .historyPage(CHILD, { afterRevision: 0, limit: 50 })
      .actions.filter((action) => action.kind === "alarm");
    expect(alarms.map((action) => FiredIntent.safeParse(action.intent.value).success)).toEqual([true]);
    // The copied orphan's parent link to the excluded arm dropped to null.
    expect(alarms[0]?.parentId).toBeNull();
    // The fold ignores a fired row with no arm: skip{unknown}, no re-run.
    expect(
      alarmDisposition(chainReads(childKernel, CHILD), {
        alarmId: "alarm-0",
        occurrenceId: armed.occurrenceId,
      }),
    ).toEqual({ op: "skip", reason: "unknown" });
    // The occurrence key is derived from the parent session id: the same
    // alarm re-armed in the child can never collide with the leaked key.
    expect(Alarm.occurrenceId(CHILD, "alarm-0", 1, "cron:alarm-0")).not.toBe(armed.occurrenceId);
  });

  test("dedup rebuilds after genesis: a pre-fork idempotency key admits fresh", () => {
    fixture.buildParent();
    fixture.forked("turn-1:terminal");
    const childKernel = SessionHandleStore.createSessionKernel(child(), stores.catalog);
    const nodes = childKernel.historyPage(CHILD, { afterRevision: 0, limit: 50 }).actions;

    // The copied input occupies a parent-marked id, not the original key slot.
    expect(childKernel.actionById("msg-1")).toBeUndefined();
    expect(childKernel.actionById(`fork:${PARENT}:msg-1`)?.sessionId).toBe(CHILD);
    // The copied delivery row freed its deterministic consumption id too: a
    // re-admitted "msg-1" can mint "msg-1:delivery" fresh (the live-entity
    // consumption proof is test/session/fork-delivery-replay.test.ts).
    expect(childKernel.actionById("msg-1:delivery")).toBeUndefined();
    expect(childKernel.actionById(`fork:${PARENT}:msg-1:delivery`)?.sessionId).toBe(CHILD);

    // Replaying the pre-fork key "msg-1" against the child appends fresh.
    const authority = adoptWriter(childKernel, CHILD, "child-writer");
    const head = nodes[nodes.length - 1];
    Result.getOrThrowWith(
      runLedgerSync(
        Effect.result(
          childKernel.commit({
            sessionId: CHILD,
            owner: authority.owner,
            fence: authority.fence,
            now: 101,
            expectedRevision: childKernel.row(CHILD).revision,
            actions: [
              receivedMessageAction({
                id: "msg-1",
                sessionId: CHILD,
                kind: "prompt",
                content: [{ kind: "text", text: "replayed" }],
                origin: { encodingVersion: 1, value: { source: "test" } },
                parentActionId: head?.id ?? null,
                at: 101,
              }),
            ],
            state: "idle",
          }),
        ),
      ),
      (error) => error,
    );
    expect(childKernel.actionById("msg-1")?.sessionId).toBe(CHILD);
    expect(childKernel.actionById("msg-1")?.ordinal).toBe(6);
    // And it is pending input for the child's next turn.
    expect(childKernel.pendingMessages(CHILD).map((row) => row.id)).toEqual(["msg-1"]);
  });
});
