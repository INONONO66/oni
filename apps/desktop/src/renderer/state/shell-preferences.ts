import { clampSidebarWidth, SIDEBAR_WIDTH } from "@oni/ui";

/**
 * The two shell facts that outlive the window: whether the sidebar is open,
 * and how wide it is. They live in `localStorage` under stable keys and are
 * parsed HERE, at the boundary — a width that is not a finite number is the
 * default, not `NaN` in the store, and an open flag that is not literally
 * `"false"` is open.
 */

export const SIDEBAR_WIDTH_KEY = "oni:sidebar-width";
export const SIDEBAR_OPEN_KEY = "oni:sidebar-open";

interface ShellPreferences {
  readonly open: boolean;
  readonly width: number;
}

export function readShellPreferences(storage: Pick<Storage, "getItem">): ShellPreferences {
  const width = Number(storage.getItem(SIDEBAR_WIDTH_KEY));
  return {
    open: storage.getItem(SIDEBAR_OPEN_KEY) !== "false",
    width: Number.isFinite(width) && width > 0 ? clampSidebarWidth(width) : SIDEBAR_WIDTH.default,
  };
}

export function writeShellPreferences(
  storage: Pick<Storage, "setItem">,
  preferences: ShellPreferences,
): void {
  storage.setItem(SIDEBAR_WIDTH_KEY, String(preferences.width));
  storage.setItem(SIDEBAR_OPEN_KEY, String(preferences.open));
}
