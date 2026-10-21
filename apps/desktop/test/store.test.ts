import { setSessionTitleIfPlaceholder } from "../src/renderer/state/session-actions";
import { beforeEach, describe, expect, test } from "bun:test";
import { SIDEBAR_WIDTH } from "@oni/ui";
import {
  activeTab,
  back,
  canGoBack,
  canGoForward,
  consoleStore,
  createSession,
  forward,
  INITIAL_CLIENT_STATE,
  jumpTo,
  navigate,
  newSessionTab,
  openTab,
  setDraft,
  setSidebarFloating,
  setSidebarOpen,
  setSidebarWidth,
  toggleProject,
  toggleSidebar,
} from "../src/renderer/state/store";
import { placeTitle } from "../src/renderer/state/selectors";
import "./helpers/platform";

beforeEach(() => {
  consoleStore.setState(() => INITIAL_CLIENT_STATE);
});

function currentTab() {
  const tab = activeTab(consoleStore.state);
  if (!tab) throw new Error("expected an active tab");
  return tab;
}

describe("session creation and titles", () => {
  test("creates a placeholder record without fabricating a project or opening a view", () => {
    const id = createSession(100);
    expect(consoleStore.state.sessions).toEqual([
      {
        id,
        title: "New Session",
        titleSource: "placeholder",
        projectId: null,
        createdAt: 100,
        lastActivityAt: 100,
        unread: false,
        pinned: false,
        snoozedUntil: null,
      },
    ]);
    expect(consoleStore.state.tabs).toEqual([]);
    expect(consoleStore.state.activeTabId).toBeNull();
  });

  test("new-session action creates distinct records and fresh active tabs", () => {
    newSessionTab();
    const first = currentTab();
    const secondId = newSessionTab();
    expect(consoleStore.state.sessions).toHaveLength(2);
    expect(consoleStore.state.tabs).toHaveLength(2);
    expect(currentTab().id).not.toBe(first.id);
    expect(consoleStore.state.sessions.map(({ titleSource }) => titleSource)).toEqual([
      "placeholder",
      "placeholder",
    ]);
    expect(currentTab().place).toEqual({ kind: "session", sessionId: secondId });
    expect(consoleStore.state.sessions[1]?.id).toBe(secondId);
  });

  test("whitespace does not earn a title, while the first trimmed 40 code points do", () => {
    const id = createSession(1);
    const before = consoleStore.state;
    setSessionTitleIfPlaceholder(id, " \n\t ");
    expect(consoleStore.state).toBe(before);
    const prompt = `  ${"😀".repeat(39)}ab  `;
    setSessionTitleIfPlaceholder(id, prompt);
    expect(consoleStore.state.sessions[0]?.title).toBe(`${"😀".repeat(39)}a`);
    expect(consoleStore.state.sessions[0]?.titleSource).toBe("prompt");
    const earned = consoleStore.state;
    setSessionTitleIfPlaceholder(id, "later prompt");
    setSessionTitleIfPlaceholder("missing", "prompt");
    expect(consoleStore.state).toBe(earned);
  });

  test("a literal placeholder prompt is earned and titles resolve live", () => {
    const id = createSession(1);
    openTab({ kind: "session", sessionId: id });
    const tab = currentTab();
    setSessionTitleIfPlaceholder(id, " New Session ");
    setSessionTitleIfPlaceholder(id, "replacement");
    expect(consoleStore.state.sessions[0]?.titleSource).toBe("prompt");
    expect(placeTitle(tab.place)).toBe("New Session");
    const other = createSession(2);
    openTab({ kind: "session", sessionId: other });
    const otherTab = currentTab();
    setSessionTitleIfPlaceholder(other, "  earned title  ");
    expect(placeTitle(otherTab.place)).toBe("earned title");
    openTab({ kind: "route", route: "automations" });
    expect(placeTitle(currentTab().place)).toBe("Automations");
  });
});

describe("selection, groups and drafts", () => {
  test("explicit session selection reuses the already open view", () => {
    newSessionTab();
    const first = currentTab();
    newSessionTab();
    navigate(first.place);
    expect(currentTab()).toBe(first);
    expect(activeTab(consoleStore.state)?.place ?? null).toEqual(first.place);
    expect(consoleStore.state.tabs).toHaveLength(2);
  });

  test("project groups toggle independently", () => {
    toggleProject("p");
    expect(consoleStore.state.collapsedProjectIds.has("p")).toBe(true);
    toggleProject("p");
    expect(consoleStore.state.collapsedProjectIds.has("p")).toBe(false);
    toggleProject(null);
    expect(consoleStore.state.collapsedProjectIds.has(null)).toBe(true);
  });

  test("drafts stay with their sessions", () => {
    const first = createSession(1);
    const second = createSession(2);
    setDraft(first, "half a thought");
    expect(consoleStore.state.drafts[first]).toBe("half a thought");
    expect(consoleStore.state.drafts[second]).toBeUndefined();
  });
});

describe("tab history has browser semantics", () => {
  test("back twice and forward once move the active cursor and place", () => {
    const first = createSession(1);
    const second = createSession(2);
    navigate({ kind: "session", sessionId: first });
    navigate({ kind: "session", sessionId: second });
    navigate({ kind: "route", route: "automations" });
    back();
    back();
    expect(activeTab(consoleStore.state)?.place ?? null).toEqual({
      kind: "session",
      sessionId: first,
    });
    forward();
    expect(activeTab(consoleStore.state)?.place ?? null).toEqual({
      kind: "session",
      sessionId: second,
    });
    expect(canGoBack(currentTab().history)).toBe(true);
    expect(canGoForward(currentTab().history)).toBe(true);
  });

  test("a new place truncates forward entries", () => {
    openTab({ kind: "route", route: "sessions" });
    navigate({ kind: "session", sessionId: createSession(1) });
    back();
    navigate({ kind: "route", route: "automations" });
    expect(currentTab().history.entries).toEqual([
      { kind: "route", route: "sessions" },
      { kind: "route", route: "automations" },
    ]);
    expect(canGoForward(currentTab().history)).toBe(false);
  });

  test("same-place selection neither pushes nor truncates forward history", () => {
    openTab({ kind: "route", route: "sessions" });
    navigate({ kind: "route", route: "automations" });
    back();
    const before = currentTab();
    navigate({ kind: "route", route: "sessions" });
    expect(currentTab()).toBe(before);
    expect(currentTab().history.entries).toHaveLength(2);
  });

  test("integer cursor jumps do not push", () => {
    openTab({ kind: "route", route: "sessions" });
    navigate({ kind: "session", sessionId: createSession(1) });
    navigate({ kind: "route", route: "automations" });
    jumpTo(0);
    expect(currentTab().history.cursor).toBe(0);
    expect(currentTab().history.entries).toHaveLength(3);
    expect(activeTab(consoleStore.state)?.place ?? null).toEqual({
      kind: "route",
      route: "sessions",
    });
  });

  test("empty strips and invalid boundaries leave state unchanged", () => {
    const empty = consoleStore.state;
    back();
    forward();
    jumpTo(0);
    expect(consoleStore.state).toBe(empty);
    expect(activeTab(empty)).toBeNull();
    expect(activeTab(empty)?.place ?? null).toBeNull();
    openTab({ kind: "route", route: "sessions" });
    const before = consoleStore.state;
    for (const cursor of [-1, 1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) jumpTo(cursor);
    back();
    forward();
    jumpTo(0);
    expect(consoleStore.state).toBe(before);
    expect(canGoBack(currentTab().history)).toBe(false);
    expect(canGoForward(currentTab().history)).toBe(false);
  });
});

describe("the sidebar's width and mode", () => {
  test("widths are clamped and rounded", () => {
    setSidebarWidth(SIDEBAR_WIDTH.min - 100);
    expect(consoleStore.state.sidebarWidth).toBe(SIDEBAR_WIDTH.min);
    setSidebarWidth(SIDEBAR_WIDTH.max + 100);
    expect(consoleStore.state.sidebarWidth).toBe(SIDEBAR_WIDTH.max);
    setSidebarWidth(260.4);
    expect(consoleStore.state.sidebarWidth).toBe(260);
  });

  test("toggle closes and reopens, explicit state is supported", () => {
    toggleSidebar();
    expect(consoleStore.state.sidebarOpen).toBe(false);
    toggleSidebar();
    expect(consoleStore.state.sidebarOpen).toBe(true);
    setSidebarOpen(false);
    expect(consoleStore.state.sidebarOpen).toBe(false);
  });

  test("toggling a floating reveal pins it", () => {
    toggleSidebar();
    setSidebarFloating(true);
    expect(consoleStore.state.sidebarFloating).toBe(true);
    toggleSidebar();
    expect(consoleStore.state.sidebarOpen).toBe(true);
    expect(consoleStore.state.sidebarFloating).toBe(false);
  });

  test("navigation leaves search-owned floating reveal for App to dismiss", () => {
    const id = createSession(1);
    toggleSidebar();
    setSidebarFloating(true);
    navigate({ kind: "route", route: "automations" });
    expect(consoleStore.state.sidebarFloating).toBe(true);
    expect(consoleStore.state.sidebarOpen).toBe(false);
    navigate({ kind: "session", sessionId: id });
    navigate({ kind: "session", sessionId: id });
    expect(consoleStore.state.sidebarFloating).toBe(true);
    back();
    expect(consoleStore.state.sidebarFloating).toBe(true);
  });

  test("unchanged reveal state does not churn", () => {
    const before = consoleStore.state;
    setSidebarFloating(false);
    expect(consoleStore.state).toBe(before);
  });
});

/** An isolated process checks the unbound singleton without perturbing lane LCOV. */
test("an unbound store refuses ambient entropy", async () => {
  const proc = Bun.spawn([process.execPath, `${import.meta.dir}/helpers/unbound-store.ts`], {
    stderr: "pipe",
  });
  const exit = await proc.exited;
  if (exit !== 0) throw new Error(await new Response(proc.stderr).text());
  expect(exit).toBe(0);
}, 15_000);
