import {
  Highlight,
  NavItem,
  SectionHeader,
  SectionList,
  SectionSearchInput,
  SidebarFooter,
  SidebarNav,
  SidebarSection,
  Text,
  TreeRow,
} from "@openomni/ui";
import { SessionRow } from "./session-row";
import { Settings } from "lucide-react";
import { useCallback, useMemo, useRef } from "react";
import { ATTENTION_LABEL } from "../attention/order";
import type { Boundary, Ordered } from "../attention";
import { highlightRuns } from "../search";
import type { FilteredSession } from "../search";
import {
  type ProjectId,
  type Route,
  ROUTE_LABEL,
  ROUTES,
  type Session,
  type SessionId,
} from "../state/store";
import { placeIcon } from "./place-icon";
import { rowId, TREE_ID } from "./row-id";
import { useSearch } from "./use-search";

export function SessionTree({
  ordered,
  pendingChanges,
  now,
  sessions,
  selectedId,
  route,
  collapsedProjectIds,
  onToggleProject,
  onSelect,
  onNavigate,
  onSearchingChange,
  defaultSearching = false,
}: {
  readonly ordered: Ordered;
  readonly now: number;
  /** Rows that moved since this order was adopted; held until a boundary. */
  readonly pendingChanges: number;
  readonly sessions: readonly Session[];
  readonly selectedId: SessionId | null;
  readonly route: Route | null;
  readonly collapsedProjectIds: ReadonlySet<ProjectId | null>;
  readonly onToggleProject: (id: ProjectId | null) => void;

  readonly onSelect: (id: SessionId, boundary?: Boundary | null, newTab?: boolean) => void;
  /** `newTab` is the ⌘/Ctrl-click intent: open the route in a new tab instead of moving this one. */
  readonly onNavigate: (route: Route, newTab: boolean) => void;
  readonly onSearchingChange?: (searching: boolean) => void;
  /** Whether the section opens in search mode; uncontrolled after mount. */
  readonly defaultSearching?: boolean;
}) {
  const sessionById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );

  const rowRefs = useRef(new Map<SessionId, HTMLButtonElement>());
  const registerRef = useCallback((id: SessionId, node: HTMLButtonElement | null) => {
    if (node) rowRefs.current.set(id, node);
    else rowRefs.current.delete(id);
  }, []);

  const focusSelectedRow = useCallback(() => {
    if (selectedId !== null) rowRefs.current.get(selectedId)?.focus();
  }, [selectedId]);

  const search = useSearch({
    ordered,
    sessions,
    onSelect,
    focusSelectedRow,
    defaultSearching,
    onSearchingChange,
  });
  const { filtered, state } = search;
  const selectRow = useCallback(
    (id: SessionId, newTab = false) => onSelect(id, search.searching ? null : "selection", newTab),
    [onSelect, search.searching],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>, id: SessionId) => {
      const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
      if (delta === 0) return;

      event.preventDefault();
      const index = filtered.sequence.indexOf(id);
      const next = filtered.sequence[index + delta];
      if (index === -1 || next === undefined) return;

      selectRow(next);
      rowRefs.current.get(next)?.focus();
    },
    [filtered.sequence, selectRow],
  );

  return (
    <>
      <SidebarNav>
        {ROUTES.map((destination) => (
          <NavItem
            active={destination === route}
            icon={placeIcon({ kind: "route", route: destination })}
            key={destination}
            onClick={(event) => onNavigate(destination, event.metaKey || event.ctrlKey)}
          >
            {ROUTE_LABEL[destination]}
          </NavItem>
        ))}
      </SidebarNav>
      <SidebarSection>
        <SectionHeader
          label="Sessions"
          onSearchingChange={search.setSearching}
          resultLabel={search.resultLabel}
          searchLabel="Search sessions"
          searching={search.searching}
        >
          <SectionSearchInput
            activeDescendantId={state.activeId === null ? undefined : rowId(state.activeId)}
            controlsId={TREE_ID}
            inputRef={search.inputRef}
            label="Search sessions"
            onKeyDown={search.onKeyDown}
            onValueChange={search.onValueChange}
            placeholder="Search sessions"
            value={state.query}
          />
        </SectionHeader>
        <SectionList>
          <div aria-label="Sessions" id={TREE_ID} role="tree">
            {sessions.length === 0 && (
              <Text as="p" className="px-2" level="meta" tone="faint">
                No sessions yet — press +
              </Text>
            )}
            {filtered.groups.flatMap((attention) =>
              attention.projects.map((group, index) => {
                // A query overrides a closed group: a result behind a collapsed
                // row is a result nobody was shown.
                const open = !filtered.unfiltered || !collapsedProjectIds.has(group.id);
                return (
                  <div key={JSON.stringify([attention.kind, group.id])}>
                    {filtered.groups.some((entry) => entry.kind !== "rest") && index === 0 ? (
                      <Text className="px-2" level="meta" tone="faint">
                        {ATTENTION_LABEL[attention.kind]}
                      </Text>
                    ) : null}
                    <TreeRow
                      expanded={open}
                      level={0}
                      onClick={() => onToggleProject(group.id)}
                      role="treeitem"
                    >
                      <span className="flex items-center gap-2">
                        <span className="truncate">{group.id ?? "no project"}</span>
                        {group === filtered.groups[0]?.projects[0] && (
                          <ChangeHint count={pendingChanges} />
                        )}
                      </span>
                    </TreeRow>
                    {open && (
                      // biome-ignore lint/a11y/useSemanticElements: a tree's children are a `group` by the ARIA tree pattern; no native element carries that role.
                      <ul className="flex flex-col gap-px" role="group">
                        {group.sessions.map((entry) => {
                          const session = sessionById.get(entry.id);
                          if (!session) return null;
                          return (
                            <SearchSessionRow
                              active={entry.id === state.activeId}
                              current={entry.id === selectedId}
                              now={now}
                              entry={entry}
                              key={entry.id}
                              onKeyDown={onKeyDown}
                              onSelect={selectRow}
                              registerRef={registerRef}
                              session={session}
                            />
                          );
                        })}
                      </ul>
                    )}
                  </div>
                );
              }),
            )}
          </div>
        </SectionList>
      </SidebarSection>
      <SidebarFooter>
        <NavItem icon={<Settings />} disabled>
          Settings
        </NavItem>
      </SidebarFooter>
    </>
  );
}

function SearchSessionRow({
  session,
  now,
  entry,
  current,
  active,
  onSelect,
  onKeyDown,
  registerRef,
}: {
  readonly session: Session;
  readonly now: number;
  readonly entry: FilteredSession;
  readonly current: boolean;
  readonly active: boolean;
  readonly onSelect: (id: SessionId, newTab?: boolean) => void;
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLElement>, id: SessionId) => void;
  readonly registerRef: (id: SessionId, node: HTMLButtonElement | null) => void;
}) {
  return (
    <SessionRow
      session={session}
      now={now}
      aria-selected={active}
      current={current || active}
      id={rowId(session.id)}
      level={0}
      onClick={(event) => onSelect(session.id, event.metaKey || event.ctrlKey)}
      onKeyDown={(event) => onKeyDown(event, session.id)}
      ref={(node: HTMLButtonElement | null) => registerRef(session.id, node)}
      role="treeitem"
    >
      <Highlight
        className="block min-w-0 truncate"
        runs={highlightRuns(session.title, entry.spans)}
        tone={entry.spans.length > 0 ? "muted" : "fg"}
      />
    </SessionRow>
  );
}

function ChangeHint({ count }: { readonly count: number }) {
  if (count === 0) return null;
  return (
    <Text level="micro" numeric tone="faint">
      {count} changes
    </Text>
  );
}
