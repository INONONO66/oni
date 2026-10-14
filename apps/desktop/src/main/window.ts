import type { BrowserWindowConstructorOptions } from "electron";
import { type parseWindowBounds, WINDOW_MIN } from "./window-bounds";

const BACKGROUND = { dark: "#0A0A0C", light: "#EFEFF0" } as const;

/** BrowserWindow options for a hidden, isolated, sandboxed app window. */
export function windowOptions(
  bounds: ReturnType<typeof parseWindowBounds>,
  dark: boolean,
  preload: string,
) {
  return {
    ...bounds,
    minWidth: WINDOW_MIN.width,
    minHeight: WINDOW_MIN.height,
    show: false,
    backgroundColor: dark ? BACKGROUND.dark : BACKGROUND.light,
    // The strip is 40px (`--shell-top` / `--spacing-shell-strip` in packages/ui).
    // Lights are 12 wide, 8 apart: 16 + 3*12 + 2*8 = 68 =
    // `--spacing-traffic-safe`, + 8 = `--spacing-strip-inset-darwin` 76 where
    // the zone's content starts.
    titleBarStyle: "hiddenInset" as const,
    trafficLightPosition: { x: 16, y: 12 },
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Off until first paint so a hidden window still renders; back on once
      // shown so a backgrounded window stops burning frames.
      backgroundThrottling: false,
    },
  } satisfies BrowserWindowConstructorOptions;
}

/** Select the boot-time renderer location without reading a mutable environment. */
export function rendererTarget(devUrl: string | undefined, file: string) {
  return devUrl === undefined
    ? { kind: "file" as const, target: file }
    : { kind: "url" as const, target: devUrl };
}
