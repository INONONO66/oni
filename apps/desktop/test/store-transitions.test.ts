import { beforeEach, describe, expect, test } from "bun:test";
import {
  activateTab,
  activateTabAt,
  activeTab,
  back,
  closeTab,
  consoleStore,
  cycleTab,
  forward,
  INITIAL_CLIENT_STATE,
  jumpTo,
  navigate,
  openTab,
  reopenClosedTab,
} from "../src/renderer/state/store";
import "./helpers/platform";

const sessions = { kind: "route", route: "sessions" } as const;
const automations = { kind: "route", route: "automations" } as const;
const otherSession = { kind: "session", sessionId: "other" } as const;
const session = (sessionId: string) => ({ kind: "session", sessionId }) as const;

beforeEach(() => consoleStore.setState(() => INITIAL_CLIENT_STATE));

function current() {
  const tab = activeTab(consoleStore.state);
  if (!tab) throw new Error("expected active tab");
  return tab;
}

describe("tab strip transitions", () => {
  test("open reuses the preferred view, then the first matching view without rewriting history", () => {
    openTab(session("a"));
    const first = current();
    navigate(automations);
    openTab(session("a"));
    expect(current().id).not.toBe(first.id);
    const second = current();
    openTab(session("a"));
    expect(current()).toBe(second);
    activateTab(first.id);
    openTab(session("a"));
    expect(current()).toBe(second);
    expect(consoleStore.state.tabs).toHaveLength(2);
    expect(consoleStore.state.tabs.find(({ id }) => id === first.id)?.history.entries).toEqual([
      session("a"),
      automations,
    ]);
  });

  test("closing an inactive view keeps selection; active close chooses right, left, then none", () => {
    openTab(sessions);
    const left = current();
    openTab(automations);
    const middle = current();
    openTab(otherSession);
    const right = current();
    closeTab("missing");
    expect(consoleStore.state.tabs).toHaveLength(3);
    closeTab(left.id);
    expect(current().id).toBe(right.id);
    activateTab(middle.id);
    closeTab(middle.id);
    expect(current().id).toBe(right.id);
    closeTab(right.id);
    expect(activeTab(consoleStore.state)).toBeNull();
    expect(consoleStore.state.closedTabs.map(({ tab }) => tab.id)).toEqual([
      left.id,
      middle.id,
      right.id,
    ]);
  });

  test("closing the rightmost view selects the left neighbor", () => {
    openTab(sessions);
    const left = current();
    openTab(automations);
    closeTab(current().id);
    expect(current().id).toBe(left.id);
  });

  test("reopen restores the original id, history and clamped index; empty stack is inert", () => {
    const empty = consoleStore.state;
    reopenClosedTab();
    expect(consoleStore.state).toBe(empty);
    openTab(sessions);
    const firstId = current().id;
    navigate(automations);
    back();
    openTab(otherSession);
    const second = current();
    closeTab(firstId);
    closeTab(second.id);
    reopenClosedTab();
    expect(current()).toEqual(second);
    reopenClosedTab();
    expect(consoleStore.state.tabs.map(({ id }) => id)).toEqual([firstId, second.id]);
    expect(current().id).toBe(firstId);
    expect(current().history).toEqual({ entries: [sessions, automations], cursor: 0 });
    forward();
    expect(current().place).toEqual(automations);
    expect(consoleStore.state.closedTabs).toHaveLength(0);
  });

  test("session collision activates the live view and retains snapshot for later retry", () => {
    openTab(session("a"));
    const original = current();
    navigate(automations);
    navigate(session("a"));
    closeTab(original.id);
    openTab(session("a"));
    const replacement = current();
    reopenClosedTab();
    expect(current().id).toBe(replacement.id);
    expect(consoleStore.state.closedTabs).toHaveLength(1);
    navigate(otherSession);
    reopenClosedTab();
    expect(current().id).toBe(original.id);
    expect(current().history.entries).toEqual([session("a"), automations, session("a")]);
    expect(consoleStore.state.closedTabs).toHaveLength(0);
  });

  test("closed snapshots retain only the newest twenty", () => {
    for (let i = 0; i < 21; i++) {
      openTab(session(String(i)));
      closeTab(current().id);
    }
    expect(consoleStore.state.closedTabs).toHaveLength(20);
    expect(consoleStore.state.closedTabs[0]?.tab.place).toEqual(session("1"));
  });

  test("ordinal activation rejects invalid positions and nine means last; cycling wraps", () => {
    const empty = consoleStore.state;
    activateTab("missing");
    activateTabAt(1);
    cycleTab(1);
    expect(consoleStore.state).toBe(empty);
    openTab(sessions);
    const first = current();
    openTab(automations);
    const second = current();
    for (const ordinal of [0, -1, 1.5, 10, Number.NaN, 3]) activateTabAt(ordinal);
    expect(current().id).toBe(second.id);
    activateTabAt(1);
    expect(current().id).toBe(first.id);
    cycleTab(-1);
    expect(current().id).toBe(second.id);
    cycleTab(1);
    expect(current().id).toBe(first.id);
    activateTabAt(9);
    expect(current().id).toBe(second.id);
  });
});

describe("location transitions", () => {
  test("an explicit route navigates only the requested tab and truncates its forward history", () => {
    openTab(sessions);
    const invoking = current();
    navigate(automations);
    back();
    openTab(otherSession);
    const other = current();
    navigate(automations, invoking.id);
    expect(current().id).toBe(invoking.id);
    expect(current().history).toEqual({ entries: [sessions, automations], cursor: 1 });
    expect(consoleStore.state.tabs.find(({ id }) => id === other.id)).toBe(other);
    navigate(sessions, "missing");
    expect(current().history.entries).toEqual([sessions, automations, sessions]);
  });

  test("session selection activates an existing view rather than overwriting the target", () => {
    openTab(session("a"));
    const existing = current();
    openTab(automations);
    const target = current();
    navigate(session("a"), target.id);
    expect(current()).toBe(existing);
    expect(consoleStore.state.tabs.find(({ id }) => id === target.id)).toBe(target);
    navigate(session("b"), target.id);
    expect(current().id).toBe(target.id);
    expect(current().history.entries).toEqual([automations, session("b")]);
  });

  test("navigation on an empty strip appends a tab; same-place and invalid jumps are inert", () => {
    navigate(sessions);
    const initial = current();
    navigate(sessions);
    jumpTo(Number.NaN);
    jumpTo(-1);
    expect(current()).toBe(initial);
    navigate(automations);
    jumpTo(0);
    const previous = current();
    jumpTo(0);
    expect(current()).toBe(previous);
    jumpTo(1);
    expect(current().place).toEqual(automations);
    expect(current().history.cursor).toBe(1);
  });
});
