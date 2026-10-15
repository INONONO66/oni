import {
  Console,
  ConsoleContent,
  type ConsoleShell,
  type ConsoleStrip,
  StatusGlyph,
  type WindowPlatform,
} from "@openomni/ui";
import { useStore } from "@tanstack/react-store";
import { useQueryClient } from "@tanstack/react-query";
import type { SessionRead } from "@openomni/protocol";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ShellCommand } from "../preload/api";
import { applyAtBoundary, orderByAttention } from "./attention";
import type { Boundary, Held } from "./attention";
import { SessionContent, useSessionChats } from "./chat/session-content";
import { selectChatTransport } from "./chat/select-transport";
import type { RendererPlatform } from "./platform";
import { dispatchShellCommand } from "./shell/commands";
import { jumpFrom } from "./shell/history";
import { placeIcon } from "./shell/place-icon";
import { SessionList } from "./shell/session-list";
import { sessionGlyphProps } from "./shell/session-glyph";
import { SessionTree } from "./shell/session-tree";
import { shellShortcut } from "./shell/shortcuts";
import { desktopBridge } from "./state/desktop-bridge";
import { queryKeys, sessionReadModel, useGatewayEndpoint, useSessionReadModels } from "./state/queries";
import { adoptForkedSession } from "./state/session-actions";
import { historyMenuEntries, listedSessions, placeTitle, sessionIndex } from "./state/selectors";
import { readShellPreferences, writeShellPreferences } from "./state/shell-preferences";
import {
  activateTab,
  activeTab,
  back,
  canGoBack,
  canGoForward,
  closeTab,
  consoleStore,
  forward,
  navigate,
  newSessionTab,
  openTab,
  type Route,
  type SessionId,
  setSidebarFloating,
  setSidebarOpen,
  setSidebarWidth,
  toggleProject,
  toggleSidebar,
} from "./state/store";

export function App({ platform, storage, host }: AppEnvironment) {
  const state = useStore(consoleStore);
  const now = host.now();
  const { sessions: localSessions, tabs, collapsedProjectIds, sidebarOpen, sidebarFloating, sidebarWidth } = state;
  const { transport, notice } = useChatEndpoint(host.id);
  const sessions = useSessionReadModels(localSessions, transport);
  const queryClient = useQueryClient();
  const tab = activeTab(state);
  const place = tab?.place ?? null;
  const byId = sessionIndex(sessions);
  const listed = useMemo(() => listedSessions(sessions), [sessions]);
  const search = useRef({ searching: false, invokingTabId: state.activeTabId });
  const focusRecovery = useRef<"panel" | "tab" | null>(null);
  const [held, setHeld] = useState<Held>(() => ({
    shown: orderByAttention(listed, now),
    pendingChanges: 0,
  }));

  useShellLifecycle(storage);
  const chatFor = useSessionChats(transport);
  const [forkNotice, setForkNotice] = useState<string | undefined>(undefined);
  // Boundary fork (#1257): ask the gateway, adopt the durable child on success,
  // surface the typed refusal on the composer otherwise.
  const onFork = useCallback(
    (sessionId: string, anchor: string) => {
      if (transport === null || !("forkSession" in transport)) return;
      void (async () => {
        try {
          const response = await transport.forkSession({ sessionId, at: anchor });
          if (response.type === "session_forked") {
            setForkNotice(undefined);
            adoptForkedSession(response.sessionId, `Fork of ${sessionId}`, host.now());
            return;
          }
          setForkNotice(`fork refused: ${response.reason} (${response.detail})`);
        } catch (error) {
          // Boundary narrowing without a written type: the catch variable is
          // already the widest type, narrowed structurally before it renders.
          setForkNotice(error instanceof Error ? error.message : String(error));
        }
      })();
    },
    [host, transport],
  );
  // Opening a fork child (#1257): reuse the already-bound local session's tab,
  // otherwise adopt the durable child exactly like a fresh fork result.
  const onOpenChild = useCallback(
    (sessionId: string, title?: string) => {
      const existing = consoleStore.state.sessions.find(
        (local) => local.durableSessionId === sessionId,
      );
      if (existing !== undefined) {
        openTab({ kind: "session", sessionId: existing.id });
        return;
      }
      adoptForkedSession(sessionId, title ?? sessionId, host.now());
    },
    [host],
  );

  const arrive = useCallback((boundary: Boundary | null = "selection") => {
    const searching = search.current.searching;
    setHeld((previous) =>
      applyAtBoundary(
        previous,
        orderByAttention(listedSessions(consoleStore.state.sessions).map((local) =>
          sessionReadModel(local, queryClient.getQueryData<SessionRead.Page>(
            queryKeys.session(local.durableSessionId ?? ""),
          ))), host.now()),
        searching ? null : boundary,
      ),
    );
    if (!searching) setSidebarFloating(false);
  }, [host, queryClient]);

  // A session's first prompt earns its title and its place in the list: that
  // appearance is a boundary, not a reorder held for the next navigation.
  const listedCount = useRef(listed.length);
  useEffect(() => {
    if (listedCount.current === listed.length) return;
    listedCount.current = listed.length;
    arrive();
  }, [arrive, listed]);

  const captureCloseFocus = useCallback((id: string) => {
    const focused = document.activeElement;
    const panel = document.getElementById(`tab-panel-${id}`);
    const control = document.getElementById(`tab-${id}`)?.parentElement;
    focusRecovery.current = panel?.contains(focused)
      ? "panel"
      : control?.contains(focused)
        ? "tab"
        : null;
  }, []);

  useLayoutEffect(() => {
    const scope = focusRecovery.current;
    if (scope === null) return;
    focusRecovery.current = null;
    const id = tabs.find((entry) => entry.id === state.activeTabId)?.id ?? null;
    const editor =
      id === null || scope !== "panel"
        ? null
        : document
            .getElementById(`tab-panel-${id}`)
            ?.querySelector<HTMLElement>('textarea:not(:disabled), [contenteditable="true"]');
    const successor = id === null ? null : document.getElementById(`tab-${id}`);
    (
      editor ??
      successor ??
      document.querySelector<HTMLElement>('[data-ui="TabStrip.Create"]')
    )?.focus();
  }, [state.activeTabId, tabs]);

  const onShellCommand = useCallback(
    (command: ShellCommand) => {
      const before = consoleStore.state;
      if (command === "close-tab") {
        // Cmd+W on an empty window closes the window, as it would natively.
        if (before.activeTabId === null) {
          desktopBridge()?.closeWindow();
          return;
        }
        captureCloseFocus(before.activeTabId);
      }
      dispatchShellCommand(command);
      if (consoleStore.state !== before) arrive();
    },
    [arrive, captureCloseFocus],
  );

  useEffect(() => {
    return desktopBridge()?.onShellCommand(onShellCommand);
  }, [onShellCommand]);

  const onSearchingChange = useCallback((searching: boolean) => {
    if (searching && !search.current.searching) {
      search.current.invokingTabId = consoleStore.state.activeTabId;
    }
    search.current.searching = searching;
    setSidebarFloating(searching && !consoleStore.state.sidebarOpen);
  }, []);

  // Clicking moves the current tab; only ⌘/Ctrl-click (or `+`) opens a new one.
  const select = (id: SessionId, boundary: Boundary | null = "selection", newTab = false) => {
    const place = { kind: "session", sessionId: id } as const;
    if (newTab) openTab(place);
    else
      navigate(
        place,
        boundary === null ? search.current.invokingTabId : consoleStore.state.activeTabId,
      );
    arrive(boundary);
  };
  const travel = (action: () => void) => {
    const before = consoleStore.state;
    action();
    if (consoleStore.state !== before) arrive();
  };
  const shell: ConsoleShell = {
    sidebarOpen,
    sidebarFloating,
    sidebarWidth,
    onToggleSidebar: toggleSidebar,
    onSidebarFloatingChange: (floating) => {
      if (floating || !search.current.searching) setSidebarFloating(floating);
    },
    onSidebarWidthCommit: setSidebarWidth,
  };
  const strip: ConsoleStrip = {
    tabs: tabs.map((entry) => ({
      id: entry.id,
      title: placeTitle(entry.place, state),
      icon:
        entry.place.kind === "session" ? (
          <StatusGlyph
            {...sessionGlyphProps(byId.get(entry.place.sessionId)?.phase ?? null)}
            size="compact"
          />
        ) : (
          placeIcon(entry.place)
        ),
      active: entry.id === state.activeTabId,
    })),
    onActivate: (id) => {
      activateTab(id);
      arrive();
    },
    onClose: (id) => {
      captureCloseFocus(id);
      travel(() => closeTab(id));
    },
    createLabel: "New session",
    onCreate: () => travel(newSessionTab),
    platform,
    history: historyControls(state, now, travel),
  };
  const sidebar = (
    <SessionTree
      collapsedProjectIds={collapsedProjectIds}
      onNavigate={(route, newTab) => {
        const place = { kind: "route", route } as const;
        if (newTab) openTab(place);
        else navigate(place);
        arrive();
      }}
      onSearchingChange={onSearchingChange}
      onSelect={select}
      onToggleProject={toggleProject}
      ordered={held.shown}
      pendingChanges={held.pendingChanges}
      route={place?.kind === "route" ? place.route : null}
      selectedId={place?.kind === "session" ? place.sessionId : null}
      sessions={listed}
      now={now}
    />
  );
  const session = place?.kind === "session" ? byId.get(place.sessionId) : undefined;
  const content =
    session === undefined ? (
      <ConsoleContent
        emptyLabel={
          place?.kind === "route" && place.route !== "sessions"
            ? ROUTE_EMPTY[place.route]
            : "Select or create a session"
        }
        key={tab?.id ?? "empty"}
      >
        {place?.kind === "route" && place.route === "sessions" ? (
          <SessionList now={now} onSelect={select} ordered={held.shown} sessions={listed} />
        ) : undefined}
      </ConsoleContent>
    ) : (
      <SessionContent
        chat={chatFor(session.id)}
        key={tab?.id}
        notice={forkNotice ?? notice}
        onFork={onFork}
        onOpenChild={onOpenChild}
        session={session}
        transport={transport}
      />
    );
  return <Console content={content} shell={shell} sidebar={sidebar} strip={strip} />;
}

function historyControls(
  state: typeof consoleStore.state,
  now: number,
  travel: (action: () => void) => void,
): ConsoleStrip["history"] {
  const tab = activeTab(state);
  const history = tab?.history;
  return {
    entries: historyMenuEntries(state),
    currentId: history === undefined ? null : String(history.cursor),
    now,
    canBack: history !== undefined && canGoBack(history),
    canForward: history !== undefined && canGoForward(history),
    onBack: () => travel(back),
    onForward: () => travel(forward),
    onJump: (cursor) => travel(() => jumpFrom(tab, cursor)),
  };
}

function useChatEndpoint(id: () => string) {
  const endpoint = useGatewayEndpoint();
  const selected = useMemo(
    () => (endpoint.data ? selectChatTransport(endpoint.data, id) : null),
    [endpoint.data, id],
  );
  const notice = endpoint.isPending
    ? undefined
    : (endpoint.error?.message ??
      (selected === null
        ? "gateway not configured"
        : selected.kind === "misconfigured"
          ? selected.problem
          : undefined));
  return { transport: selected?.transport ?? null, notice };
}

function useShellLifecycle(storage: Storage | null): void {
  useLayoutEffect(() => {
    if (storage === null) return;
    const remembered = readShellPreferences(storage);
    setSidebarOpen(remembered.open);
    setSidebarWidth(remembered.width);
    const subscription = consoleStore.subscribe(() => {
      writeShellPreferences(storage, {
        open: consoleStore.state.sidebarOpen,
        width: consoleStore.state.sidebarWidth,
      });
    });
    return subscription.unsubscribe;
  }, [storage]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (shellShortcut(event, isEditing(event.target)) === null) return;
      toggleSidebar();
      event.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}

export interface AppEnvironment {
  readonly platform: WindowPlatform;
  readonly storage: Storage | null;
  /** Injected clock/entropy (#1245), built once in `main.tsx`. */
  readonly host: RendererPlatform;
}

function isEditing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

const ROUTE_EMPTY = {
  automations: "No automations yet.",
} as const satisfies Record<Exclude<Route, "sessions">, string>;
