import {
  Console,
  ConsoleContent,
  type ConsoleShell,
  type ConsoleStrip,
  StatusGlyph,
  type WindowPlatform,
} from "@openomni/ui";
import { useStore } from "@tanstack/react-store";
import { useEffect, useLayoutEffect, useMemo } from "react";
import { SessionContent, useSessionChats } from "./chat/session-content";
import { selectChatTransport } from "./chat/select-transport";
import type { RendererPlatform } from "./platform";
import { placeIcon } from "./shell/place-icon";
import { SessionList } from "./shell/session-list";
import { AutomationView } from "./automation/view";
import { IngressLedgerView } from "./ingress-ledger/view";
import { sessionGlyphProps } from "./shell/session-glyph";
import { SessionTree } from "./shell/session-tree";
import { shellShortcut } from "./shell/shortcuts";
import { useSessionActions } from "./shell/use-session-actions";
import { useTabTravel } from "./shell/use-tab-travel";
import { useGatewayEndpoint, useSessionReadModels } from "./state/queries";
import { listedSessions, placeTitle, sessionIndex } from "./state/selectors";
import { readShellPreferences, writeShellPreferences } from "./state/shell-preferences";
import {
  activateTab,
  activeTab,
  closeTab,
  consoleStore,
  navigate,
  openTab,
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
  const tab = activeTab(state);
  const place = tab?.place ?? null;
  const byId = sessionIndex(sessions);
  const listed = useMemo(() => listedSessions(sessions), [sessions]);

  useShellLifecycle(storage);
  const chatFor = useSessionChats(transport);
  const { forkNotice, onFork, onOpenChild } = useSessionActions(host, transport);
  const {
    arrive,
    captureCloseFocus,
    createLabel,
    held,
    history,
    onCreate,
    onSearchingChange,
    onSidebarFloatingChange,
    select,
    travel,
  } = useTabTravel({ host, listed, now, state });
  const shell: ConsoleShell = {
    sidebarOpen,
    sidebarFloating,
    sidebarWidth,
    onToggleSidebar: toggleSidebar,
    onSidebarFloatingChange,
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
    createLabel,
    onCreate,
    platform,
    history,
  };
  const sidebar = (
    <SessionTree
      collapsedProjectIds={collapsedProjectIds}
      onCreate={onCreate}
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
      sidebarOpen={sidebarOpen}
      now={now}
    />
  );
  const session = place?.kind === "session" ? byId.get(place.sessionId) : undefined;
  const content =
    place?.kind === "route" && place.route === "automations" ? (
      <AutomationView key={tab?.id} transport={transport} sessions={localSessions} id={host.id} />
    ) : place?.kind === "route" && place.route === "ingress" ? (
      <IngressLedgerView key={tab?.id} transport={transport} now={now} onOpenSession={onOpenChild} />
    ) : session === undefined ? (
      <ConsoleContent
        emptyLabel={
          "Select or create a session"
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
