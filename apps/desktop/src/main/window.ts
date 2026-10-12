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
    // Custom chrome: the native title bar is hidden and the traffic lights sit
    // in the 42px tab strip (`--shell-top` / `--spacing-shell-strip` in
    // @openomni/ui), which drags the window via `-webkit-app-region` (see
    // `drag-region` / `no-drag`). `y` is the TOP of the lights, so centring
    // them on the strip's midline is y = (strip - lights) / 2 = (42 - 14) / 2
    // = 14: the lights measure 14pt tall on this macOS (screen-captured, Darwin
    // 25; the classic 12pt would give 15), and the strip's 28px controls sit at
    // top 7, so both centre on 21. `x: 17` + the 52px cluster + 12 = the
    // strip's 81px traffic safe zone.
    titleBarStyle: "hiddenInset" as const,
    trafficLightPosition: { x: 17, y: 14 },
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Off until first paint so a hidden window still renders; back on once
      // shown so a backgrounded window stops burning frames.
      backgroundThrottling: false,
    },
  };
}

/** Select the boot-time renderer location without reading a mutable environment. */
export function rendererTarget(devUrl: string | undefined, file: string) {
  return devUrl === undefined
    ? { kind: "file" as const, target: file }
    : { kind: "url" as const, target: devUrl };
}
