import { Plus, X } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, type ReactNode, useEffect, useRef } from "react";
import { type HistoryEntry, HistoryMenu } from "./history-menu";
import { ChevronIcon } from "./icons/chevron";
import { SidebarToggleIcon } from "./icons/sidebar-toggle";
import { UI_NAMES } from "./names";
import { IconButton } from "./primitives/button";
import { useSidebar } from "./sidebar";

/**
 * The window's top row, as the reference console builds it: a 42px strip that is the drag
 * surface, with a CONTROLS ZONE on the left whose width tracks the sidebar.
 *
 * The zone is the trick: it is ALWAYS exactly as wide as the sidebar. While
 * the sidebar is pinned it is `--sidebar-width` wide, so the tab starts where
 * the main column starts. When the sidebar collapses the zone shrinks to
 * `--spacing-sidebar-overlay`, the width the hover-reveal panel will have —
 * the same token the panel reads — so the trio's place marks where the panel's
 * right edge lands when it appears. Because the zone animates `width` on the
 * same duration and curve as the sidebar gap, the tab slides left in lockstep
 * with the column beneath it. The zone is `[toggle] [spacer] [trio]`, the
 * spacer being the trio's `ml-auto`: the trio is pinned to the zone's right
 * edge 12px in, in both states. The toggle itself never moves, so it is
 * always in the same place under the pointer. Every number is measured
 * (docs/desktop-shell.md).
 *
 * `platform` is a fact about where the OS draws its window controls, not about
 * the data: on darwin the traffic lights own the first 81px and the zone's
 * content starts at 89 (`--spacing-strip-inset-darwin`); elsewhere the OS
 * draws them on the far right and the zone starts at the window's edge.
 */
export function TabStrip({
  tabs,
  onActivate,
  onClose,
  createLabel,
  onCreate,
  platform,
  history,
}: {
  readonly tabs: readonly TabRecord[];
  readonly onActivate: (id: string) => void;
  readonly onClose: (id: string) => void;
  /** The create control's accessible name: what creating means is the app's word. */
  readonly createLabel: string;
  readonly onCreate: () => void;
  readonly platform: WindowPlatform;
  readonly history: HistoryControls;
}) {
  const { open, mode, onToggle, reveal } = useSidebar();
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number;
    switch (event.key) {
      case "ArrowLeft":
        next = (index - 1 + tabs.length) % tabs.length;
        break;
      case "ArrowRight":
        next = (index + 1) % tabs.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = tabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const target = tabs[next];
    if (target !== undefined) {
      onActivate(target.id);
      document.getElementById(`tab-${target.id}`)?.focus();
    }
  };
  return (
    <header
      className="drag-region fixed inset-x-0 top-0 z-(--z-top-bar) flex h-shell-strip w-full shrink-0 items-center bg-sunken"
      data-ui={UI_NAMES.TabStrip}
    >
      <div
        className={`flex h-full shrink-0 items-center gap-1 overflow-hidden transition-[width] duration-base ease-frame group-data-[resizing]/sidebar:duration-0 motion-reduce:transition-none ${
          open ? "w-(--sidebar-width)" : "w-sidebar-overlay"
        } ${ZONE_INSET[platform]}`}
        data-ui={UI_NAMES.TabStripControls}
      >
        {/* The toggle leads. While collapsed it is also a hot zone: resting on
            it reveals the column as an overlay, and clicking it while revealed
            pins the column open. `plain`: the glyph's bar widening on reveal is
            the hover answer, so no fill. */}
        <IconButton
          aria-expanded={open}
          data-ui={UI_NAMES.SidebarToggle}
          label={open ? "Collapse sidebar" : "Expand sidebar"}
          onClick={onToggle}
          onPointerEnter={open ? undefined : reveal.enter}
          onPointerLeave={open ? undefined : reveal.leave}
          size="base"
          variant="plain"
        >
          <SidebarToggleIcon opened={mode !== "hidden"} />
        </IconButton>
        {/* `ml-auto` is the spacer. ONE node in both states — never re-keyed,
            no motion of its own: it slides because the zone's width transitions,
            and it never fades. */}
        <div className="ml-auto flex items-center gap-1" data-ui={UI_NAMES.TabStripTrio}>
          <HistoryMenu
            currentId={history.currentId}
            entries={history.entries}
            now={history.now}
            onJump={history.onJump}
          />
          <IconButton disabled={!history.canBack} label="Back" onClick={history.onBack} size="base">
            <ChevronIcon direction="left" />
          </IconButton>
          <IconButton
            disabled={!history.canForward}
            label="Forward"
            onClick={history.onForward}
            size="base"
          >
            <ChevronIcon direction="right" />
          </IconButton>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-1 pr-1 pl-1">
        <div
          aria-label="Tabs"
          className="flex min-w-0 shrink items-center gap-1 overflow-x-auto"
          data-ui={UI_NAMES.TabStripList}
          role="tablist"
        >
          {tabs.map((tab, index) => (
            <Tab
              key={tab.id}
              onActivate={onActivate}
              onClose={onClose}
              onKeyDown={(event) => onKeyDown(event, index)}
              tab={tab}
            />
          ))}
        </div>
        <IconButton
          data-ui={UI_NAMES.TabStripCreate}
          label={createLabel}
          onClick={onCreate}
          size="sm"
        >
          <Plus />
        </IconButton>
      </div>
    </header>
  );
}

/** Where the OS draws its window controls; decides the zone's inset. */
export type WindowPlatform = "darwin" | "other";

/** The zone's padding is the same in both states: only its width moves. */
const ZONE_INSET: Record<WindowPlatform, string> = {
  darwin: "pr-3 pl-strip-inset-darwin",
  other: "px-2",
};

/** The main column's navigation history, as the strip's trio reads it. */
interface HistoryControls {
  readonly entries: readonly HistoryEntry[];
  readonly currentId: string | null;
  /** The wall clock the menu's relative times are measured against. */
  readonly now: number;
  readonly canBack: boolean;
  readonly canForward: boolean;
  readonly onBack: () => void;
  readonly onForward: () => void;
  readonly onJump: (id: string) => void;
}

interface TabRecord {
  readonly id: string;
  readonly title: string;
  readonly icon: ReactNode;
  readonly active: boolean;
}

function Tab({
  tab,
  onActivate,
  onClose,
  onKeyDown,
}: {
  readonly tab: TabRecord;
  readonly onActivate: (id: string) => void;
  readonly onClose: (id: string) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (tab.active) button.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab.active]);
  const onAuxClick = (event: MouseEvent) => {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    onClose(tab.id);
  };
  return (
    <div
      className={`group/tab no-drag flex h-tab-height w-56 min-w-24 max-w-56 shrink select-none items-center rounded-card border-[0.5px] pr-0.5 font-medium text-label ${tab.active ? "border-line-surface bg-raised text-fg" : "border-line-surface bg-hover text-fg-muted"}`}
      data-ui={UI_NAMES.Tab}
      onAuxClick={onAuxClick}
      onPointerDown={(event) => {
        // The default middle press would focus a tab that is about to close.
        if (event.button === 1) event.preventDefault();
      }}
    >
      <button
        aria-controls={tab.active ? `tab-panel-${tab.id}` : undefined}
        aria-label={tab.title}
        aria-selected={tab.active}
        className="focus-ring flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-card pr-1 pl-2.5"
        id={`tab-${tab.id}`}
        onClick={() => onActivate(tab.id)}
        onFocus={(event) =>
          event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" })
        }
        onKeyDown={onKeyDown}
        ref={button}
        role="tab"
        tabIndex={tab.active ? 0 : -1}
        type="button"
      >
        <span
          aria-hidden="true"
          className="flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-3.5"
          data-ui={UI_NAMES.TabIcon}
        >
          {tab.icon}
        </span>
        <span className="truncate" data-ui={UI_NAMES.TabTitle}>
          {tab.title}
        </span>
      </button>
      <IconButton
        className={
          tab.active
            ? "opacity-100"
            : "opacity-0 group-focus-within/tab:opacity-100 group-hover/tab:opacity-100"
        }
        data-ui={UI_NAMES.TabClose}
        label={`Close ${tab.title}`}
        onClick={(event) => {
          event.stopPropagation();
          onClose(tab.id);
        }}
        onPointerDown={(event) => event.preventDefault()}
        size="xs"
      >
        <X />
      </IconButton>
    </div>
  );
}
