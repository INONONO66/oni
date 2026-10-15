/** Pinned, hidden and overlay modes share one DOM subtree; hidden content is inert. */
import {
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useRef,
} from "react";
import { UI_NAMES } from "./names";

/** The width the handle may drag between, and where a fresh window starts. */
export const SIDEBAR_WIDTH = { min: 224, max: 330, default: 240 } as const;

export function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, Math.round(width)));
}

export const SIDEBAR_REVEAL = { openDelay: 250, closeDelay: 300 } as const;

/** The one motion attribute every frame element reads: reduced motion wins. */
const FRAME_MOTION =
  "ease-frame motion-reduce:transition-none group-data-[resizing]/sidebar:duration-0";

/** The pointer is over a hot zone / has left every hot zone / the decision was made elsewhere. */
interface RevealIntent {
  readonly enter: () => void;
  readonly leave: () => void;
  readonly cancel: () => void;
}

/** The timers the intent schedules on; the window's by default, a fake clock under test. */
export interface RevealTimers<H> {
  readonly setTimeout: (callback: () => void, ms: number) => H;
  readonly clearTimeout: (handle: H) => void;
}

const WINDOW_TIMERS: RevealTimers<ReturnType<typeof setTimeout>> = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

export function createRevealIntent<H>(
  shown: () => boolean,
  set: (floating: boolean) => void,
  timers: RevealTimers<H>,
  delays: { readonly openDelay: number; readonly closeDelay: number } = SIDEBAR_REVEAL,
): RevealIntent {
  let opening: H | null = null;
  let closing: H | null = null;
  const disarm = () => {
    if (opening !== null) timers.clearTimeout(opening);
    if (closing !== null) timers.clearTimeout(closing);
    opening = null;
    closing = null;
  };
  return {
    enter: () => {
      if (closing !== null) {
        timers.clearTimeout(closing);
        closing = null;
      }
      if (shown() || opening !== null) return;
      opening = timers.setTimeout(() => {
        opening = null;
        set(true);
      }, delays.openDelay);
    },
    leave: () => {
      if (opening !== null) {
        timers.clearTimeout(opening);
        opening = null;
      }
      if (!shown() || closing !== null) return;
      closing = timers.setTimeout(() => {
        closing = null;
        set(false);
      }, delays.closeDelay);
    },
    cancel: disarm,
  };
}

/** Which of the container's three states the frame is in. */
type SidebarMode = "pinned" | "overlay" | "hidden";

interface SidebarState {
  readonly open: boolean;
  readonly mode: SidebarMode;
  readonly width: number;
  readonly onToggle: () => void;
  readonly onWidthCommit: (width: number) => void;
  readonly rootRef: RefObject<HTMLDivElement | null>;
  /** Pointer enter/leave for the hot zones: the strip's toggle, the edge, the floating panel. */
  readonly reveal: Pick<RevealIntent, "enter" | "leave">;
}

const SidebarContext = createContext<SidebarState | null>(null);

/** A sidebar primitive rendered outside its provider: a wiring bug, not a runtime condition. */
export class SidebarContextError extends Error {
  override readonly name = "SidebarContextError";
}

export function useSidebar(): SidebarState {
  const state = useContext(SidebarContext);
  if (state === null) throw new SidebarContextError("useSidebar: no <Sidebar> above this element");
  return state;
}

export function Sidebar({
  open,
  floating,
  width,
  onToggle,
  onFloatingChange,
  onWidthCommit,
  children,
  ...rest
}: {
  readonly open: boolean;
  /** Collapsed, but revealed over the main column by hover. Ignored while open. */
  readonly floating: boolean;
  readonly width: number;
  /** Open ↔ collapsed. Fired by the strip's toggle; while floating, it pins. */
  readonly onToggle: () => void;
  /** The reveal opening after its delay, or closing: by delay, Escape, or a pin. */
  readonly onFloatingChange: (floating: boolean) => void;
  /** The width the Owner released the handle at, already clamped. */
  readonly onWidthCommit: (width: number) => void;
  readonly children: ReactNode;
} & Omit<React.ComponentPropsWithoutRef<"div">, "className" | "children" | "style">) {
  const rootRef = useRef<HTMLDivElement>(null);
  const mode: SidebarMode = open ? "pinned" : floating ? "overlay" : "hidden";

  // The intent reads the LATEST state through refs so one instance lives for
  // the component's life and a re-render never drops a pending timer.
  const latest = useRef({ open, floating, onFloatingChange });
  latest.current = { open, floating, onFloatingChange };
  const intent = useRef<RevealIntent | null>(null);
  if (intent.current === null) {
    intent.current = createRevealIntent(
      () => latest.current.floating,
      (value) => latest.current.onFloatingChange(value),
      WINDOW_TIMERS,
    );
  }
  const reveal = useRef({
    enter: () => {
      if (!latest.current.open) intent.current?.enter();
    },
    leave: () => intent.current?.leave(),
  }).current;

  useEffect(() => {
    intent.current?.cancel();
    if (mode !== "overlay") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") latest.current.onFloatingChange(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mode]);
  useEffect(() => () => intent.current?.cancel(), []);

  return (
    <SidebarContext.Provider
      value={{ open, mode, width, onToggle, onWidthCommit, rootRef, reveal }}
    >
      <div
        className="group/sidebar flex h-dvh w-full overflow-hidden bg-sunken pt-(--shell-top)"
        data-sidebar-state={open ? "open" : "collapsed"}
        data-ui={UI_NAMES.Sidebar}
        ref={rootRef}
        style={{ "--sidebar-width": `${width}px` } as React.CSSProperties}
        {...rest}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

function SidebarGap() {
  return (
    <div
      className={`relative w-(--sidebar-width) shrink-0 transition-[width] duration-base group-data-[sidebar-state=collapsed]/sidebar:w-0 ${FRAME_MOTION}`}
      data-ui={UI_NAMES.SidebarGap}
    />
  );
}

const CONTAINER: Record<SidebarMode, string> = {
  pinned: "top-(--shell-top) left-0 bottom-0 z-(--z-sidebar) w-(--sidebar-width)",
  hidden: "top-(--shell-top) left-0 bottom-0 z-(--z-sidebar) w-(--sidebar-width) -translate-x-full",
  overlay:
    "top-[calc(var(--shell-top)+--spacing(2))] left-2 bottom-2 z-(--z-drawer) w-sidebar-overlay overflow-hidden rounded-panel border-[0.5px] border-line-surface shadow-panel",
};

const CONTENT: Record<SidebarMode, string> = {
  pinned: "delay-[40ms] [[data-tab-strip]_&]:pt-0",
  hidden: "-translate-x-4 opacity-0 delay-0 [[data-tab-strip]_&]:pt-0",
  overlay: "delay-[40ms]",
};

function SidebarContainer({ children }: { readonly children: ReactNode }) {
  const { open, mode, reveal } = useSidebar();
  const hot = open ? {} : { onPointerEnter: reveal.enter, onPointerLeave: reveal.leave };
  return (
    <>
      {/* The 8px strip on the window's left edge that the reveal listens on
          while the sidebar is collapsed. Beside the floating panel, not under
          it, so leaving the panel for the edge keeps it open. */}
      {!open && (
        <div
          className="fixed top-(--shell-top) bottom-0 left-0 z-(--z-drawer) w-2"
          data-ui={UI_NAMES.SidebarEdge}
          {...hot}
        />
      )}
      <div
        className={`fixed flex bg-sunken transition-[translate,inset,width,border-radius,box-shadow] duration-base ${CONTAINER[mode]} ${FRAME_MOTION}`}
        data-mode={mode}
        data-ui={UI_NAMES.SidebarContainer}
        {...hot}
      >
        <div
          // `pt-2` is the column's own top breath.
          className={`flex h-full min-h-0 min-w-0 flex-1 flex-col pt-2 transition-[opacity,translate] duration-fast ${CONTENT[mode]} ${FRAME_MOTION}`}
          data-ui={UI_NAMES.SidebarContent}
          inert={mode === "hidden"}
        >
          {children}
        </div>
        {/* Only a pinned column has a width to change: the overlay floats at
            the shared overlay token and the hidden one has none to show. */}
        {open && <SidebarResizeHandle />}
      </div>
    </>
  );
}

Sidebar.Gap = SidebarGap;
Sidebar.Container = SidebarContainer;

/** ←/→ step; with Shift, four steps. */
const KEY_STEP = 8;
const KEY_STEP_SHIFT = 32;

function SidebarResizeHandle() {
  const { width, onWidthCommit, rootRef } = useSidebar();
  const drag = useRef<{ startX: number; startWidth: number; latest: number; frame: number } | null>(
    null,
  );

  const setWidthVar = (value: number) =>
    rootRef.current?.style.setProperty("--sidebar-width", `${value}px`);

  const end = (commit: boolean) => {
    const current = drag.current;
    if (current === null) return;
    drag.current = null;
    if (current.frame !== 0) cancelAnimationFrame(current.frame);
    rootRef.current?.removeAttribute("data-resizing");
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    if (commit) {
      setWidthVar(current.latest);
      onWidthCommit(current.latest);
    } else {
      setWidthVar(current.startWidth);
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable window splitter (WAI-ARIA separator with valuenow) has no native element; <hr> cannot be operated
    <div
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      aria-valuemax={SIDEBAR_WIDTH.max}
      aria-valuemin={SIDEBAR_WIDTH.min}
      aria-valuenow={width}
      className="focus-ring no-drag absolute inset-y-0 -right-2 w-4 cursor-col-resize touch-none"
      data-ui={UI_NAMES.SidebarResizeHandle}
      onKeyDown={(event) => {
        const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (direction === 0) return;
        event.preventDefault();
        onWidthCommit(
          clampSidebarWidth(width + direction * (event.shiftKey ? KEY_STEP_SHIFT : KEY_STEP)),
        );
      }}
      onPointerCancel={() => end(false)}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        rootRef.current?.setAttribute("data-resizing", "");
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        drag.current = { startX: event.clientX, startWidth: width, latest: width, frame: 0 };
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (current === null) return;
        current.latest = clampSidebarWidth(current.startWidth + event.clientX - current.startX);
        if (current.frame !== 0) return;
        current.frame = requestAnimationFrame(() => {
          current.frame = 0;
          setWidthVar(current.latest);
        });
      }}
      onPointerUp={() => end(true)}
      role="separator"
      tabIndex={0}
    />
  );
}
