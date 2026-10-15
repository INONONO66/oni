import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { formatRelative, hasActiveState, sessionReason } from "../src/renderer/attention/reason";
import { consoleStore, INITIAL_CLIENT_STATE, openTab } from "../src/renderer/state/store";
import type { Session } from "../src/renderer/state/store";
import { renderShell } from "./helpers";
import { testId } from "./helpers/platform";
import { makeSession } from "./helpers/session";

const now = 1_000_000_000;

for (const [elapsed, expected] of [
  [-1, "now"],
  [0, "now"],
  [59_999, "now"],
  [60_000, "1m"],
  [120_000, "2m"],
  [4 * 3_600_000, "4h"],
  [3 * 86_400_000, "3d"],
] as const) {
  test(`relative time at offset ${elapsed} uses a compact whole unit`, () => {
    expect(formatRelative(now, now - elapsed)).toBe(expected);
  });
}

/** Both surfaces (sidebar tree, Sessions list) rendered against one injected frozen clock. */
function renderRows(session: Session) {
  consoleStore.setState(() => ({ ...INITIAL_CLIENT_STATE, sessions: [session] }));
  openTab({ kind: "route", route: "sessions" });
  const document = new Window().document;
  document.body.innerHTML = renderShell(null, [session], { now: () => now, id: testId });
  return document;
}

function withClock<T>(run: () => T): T {
  try {
    return run();
  } finally {
    consoleStore.setState(() => INITIAL_CLIENT_STATE);
  }
}

for (const phase of ["interrupted", "waiting_approval", "waiting_input", "running"] as const) {
  test(`${phase} names its state on both surfaces instead of a time`, () => {
    withClock(() => {
      const session = makeSession({
        phase,
        lastActivityAt: now - 120_000,
        phaseSince: now - 4 * 60_000,
      });
      expect(hasActiveState(session)).toBe(true);
      const document = renderRows(session);
      expect(document.querySelectorAll('[data-ui="TreeRow"] time')).toHaveLength(0);
      const reasons = [...document.querySelectorAll("[data-secondary]")].map((node) =>
        node.textContent?.includes(sessionReason(session, now)),
      );
      expect(reasons).toEqual([true, true]);
      if (phase !== "running") {
        for (const elapsed of [0, 4 * 60_000]) {
          const reason = sessionReason({ ...session, phaseSince: now - elapsed }, now);
          expect(reason.endsWith(formatRelative(now, now - elapsed))).toBe(true);
        }
      }
    });
  });
}

for (const [phase, unread] of [
  ["idle", false],
  ["idle", true],
  ["archived", true],
  ["completed", false],
  ["failed", false],
] as const) {
  test(`${phase}${unread ? " (unread)" : ""} shows its last activity with one clock on both surfaces`, () => {
    withClock(() => {
      const session = makeSession({ phase, unread, lastActivityAt: now - 120_000 });
      expect(hasActiveState(session)).toBe(false);
      const document = renderRows(session);
      const times = [...document.querySelectorAll('[data-ui="TreeRow"] time')];
      expect(times.map((time) => time.textContent?.trim())).toEqual(["2m", "2m"]);
      expect(times.map((time) => time.getAttribute("datetime"))).toEqual([
        new Date(session.lastActivityAt).toISOString(),
        new Date(session.lastActivityAt).toISOString(),
      ]);
    });
  });
}

test("an unread completed session is still state, not time", () => {
  expect(hasActiveState(makeSession({ phase: "completed", unread: true }))).toBe(true);
  expect(hasActiveState(makeSession({ phase: "failed", unread: true }))).toBe(true);
});

test("a session bound to a drawn surface carries that surface's mark after a dot", () => {
  withClock(() => {
    const document = renderRows(makeSession({ surfaceKey: "slack:T1:dm:U1" }));
    const marks = [...document.querySelectorAll('[data-ui="TreeRow"] [data-ui="OriginMark"]')];
    expect(marks).toHaveLength(2);
    for (const mark of marks) {
      expect(mark.getAttribute("data-surface")).toBe("slack");
      expect(mark.previousElementSibling?.textContent).toBe("·");
      expect(mark.parentElement?.lastElementChild === mark).toBe(true);
    }
  });
});

test("a session started here, or on a surface without a mark, carries none", () => {
  withClock(() => {
    for (const session of [makeSession(), makeSession({ surfaceKey: "ws:host:dm:1" })]) {
      const document = renderRows(session);
      expect(document.querySelectorAll('[data-ui="OriginMark"]')).toHaveLength(0);
      const secondary = document.querySelector("[data-secondary]");
      expect(secondary?.textContent).not.toContain("·");
    }
  });
});

test("a session with no durable page yet reads as not connected", () => {
  expect(sessionReason(makeSession({ phase: null }), now)).toBe("not connected");
});
