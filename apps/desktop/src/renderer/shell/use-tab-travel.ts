import type { SessionRead } from "@openomni/protocol";
import { type ConsoleStrip, UI_NAMES } from "@openomni/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ShellCommand } from "../../preload/api";
import { applyAtBoundary, orderByAttention } from "../attention";
import type { Boundary, Held } from "../attention";
import type { RendererPlatform } from "../platform";
import { desktopBridge } from "../state/desktop-bridge";
import { queryKeys, sessionReadModel } from "../state/queries";
import { historyMenuEntries, listedSessions } from "../state/selectors";
import {
  activeTab,
  back,
  canGoBack,
  canGoForward,
  type ClientState,
  consoleStore,
  forward,
  navigate,
  newSessionTab,
  openTab,
  type Session,
  type SessionId,
  setSidebarFloating,
} from "../state/store";
import { dispatchShellCommand } from "./commands";
import { jumpFrom } from "./history";

export function useTabTravel({
  host,
  listed,
  now,
  state,
}: {
  readonly host: RendererPlatform;
  readonly listed: readonly Session[];
  readonly now: number;
  readonly state: ClientState;
}): TabTravel {
  const queryClient = useQueryClient();
  const createLabel = "New session";
  const search = useRef({ searching: false, invokingTabId: state.activeTabId });
  const focusRecovery = useRef<"panel" | "tab" | null>(null);
  const [held, setHeld] = useState<Held>(() => ({
    shown: orderByAttention(listed, now),
    pendingChanges: 0,
  }));

  const arrive = useCallback(
    (boundary: Boundary | null = "selection") => {
      const searching = search.current.searching;
      setHeld((previous) =>
        applyAtBoundary(
          previous,
          orderByAttention(
            listedSessions(consoleStore.state.sessions).map((local) =>
              sessionReadModel(
                local,
                queryClient.getQueryData<SessionRead.Page>(
                  queryKeys.session(local.durableSessionId ?? ""),
                ),
              ),
            ),
            host.now(),
          ),
          searching ? null : boundary,
        ),
      );
      if (!searching) setSidebarFloating(false);
    },
    [host, queryClient],
  );

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
    const id = state.tabs.find((entry) => entry.id === state.activeTabId)?.id ?? null;
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
      document.querySelector<HTMLElement>(`[data-ui="${UI_NAMES.TabStripCreate}"]`)
    )?.focus();
  }, [state.activeTabId, state.tabs]);

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

  // Clicking moves the current tab; only Cmd/Ctrl-click (or `+`) opens a new one.
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
  const travel = useCallback(
    (action: () => void) => {
      const before = consoleStore.state;
      action();
      if (consoleStore.state !== before) arrive();
    },
    [arrive],
  );
  const onCreate = useCallback(() => travel(newSessionTab), [travel]);

  return {
    arrive,
    captureCloseFocus,
    createLabel,
    held,
    history: historyControls(state, now, travel),
    onCreate,
    onSearchingChange,
    onSidebarFloatingChange: (floating: boolean) => {
      if (floating || !search.current.searching) setSidebarFloating(floating);
    },
    select,
    travel,
  };
}

interface TabTravel {
  readonly arrive: (boundary?: Boundary | null) => void;
  readonly captureCloseFocus: (id: string) => void;
  readonly createLabel: string;
  readonly held: Held;
  readonly history: ConsoleStrip["history"];
  readonly onCreate: () => void;
  readonly onSearchingChange: (searching: boolean) => void;
  readonly onSidebarFloatingChange: (floating: boolean) => void;
  readonly select: (id: SessionId, boundary?: Boundary | null, newTab?: boolean) => void;
  readonly travel: (action: () => void) => void;
}

function historyControls(
  state: ClientState,
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
