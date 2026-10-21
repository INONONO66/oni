import { expect, jest, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MenuItemConstructorOptions } from "electron";
import { BOUNDS_WRITE_DELAY_MS, parseWindowBounds, WINDOW_MIN } from "../src/main/window-bounds";
import type { GatewayEndpoint } from "../src/preload/api";
import {
  CLOSE_WINDOW_CHANNEL,
  GATEWAY_CHANNEL,
  SHELL_COMMAND_CHANNEL,
  type ShellCommand,
} from "../src/preload/api";

import { runIsolated } from "./helpers/isolated-entry";
import { flatten } from "./helpers/menu";

const childCase = process.env.ONI_MAIN_LIFECYCLE_CHILD;
const cases = childCase === undefined ? [false, true] : [childCase === "true"];
const environment = [
  "ELECTRON_RENDERER_URL",
  "ONI_WS_URL",
  "ONI_WS_PORT",
  "ONI_WS_TOKEN",
] as const;

function applyEnvironment(entries: readonly (readonly [string, string | undefined])[]): void {
  for (const [key, value] of entries) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test.each(cases)("main window lifecycle (development=%s)", async (development) => {
  if (childCase === undefined) {
    await runIsolated(import.meta.path, { ONI_MAIN_LIFECYCLE_CHILD: String(development) });
    return;
  }

  const directory = mkdtempSync(join(tmpdir(), "oni-tabs-main-"));
  const file = join(directory, "window-bounds.json");
  const ready = Promise.withResolvers<void>();
  const events = new EventEmitter();
  const handlers = new Map<string, () => GatewayEndpoint>();
  const listeners = new Map<string, (event: { sender: object }) => void>();
  const windows: WindowDouble[] = [];
  const switches: string[][] = [];
  const loaded: string[] = [];
  const sent: { id: number; channel: string; command: ShellCommand }[] = [];
  const throttle: boolean[] = [];
  let focused: WindowDouble | null = null;
  let menu: MenuItemConstructorOptions[] = [];
  let quits = 0;
  let shown = 0;
  let debugOpened = 0;
  const previousEnv = environment.map((key) => [key, process.env[key]] as const);
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const log = spyOn(console, "log").mockImplementation(() => undefined);
  const error = spyOn(console, "error").mockImplementation(() => undefined);

  class WindowDouble extends EventEmitter {
    readonly id = windows.length + 1;
    readonly webContents = Object.assign(new EventEmitter(), {
      id: this.id * 10,
      devToolsWebContents: { id: this.id * 10 + 1 },
      isDestroyed: () => this.destroyedContents,
      send: (channel: string, command: ShellCommand) =>
        sent.push({ id: this.id, channel, command }),
      setBackgroundThrottling: (enabled: boolean) => throttle.push(enabled),
      openDevTools: (options: { mode: string }) => {
        expect(options.mode).toBe("detach");
        debugOpened += 1;
      },
    });
    destroyed = false;
    destroyedContents = false;
    minimized = false;
    maximized = false;
    bounds = { x: 10, y: 20, width: 1000, height: 700 };
    constructor(
      readonly options: {
        width: number;
        height: number;
        show: boolean;
        backgroundColor: string;
        titleBarStyle: string;
        webPreferences: {
          preload: string;
          contextIsolation: boolean;
          sandbox: boolean;
          nodeIntegration: boolean;
          backgroundThrottling: boolean;
        };
      },
    ) {
      super();
      expect(handlers.has(GATEWAY_CHANNEL)).toBe(true);
      expect(menu.length).toBeGreaterThan(0);
      windows.push(this);
    }
    isDestroyed = () => this.destroyed;
    isMinimized = () => this.minimized;
    isMaximized = () => this.maximized;
    getBounds = () => this.bounds;
    show = () => {
      shown += 1;
    };
    loadFile = (path: string) => {
      loaded.push(`file:${path}`);
      ready.resolve();
      return Promise.resolve();
    };
    loadURL = (url: string) => {
      loaded.push(`url:${url}`);
      ready.resolve();
      return Promise.resolve();
    };
    close = () => {
      this.emit("close");
      this.destroyed = true;
      this.emit("closed");
    };
    static getFocusedWindow() {
      return focused;
    }
    static fromWebContents(contents: object) {
      return windows.find((window) => window.webContents === contents) ?? null;
    }
  }
  mock.module("electron", () => ({
    BrowserWindow: WindowDouble,
    app: {
      whenReady: () => Promise.resolve(),
      getPath: () => directory,
      on: events.on.bind(events),
      quit: () => {
        quits += 1;
      },
      commandLine: { appendSwitch: (...args: string[]) => switches.push(args) },
    },
    ipcMain: {
      handle: (channel: string, handler: () => GatewayEndpoint) => handlers.set(channel, handler),
      on: (channel: string, listener: (event: { sender: object }) => void) =>
        listeners.set(channel, listener),
    },
    nativeTheme: { shouldUseDarkColors: !development },
    Menu: {
      buildFromTemplate: (template: MenuItemConstructorOptions[]) => template,
      setApplicationMenu: (template: MenuItemConstructorOptions[]) => {
        menu = template;
      },
    },
  }));
  const configured: Partial<Record<(typeof environment)[number], string>> = development
    ? {
        ELECTRON_RENDERER_URL: "http://localhost:5173",
        ONI_WS_PORT: "4321",
        ONI_WS_TOKEN: "pinned",
      }
    : {};
  applyEnvironment(environment.map((key) => [key, configured[key]] as const));
  Object.defineProperty(process, "platform", {
    value: development ? "linux" : "darwin",
    configurable: true,
  });
  try {
    await import("../src/main/index");
    await ready.promise;
    expect(handlers.get(GATEWAY_CHANNEL)?.()).toEqual(
      development
        ? { url: "ws://127.0.0.1:4321/ws", token: "pinned" }
        : { url: "ws://127.0.0.1:3000/ws" },
    );
    expect(windows).toHaveLength(1);
    const first = windows[0];
    if (!first) throw new Error("Missing window");
    expect(first.options).toMatchObject({
      width: 1280,
      height: 800,
      minWidth: WINDOW_MIN.width,
      minHeight: WINDOW_MIN.height,
      trafficLightPosition: { x: 16, y: 12 },
      show: false,
      backgroundColor: development ? "#EFEFF0" : "#0A0A0C",
      titleBarStyle: "hiddenInset",
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    expect(first.options.webPreferences.preload.endsWith("/preload/index.cjs")).toBe(true);
    expect(switches).toEqual(development ? [["remote-debugging-port", "9333"]] : []);
    expect(debugOpened).toBe(development ? 1 : 0);
    expect(loaded).toEqual([
      development
        ? "url:http://localhost:5173"
        : expect.stringMatching(/^file:.*\/renderer\/index\.html$/),
    ]);
    first.emit("ready-to-show");
    expect(shown).toBe(1);
    expect(throttle).toEqual([true]);
    const close = flatten(menu).find((item) => item.id === "close-tab");
    if (!close?.click) throw new Error("Missing close-tab command");
    const closeClick = close.click;
    const dispatch = (): void => {
      Reflect.apply(closeClick, undefined, []);
    };
    dispatch();
    expect(sent).toEqual([]);
    first.emit("focus");
    dispatch();
    expect(sent).toEqual([{ id: first.id, channel: SHELL_COMMAND_CHANNEL, command: "close-tab" }]);
    focused = first;
    dispatch();
    expect(sent).toHaveLength(2);
    focused = null;
    first.webContents.emit("devtools-focused");
    dispatch();
    expect(sent).toHaveLength(3);
    first.destroyedContents = true;
    dispatch();
    expect(sent).toHaveLength(3);
    first.destroyedContents = false;
    events.emit("activate");
    expect(windows).toHaveLength(1);

    jest.useFakeTimers();
    first.emit("resize");
    jest.advanceTimersByTime(BOUNDS_WRITE_DELAY_MS - 1);
    expect(existsSync(file)).toBe(false);
    first.bounds = { x: 30, y: 40, width: 1100, height: 750 };
    first.emit("move");
    jest.advanceTimersByTime(BOUNDS_WRITE_DELAY_MS - 1);
    expect(existsSync(file)).toBe(false);
    jest.advanceTimersByTime(1);
    expect(parseWindowBounds(readFileSync(file, "utf8"))).toEqual(first.bounds);
    const saved = readFileSync(file, "utf8");
    first.bounds = { ...first.bounds, width: 1200 };
    for (const state of ["minimized", "maximized", "destroyed"] as const) {
      first[state] = true;
      first.emit("close");
      expect(readFileSync(file, "utf8")).toBe(saved);
      first[state] = false;
    }
    first.emit("move");
    first.emit("close");
    expect(parseWindowBounds(readFileSync(file, "utf8"))).toEqual(first.bounds);
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
    if (development) {
      first.webContents.emit("console-message", {
        level: 2,
        message: "debug-sentinel",
        sourceId: "renderer.js",
        lineNumber: 17,
      });
      first.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 3 });
      first.webContents.emit("did-fail-load", {}, -2, "load-sentinel", "http://localhost:5173");
      expect(log).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledTimes(2);
    }
    first.emit("closed");
    dispatch();
    expect(sent).toHaveLength(3);
    events.emit("activate");
    expect(windows).toHaveLength(2);
    const second = windows[1];
    if (!second) throw new Error("Missing second window");
    expect(second.options).toMatchObject(first.bounds);
    // Renderer-requested close resolves the window from the sender; unknown and
    // destroyed senders are ignored rather than closing some other window.
    const closeWindow = listeners.get(CLOSE_WINDOW_CHANNEL);
    if (!closeWindow) throw new Error("Missing close-window listener");
    closeWindow({ sender: first.webContents });
    closeWindow({ sender: {} });
    expect(second.destroyed).toBe(false);
    closeWindow({ sender: second.webContents });
    expect(second.destroyed).toBe(true);
    dispatch();
    expect(sent).toHaveLength(3);
    events.emit("window-all-closed");
    expect(quits).toBe(development ? 1 : 0);
  } finally {
    jest.useRealTimers();
    log.mockRestore();
    error.mockRestore();
    applyEnvironment(previousEnv);
    if (platform) Object.defineProperty(process, "platform", platform);
    mock.restore();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
