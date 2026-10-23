import { expect, test } from "bun:test";
import type { LedgerAction, LedgerSession } from "@oni/protocol";
import { adoptWriter, materializeSession } from "../../../packages/agent/test/store/helpers/session";
type SessionKernel = import("@oni/agent").Core.SessionKernel;
import { readSessionCursor } from "../src/gateway";
import { testPlane } from "./helpers/ledger";
import { runSyncEffect } from "./helpers/scoped-effect";
import { turnIntentAction as intentFor } from "./helpers/turn-intent";

const SESSION = "phase-since";

function readPhase(kernel: SessionKernel): { phase: string; phaseSince: number } {
  const response = readSessionCursor(kernel, { type: "session_read", sessionId: SESSION, limit: 256 });
  if (response.type === "session_gap") throw new Error("unexpected session gap");
  return { phase: response.phase, phaseSince: response.phaseSince };
}

const turnIntentAction = (kernel: SessionKernel, id: string, ts: number) =>
  intentFor(kernel, SESSION, id, ts);

function turnTerminalAction(
  turnId: string,
  ts: number,
  kind: "result" | "waiting" | "interrupted",
): LedgerAction.Append {
  return {
    id: `${turnId}:result`,
    parentId: turnId,
    sessionId: SESSION,
    kind: "turn",
    intent: { encodingVersion: 1, value: { phase: "terminal", turnId } },
    effect: {
      encodingVersion: 1,
      value: {
        phase: "terminal",
        turnId,
        kind,
        text: "done",
        boundaryActionId: turnId,
        resumeCount: 0,
        ...(kind === "waiting" ? { reason: "live_wait", alarmIds: ["alarm-1"] } : {}),
      },
    },
    irreversible: true,
    ts,
  };
}

function noteAction(id: string, ts: number): LedgerAction.Append {
  return {
    id,
    parentId: `${SESSION}:configure`,
    sessionId: SESSION,
    kind: "message",
    intent: { encodingVersion: 1, value: {} },
    effect: { encodingVersion: 1, value: { phase: "pending" } },
    irreversible: true,
    ts,
  };
}

function phaseFixture() {
  const plane = testPlane();
  const kernel = plane.openKernel(SESSION);
  materializeSession(kernel, SESSION);
  const authority = adoptWriter(kernel, SESSION, "phase-writer");
  const commit = (actions: readonly LedgerAction.Append[], state: LedgerSession.State) =>
    runSyncEffect(kernel.commit({
      sessionId: SESSION,
      owner: authority.owner,
      fence: authority.fence,
      now: actions[actions.length - 1]?.ts ?? 0,
      expectedRevision: kernel.row(SESSION).revision,
      actions: [...actions],
      state,
    }));
  return { plane, kernel, commit };
}

// Review r1 finding 6: phaseSince must be the durable transition that
// established the emitted phase — not a previous turn's terminal and not the
// latest activity, which moves on unrelated commits within one phase.
test("phaseSince derives from the transition that established the emitted phase", () => {
  const { plane, kernel, commit } = phaseFixture();
  try {
    // Genesis: idle since materialization (configure at ts 1).
    expect(readPhase(kernel)).toEqual({ phase: "idle", phaseSince: 1 });

    // First turn: running since its own intent, stable across later actions.
    commit([turnIntentAction(kernel, "turn-1", 10)], "running");
    expect(readPhase(kernel)).toEqual({ phase: "running", phaseSince: 10 });
    commit([noteAction("note-1", 50)], "running");
    expect(readPhase(kernel)).toEqual({ phase: "running", phaseSince: 10 });

    // Sealed: completed since the sealing terminal.
    commit([turnTerminalAction("turn-1", 60, "result")], "idle");
    expect(readPhase(kernel)).toEqual({ phase: "completed", phaseSince: 60 });

    // Second turn: running since the NEW intent, not the previous terminal.
    commit([turnIntentAction(kernel, "turn-2", 900)], "running");
    expect(readPhase(kernel)).toEqual({ phase: "running", phaseSince: 900 });

    // Waiting: since the waiting terminal, stable across repeated actions.
    commit([turnTerminalAction("turn-2", 1000, "waiting")], "idle");
    expect(readPhase(kernel)).toEqual({ phase: "waiting_input", phaseSince: 1000 });
    commit([noteAction("note-2", 1500)], "idle");
    expect(readPhase(kernel)).toEqual({ phase: "waiting_input", phaseSince: 1000 });
  } finally {
    plane.close();
  }
});

// An interruption is established by the terminal that recorded it: phaseSince
// is the interrupted terminal's ts and never moves on later unrelated commits.
test("an interrupted session reports interrupted since the sealing terminal", () => {
  const { plane, kernel, commit } = phaseFixture();
  try {
    commit([turnIntentAction(kernel, "turn-1", 10)], "running");
    commit([turnTerminalAction("turn-1", 40, "interrupted")], "interrupted");
    expect(readPhase(kernel)).toEqual({ phase: "interrupted", phaseSince: 40 });

    // Later activity within the interrupted phase must not move phaseSince.
    commit([noteAction("note-1", 90)], "interrupted");
    expect(readPhase(kernel)).toEqual({ phase: "interrupted", phaseSince: 40 });
  } finally {
    plane.close();
  }
});

// Review r2 finding 7: the torn-page regression's LATER interleaving. The
// before/page/after consistency check already protected history, terminal and
// latest-action capture, but phase facts were read after it, so a commit
// injected during the phase read could pair the old page and head with the
// new turn's phase timestamp. Phase facts are now captured before the final
// check, so this interleaving surfaces as the promised typed gap - never as
// a session_snapshot mixing an old head with phaseSince 900.
test("a commit interleaved during the phase read yields a typed gap, never an old page with a new phase timestamp", () => {
  const { plane, kernel, commit } = phaseFixture();
  try {
    commit([turnIntentAction(kernel, "turn-1", 10)], "running");
    const headBefore = kernel.row(SESSION).revision;
    let interleaved = false;
    const torn: SessionKernel = {
      ...kernel,
      latestOpenTurn: (sessionId) => {
        if (!interleaved) {
          interleaved = true;
          commit([turnTerminalAction("turn-1", 60, "result")], "idle");
          commit([turnIntentAction(kernel, "turn-2", 900)], "running");
        }
        return kernel.latestOpenTurn(sessionId);
      },
    };
    const response = readSessionCursor(torn, { type: "session_read", sessionId: SESSION, limit: 256 });
    expect(response).toEqual({
      type: "session_gap",
      sessionId: SESSION,
      epoch: kernel.row(SESSION).fence,
      headRevision: headBefore + 2,
      oldestRevision: 0,
    });
  } finally {
    plane.close();
  }
});
