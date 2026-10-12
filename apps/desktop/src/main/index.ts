import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserWindow, Menu, app, ipcMain, nativeTheme } from "electron";
import { CLOSE_WINDOW_CHANNEL, GATEWAY_CHANNEL } from "../preload/api";
import { type DesktopConfig, resolveDesktopConfig } from "./config";
import { buildMenuTemplate, createShellCommandSender } from "./menu";
import { rendererTarget, windowOptions } from "./window";
import { BOUNDS_WRITE_DELAY_MS, parseWindowBounds, serializeWindowBounds } from "./window-bounds";

const boundsFile = () => join(app.getPath("userData"), "window-bounds.json");

function readBounds() {
  try {
    return parseWindowBounds(readFileSync(boundsFile(), "utf8"));
  } catch {
    return parseWindowBounds(null);
  }
}

/** The last bounds win, once the window has been still for half a second. */
function persistBounds(window: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const write = () => {
    if (window.isDestroyed() || window.isMinimized() || window.isMaximized()) return;
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(boundsFile(), serializeWindowBounds(window.getBounds()));
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(write, BOUNDS_WRITE_DELAY_MS);
  };
  window.on("resize", schedule);
  window.on("move", schedule);
  window.on("close", () => {
    clearTimeout(timer);
    write();
  });
}

/**
 * Dev-only feedback loop: detached DevTools, and the renderer's console and
 * failure events mirrored to the main process's stdout with a `[renderer]`
 * prefix, so a renderer error shows up in the terminal that ran `dev`.
 */
function attachRendererDebugging(window: BrowserWindow): void {
  const { webContents } = window;
  webContents.openDevTools({ mode: "detach" });
  webContents.on("console-message", ({ level, message, sourceId, lineNumber }) => {
    console.log(`[renderer] ${level}: ${message} (${sourceId}:${lineNumber})`);
  });
  webContents.on("render-process-gone", (_event, details) => {
    console.error(`[renderer] process gone: ${details.reason} (exit ${details.exitCode})`);
  });
  webContents.on("did-fail-load", (_event, code, description, url) => {
    console.error(`[renderer] failed to load ${url}: ${description} (${code})`);
  });
}

function createWindow(
  config: DesktopConfig,
  windows: Map<number, BrowserWindow>,
  onFocus: (windowId: number) => void,
  onClosed: (windowId: number) => void,
): void {
  const window = new BrowserWindow(
    windowOptions(
      readBounds(),
      nativeTheme.shouldUseDarkColors,
      join(import.meta.dirname, "../preload/index.cjs"),
    ),
  );
  const windowId = window.id;
  windows.set(windowId, window);
  const rememberFocus = () => onFocus(windowId);
  window.on("focus", rememberFocus);
  window.webContents.on("devtools-focused", rememberFocus);
  window.once("closed", () => {
    windows.delete(windowId);
    onClosed(windowId);
  });
  window.once("ready-to-show", () => {
    window.show();
    window.webContents.setBackgroundThrottling(true);
  });
  persistBounds(window);
  // The config is the boot-time resolution (#1245): a window opened an hour
  // later must not connect somewhere else because a variable changed under
  // the process.
  const destination = rendererTarget(
    config.rendererDevUrl,
    join(import.meta.dirname, "../renderer/index.html"),
  );
  if (destination.kind === "url") attachRendererDebugging(window);
  void (destination.kind === "url"
    ? window.loadURL(destination.target)
    : window.loadFile(destination.target));
}

/**
 * The Electron entry hands the host process in exactly once (#1245): the
 * environment is resolved here, at startup, and every later read is of the
 * resolved config — re-reading per request would make the endpoint a moving
 * fact that no log line could pin down.
 */
function bootstrap(host: { readonly env: Parameters<typeof resolveDesktopConfig>[0] }): void {
  const config = resolveDesktopConfig(host.env);
  if ("kind" in config) {
    // A typed refusal, not a fallback (#1312): a present-but-invalid
    // OPENOMNI_WS_PORT names itself and no window opens on a guessed port.
    console.error(`[desktop] ${config.message}`);
    app.quit();
    return;
  }
  const development = config.rendererDevUrl !== undefined;
  const applicationWindows = new Map<number, BrowserWindow>();
  let lastFocusedWindowId: number | null = null;

  if (development) app.commandLine.appendSwitch("remote-debugging-port", "9333");

  const openWindow = () =>
    createWindow(
      config,
      applicationWindows,
      (windowId) => {
        lastFocusedWindowId = windowId;
      },
      (windowId) => {
        if (lastFocusedWindowId === windowId) lastFocusedWindowId = null;
      },
    );

  app.whenReady().then(() => {
    // Registered before the first window exists: the renderer asks for the
    // endpoint on its first paint, and a handler installed inside `createWindow`
    // would be a race with it on the second window.
    ipcMain.handle(GATEWAY_CHANNEL, () => config.gateway);
    // The sender decides which window closes: a menu-focused window and the
    // focused window can differ, and only the renderer knows it has no tab left.
    ipcMain.on(CLOSE_WINDOW_CHANNEL, (event) => {
      BrowserWindow.fromWebContents(event.sender)?.close();
    });
    const send = createShellCommandSender({
      getFocusedWindow: () => BrowserWindow.getFocusedWindow(),
      getApplicationWindows: () => [...applicationWindows.values()],
      getLastFocusedWindowId: () => lastFocusedWindowId,
    });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(buildMenuTemplate({ platform: process.platform, development, send })),
    );
    openWindow();
    app.on("activate", () => {
      if (applicationWindows.size === 0) openWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

bootstrap(process);
