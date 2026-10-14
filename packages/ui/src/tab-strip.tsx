import { Plus, X } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, type ReactNode, useEffect, useRef } from "react";
import { type HistoryEntry, HistoryMenu } from "./history-menu";
import { ChevronIcon } from "./icons/chevron";
import { SidebarToggleIcon } from "./icons/sidebar-toggle";
import { UI_NAMES } from "./names";
import { IconButton } from "./primitives/button";
import { useSidebar } from "./sidebar";

/**
 * The window's top row: a 40px drag surface whose left zone tracks the
 * sidebar, so the tabs start where the main column starts.
 *
 * Open: the zone is `--sidebar-width` wide, inset 76 on darwin
 * (`--spacing-strip-inset-darwin`) and 8 on the right; the history trio sits
 * against its right edge (`ml-auto`). The toggle is not here: it lives in the
 * sidebar's header.
 *
 * Collapsed: the zone is `--spacing-strip-zone-collapsed` (222) wide and holds
 * [toggle][history][back][forward] at 4px gaps: the toggle's box at x=86
 * (76 + 10), the trio following it, 12 on the right. Width and padding
 * transition together, so the trio slides as ONE node.
 *
 * `platform` is where the OS draws its window controls: on darwin they own the
 * strip's first 68px; elsewhere they sit on the far right and the zone starts
 * at the window's edge.
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
  const { open } = useSidebar();
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
      className="drag-region fixed inset-x-0 top-0 z-(--z-top-bar) flex h-shell-strip w-full shrink-0 items-center bg-bg"
      data-ui={UI_NAMES.TabStrip}
    >
      <div
        className={`flex h-full shrink-0 items-center gap-1 overflow-hidden transition-[width,padding] duration-base ease-frame group-data-[resizing]/sidebar:duration-0 motion-reduce:transition-none ${
          ZONE[platform][open ? "open" : "collapsed"]
        }`}
        data-ui={UI_NAMES.TabStripControls}
      >
        {!open && <SidebarToggle />}
        {/* `ml-auto` is the spacer. ONE node in both states: never re-keyed, no
            motion of its own. It slides because the zone's width transitions. */}
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
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <div
          aria-label="Tabs"
          className="flex min-w-0 shrink items-center gap-1.5 overflow-x-auto pr-2"
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
          size="base"
        >
          <Plus />
        </IconButton>
      </div>
    </header>
  );
}

/**
 * Mounted by the strip while the column is collapsed and by the sidebar's
 * header while it is open. Collapsed, it is also a hot zone: resting on it
 * reveals the column. `plain` because the glyph's widening bar is the hover answer.
 *
 * Toggling moves the control between those two hosts, so the activated node
 * unmounts. When it owned focus, the replacement takes focus on mount; a
 * pointer click elsewhere leaves focus where it was.
 */
export function SidebarToggle() {
  const { open, mode, onToggle, reveal, toggleHandoff } = useSidebar();
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!toggleHandoff.current) return;
    toggleHandoff.current = false;
    button.current?.focus();
  }, [toggleHandoff]);
  return (
    <IconButton
      aria-expanded={open}
      data-ui={UI_NAMES.SidebarToggle}
      label={open ? "Collapse sidebar" : "Expand sidebar"}
      onClick={() => {
        toggleHandoff.current = button.current !== null && document.activeElement === button.current;
        onToggle();
      }}
      ref={button}
      onPointerEnter={open ? undefined : reveal.enter}
      onPointerLeave={open ? undefined : reveal.leave}
      size="base"
      variant="plain"
    >
      <SidebarToggleIcon opened={mode !== "hidden"} />
    </IconButton>
  );
}

/** Where the OS draws its window controls; decides the zone's inset. */
export type WindowPlatform = "darwin" | "other";

/** Collapsed on darwin: toggle at inset + 10, 12 on the right, so the token sums to 222. */
const ZONE: Record<WindowPlatform, Record<"open" | "collapsed", string>> = {
  darwin: {
    open: "w-(--sidebar-width) pl-strip-inset-darwin pr-2",
    collapsed: "w-strip-zone-collapsed pl-[calc(var(--spacing-strip-inset-darwin)+10px)] pr-3",
  },
  other: {
    open: "w-(--sidebar-width) px-2",
    collapsed: "w-auto pl-2.5 pr-3",
  },
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
      className={`group/tab no-drag flex h-tab-height w-56 min-w-24 max-w-56 shrink select-none items-center gap-1.5 rounded-card border-[0.5px] px-2.5 font-medium text-label ${tab.active ? "border-line bg-raised text-fg" : "border-transparent text-fg-muted hover:bg-hover"}`}
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
        className="focus-ring flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-card"
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
