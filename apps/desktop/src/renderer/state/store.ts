import { clampSidebarWidth, SIDEBAR_WIDTH } from "@openomni/ui";
import { Store } from "@tanstack/store";
import type { SessionRead } from "@openomni/protocol";
import { RendererInvariantError } from "../errors";
import type { RendererPlatform } from "../platform";

/**
 * Window-lifetime client state. Server state belongs in queries.ts; sessions
 * stay here until the wire supplies a session-list method. Explicit selection
 * reuses open views, while history traversal is strictly tab-local.
 */
export type ProjectId = string;
export type SessionId = string;

export type SessionPhase = SessionRead.Page["phase"];

export interface LocalSession {
  readonly id: SessionId;
  readonly title: string;
  readonly titleSource: "placeholder" | "prompt";
  /**
   * The channel surface key (`Channel.SurfaceKey` format, e.g. `slack:T1:dm:U1`)
   * the session is bound to; absent for a session started in this app.
   * Sessions are client-local today, so the read model that will supply it
   * has not landed; the field is the row's contract for it.
   */
  readonly surfaceKey?: string;
  readonly durableSessionId?: string;
  readonly projectId: ProjectId | null;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly unread: boolean;
  readonly pinned: boolean;
  readonly snoozedUntil: number | null;
}

export interface Session extends LocalSession {
  readonly phase: SessionPhase | null;
  readonly phaseSince: number;
  /** Fork aside (#1257): history-only ancestry text from the read page; never sent to the model. */
  readonly forkAside?: string;
  /** Fork ancestry (#1257): the parent edge and fork pin off the read page. */
  readonly ancestry?: NonNullable<SessionRead.Page["ancestry"]>;
  /** Fork children (#1257): the read page's inspect-tree child projection. */
  readonly forkChildren?: NonNullable<SessionRead.Page["children"]>;
  /** The newest boundary anchor on the cached page: where a fork would cut (#1257). */
  readonly latestForkAnchor?: string;
}

export type Route = "sessions" | "automations" | "machines" | "ingress";

export const ROUTES: readonly Route[] = ["sessions", "automations", "machines", "ingress"];

export type Place =
  | { readonly kind: "session"; readonly sessionId: SessionId }
  | { readonly kind: "route"; readonly route: Route };

export interface History {
  readonly entries: readonly Place[];
  readonly cursor: number;
}

export interface Tab {
  readonly id: string;
  readonly place: Place;
  readonly history: History;
}

interface ClosedTab {
  readonly tab: Tab;
  readonly index: number;
}

export interface ClientState {
  readonly sessions: readonly LocalSession[];
  readonly tabs: readonly Tab[];
  readonly activeTabId: string | null;
  readonly closedTabs: readonly ClosedTab[];
  readonly collapsedProjectIds: ReadonlySet<ProjectId | null>;
  readonly drafts: Readonly<Record<SessionId, string>>;
  readonly sidebarOpen: boolean;
  /** Transient reveal; App owns search-aware arrival dismissal. */
  readonly sidebarFloating: boolean;
  readonly sidebarWidth: number;
}

export const INITIAL_CLIENT_STATE: ClientState = {
  sessions: [],
  tabs: [],
  activeTabId: null,
  closedTabs: [],
  collapsedProjectIds: new Set(),
  drafts: {},
  sidebarOpen: true,
  sidebarFloating: false,
  sidebarWidth: SIDEBAR_WIDTH.default,
};

export const consoleStore = new Store<ClientState>(INITIAL_CLIENT_STATE);

/**
 * The store is a module-level singleton, so its injected clock/entropy (#1245)
 * is a module-level binding: the bootstrap file sets it once, before anything
 * can mint a session or tab. Unbound minting is an invariant violation, never
 * an ambient `Date`/`crypto` fallback.
 */
let boundPlatform: RendererPlatform | null = null;

export function bindStorePlatform(platform: RendererPlatform): void {
  boundPlatform = platform;
}

function storePlatform(): RendererPlatform {
  if (boundPlatform === null) {
    throw new RendererInvariantError("store platform unbound: call bindStorePlatform at bootstrap");
  }
  return boundPlatform;
}

export function activeTab(state: ClientState): Tab | null {
  return state.tabs.find((tab) => tab.id === state.activeTabId) ?? null;
}

export function createSession(now: number): SessionId {
  const id = storePlatform().id();
  consoleStore.setState((state) => ({
    ...state,
    sessions: [
      ...state.sessions,
      {
        id,
        title: "New Session",
        titleSource: "placeholder",
        projectId: null,
        createdAt: now,
        lastActivityAt: now,
        unread: false,
        pinned: false,
        snoozedUntil: null,
      },
    ],
  }));
  return id;
}

export function newSessionTab(): SessionId {
  const id = createSession(storePlatform().now());
  openTab({ kind: "session", sessionId: id });
  return id;
}

export function ensureBootTab(): void {
  if (consoleStore.state.tabs.length > 0) return;
  newSessionTab();
}

export function openTab(place: Place): void {
  const id = storePlatform().id();
  consoleStore.setState((state) => {
    const match = matchingTab(state, place, activeTab(state));
    return match ? activated(state, match.id) : appendTab(state, place, id);
  });
}

export function activateTab(id: string): void {
  consoleStore.setState((state) =>
    state.tabs.some((tab) => tab.id === id) ? activated(state, id) : state,
  );
}

export function closeTab(id: string): void {
  consoleStore.setState((state) => {
    const index = state.tabs.findIndex((tab) => tab.id === id);
    const tab = state.tabs[index];
    if (!tab) return state;
    return {
      ...state,
      tabs: state.tabs.filter((candidate) => candidate.id !== id),
      activeTabId: state.activeTabId === id ? closeSuccessor(state.tabs, index) : state.activeTabId,
      closedTabs: [...state.closedTabs, { tab, index }].slice(-20),
    };
  });
}

function closeSuccessor(tabs: readonly Tab[], index: number): string | null {
  return tabs[index + 1]?.id ?? tabs[index - 1]?.id ?? null;
}

export function reopenClosedTab(): void {
  consoleStore.setState((state) => {
    const snapshot = state.closedTabs[state.closedTabs.length - 1];
    if (!snapshot) return state;
    if (snapshot.tab.place.kind === "session") {
      const match = matchingTab(state, snapshot.tab.place, activeTab(state));
      if (match) return activated(state, match.id);
    }
    const index = Math.min(snapshot.index, state.tabs.length);
    return {
      ...state,
      tabs: [...state.tabs.slice(0, index), snapshot.tab, ...state.tabs.slice(index)],
      activeTabId: snapshot.tab.id,
      closedTabs: state.closedTabs.slice(0, -1),
    };
  });
}

export function activateTabAt(ordinal: number): void {
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 9) return;
  consoleStore.setState((state) => {
    const tab = state.tabs[ordinal === 9 ? state.tabs.length - 1 : ordinal - 1];
    return tab ? activated(state, tab.id) : state;
  });
}

export function cycleTab(delta: 1 | -1): void {
  consoleStore.setState((state) => {
    if (state.tabs.length === 0) return state;
    const index = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
    const tab = state.tabs[(index + delta + state.tabs.length) % state.tabs.length];
    return tab ? activated(state, tab.id) : state;
  });
}

export function navigate(
  place: Place,
  targetTabId: string | null = consoleStore.state.activeTabId,
): void {
  const id = storePlatform().id();
  consoleStore.setState((state) => {
    const target = state.tabs.find((tab) => tab.id === targetTabId) ?? activeTab(state);
    if (place.kind === "session") {
      const match = matchingTab(state, place, target);
      if (match) return activated(state, match.id);
    }
    return navigateTarget(state, target, place, id);
  });
}

function navigateTarget(state: ClientState, target: Tab | null, place: Place, id: string): ClientState {
  if (!target) return appendTab(state, place, id);
  if (samePlace(target.place, place)) return activated(state, target.id);
  const kept = target.history.entries.slice(0, target.history.cursor + 1);
  return replaceTab(state, {
    ...target,
    place,
    history: { entries: [...kept, place], cursor: kept.length },
  });
}

export function back(): void {
  moveCursor(-1);
}

export function forward(): void {
  moveCursor(1);
}

export function jumpTo(cursor: number): void {
  if (!Number.isInteger(cursor)) return;
  consoleStore.setState((state) => {
    const tab = activeTab(state);
    return tab ? atCursor(state, tab, cursor) : state;
  });
}

export function canGoBack(history: History): boolean {
  return history.cursor > 0;
}

export function canGoForward(history: History): boolean {
  return history.cursor < history.entries.length - 1;
}

function moveCursor(delta: 1 | -1): void {
  consoleStore.setState((state) => {
    const tab = activeTab(state);
    return tab ? atCursor(state, tab, tab.history.cursor + delta) : state;
  });
}

function atCursor(state: ClientState, tab: Tab, cursor: number): ClientState {
  const place = tab.history.entries[cursor];
  if (!place || cursor === tab.history.cursor) return state;
  return replaceTab(state, { ...tab, place, history: { ...tab.history, cursor } });
}

function activated(state: ClientState, id: string): ClientState {
  return state.activeTabId === id ? state : { ...state, activeTabId: id };
}

function appendTab(state: ClientState, place: Place, id: string): ClientState {
  return {
    ...state,
    tabs: [...state.tabs, { id, place, history: { entries: [place], cursor: 0 } }],
    activeTabId: id,
  };
}

function replaceTab(state: ClientState, tab: Tab): ClientState {
  return {
    ...state,
    tabs: state.tabs.map((candidate) => (candidate.id === tab.id ? tab : candidate)),
    activeTabId: tab.id,
  };
}

function matchingTab(state: ClientState, place: Place, preferred: Tab | null): Tab | undefined {
  return preferred && samePlace(preferred.place, place)
    ? preferred
    : state.tabs.find((tab) => samePlace(tab.place, place));
}

function samePlace(a: Place, b: Place): boolean {
  return a.kind === "session" && b.kind === "session"
    ? a.sessionId === b.sessionId
    : a.kind === "route" && b.kind === "route" && a.route === b.route;
}

export const ROUTE_LABEL: Record<Route, string> = {
  sessions: "Sessions",
  automations: "Automations",
  machines: "Machines",
  ingress: "Ingress ledger",
};

export function toggleProject(id: ProjectId | null): void {
  consoleStore.setState((state) => {
    const collapsed = new Set(state.collapsedProjectIds);
    if (collapsed.has(id)) collapsed.delete(id);
    else collapsed.add(id);
    return { ...state, collapsedProjectIds: collapsed };
  });
}

export function setDraft(id: SessionId, value: string): void {
  consoleStore.setState((state) => ({ ...state, drafts: { ...state.drafts, [id]: value } }));
}

export function setSidebarOpen(open: boolean): void {
  consoleStore.setState((state) => ({ ...state, sidebarOpen: open }));
}

/** Open ↔ collapsed. A toggle while the reveal floats PINS it: open, no longer floating. */
export function toggleSidebar(): void {
  consoleStore.setState((state) => ({
    ...state,
    sidebarOpen: !state.sidebarOpen,
    sidebarFloating: false,
  }));
}

export function setSidebarFloating(floating: boolean): void {
  consoleStore.setState((state) =>
    state.sidebarFloating === floating ? state : { ...state, sidebarFloating: floating },
  );
}

/** Clamped here, so no caller can put an out-of-range width in the store. */
export function setSidebarWidth(width: number): void {
  consoleStore.setState((state) => ({ ...state, sidebarWidth: clampSidebarWidth(width) }));
}
