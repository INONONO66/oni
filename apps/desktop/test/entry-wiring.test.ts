import { expect, jest, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoot, hydrateRoot } from "react-dom/client";

const realClient = { createRoot, hydrateRoot };
import { GATEWAY_CHANNEL, type DesktopApi, type GatewayEndpoint } from "../src/preload/api";
import { parseWindowBounds } from "../src/main/window-bounds";
import { bindStorePlatform, consoleStore, createSession, INITIAL_CLIENT_STATE } from "../src/renderer/state/store";
import { testPlatform } from "./helpers/platform";

type Globals = { document?: object; window?: object; desktop?: DesktopApi };
const ENVIRONMENT = ["ONI_WS_URL", "ONI_WS_TOKEN", "ELECTRON_RENDERER_URL"] as const;

/** Snapshot the browser globals and gateway env the entries touch; returns the restorer. */
function snapshotHost(globals: Globals): () => void {
  const previous = { ...globals };
  const environment = ENVIRONMENT.map((key) => [key, process.env[key]] as const);
  const restore = <T extends object, K extends keyof T>(target: T, key: K, value: T[K]) => {
    if (value === undefined) delete target[key];
    else target[key] = value;
  };
  return () => {
    for (const key of ["document", "window", "desktop"] as const)
      restore(globals, key, previous[key]);
    for (const [key, value] of environment) restore(process.env, key, value);
  };
}

test("desktop entries register IPC before window creation and render without awaiting the gateway", async () => {
  const ready = Promise.withResolvers<void>();
  const userData = mkdtempSync(join(tmpdir(), "desktop-entry-"));
  const handlers = new Map<string, () => GatewayEndpoint>();
  const events = new Map<string, () => void>();
  const windows: WindowDouble[] = [];
  const menus: number[] = [];
  const loaded: string[] = [];
  const order: string[] = [];
  const rendered: object[] = [];
  const element = {};
  const globals = globalThis as Globals;
  const restoreHost = snapshotHost(globals);
  let exposed: DesktopApi | undefined;

  class WindowDouble {
    constructor(
      readonly options: {
        titleBarStyle: string;
        backgroundColor: string;
        webPreferences: { contextIsolation: boolean; sandbox: boolean; nodeIntegration: boolean };
      },
    ) {
      expect(handlers.has(GATEWAY_CHANNEL)).toBe(true);
      windows.push(this);
    }
    readonly id = windows.length;
    readonly listeners = new Map<string, () => void>();
    readonly webContents = {
      setBackgroundThrottling: mock((_enabled: boolean) => undefined),
      openDevTools: mock((_options: { mode: string }) => undefined),
      on: () => undefined,
    };
    readonly once = (name: string, callback: () => void) => this.listeners.set(name, callback);
    readonly on = (name: string, callback: () => void) => this.listeners.set(name, callback);
    readonly show = mock(() => undefined);
    readonly isDestroyed = () => false;
    readonly isMinimized = () => false;
    readonly isMaximized = () => false;
    readonly getBounds = () => ({ x: 30, y: 40, width: 1200, height: 800 });
    loadURL(url: string): Promise<void> {
      loaded.push(url);
      return Promise.resolve();
    }
    static getFocusedWindow(): WindowDouble | null {
      return null;
    }
    loadFile(path: string): Promise<void> {
      loaded.push(path);
      ready.resolve();
      return Promise.resolve();
    }
    static getAllWindows(): WindowDouble[] {
      return windows;
    }
  }
  mock.module("electron", () => ({
    BrowserWindow: WindowDouble,
    app: {
      whenReady: () => Promise.resolve(),
      getPath: () => userData,
      on: (name: string, callback: () => void) => {
        events.set(name, callback);
      },
      quit: () => {
        order.push("quit");
      },
    },
    ipcMain: {
      handle: (channel: string, callback: () => GatewayEndpoint) => {
        handlers.set(channel, callback);
      },
      on: () => undefined,
    },
    nativeTheme: { shouldUseDarkColors: true },
    Menu: {
      buildFromTemplate: (template: object[]) => {
        order.push(`menu:${template.length}`);
        return { template };
      },
      setApplicationMenu: (menu: { template: object[] }) => {
        menus.push(menu.template.length);
      },
    },
    contextBridge: {
      exposeInMainWorld: (name: string, api: DesktopApi) => {
        expect(name).toBe("desktop");
        exposed = api;
        globals.desktop = api;
      },
    },
    ipcRenderer: {
      invoke: (channel: string): Promise<GatewayEndpoint | undefined> => {
        order.push("invoke");
        const handler = handlers.get(channel);
        if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
        return Promise.resolve(handler());
      },
    },
  }));
  mock.module("react-dom/client", () => ({
    createRoot: (container: object) => {
      expect(container).toBe(element);
      order.push("root");
      return {
        render: (node: object) => {
          rendered.push(node);
          order.push("render");
        },
      };
    },
  }));
  const listeners = {
    addEventListener: (_name: string) => undefined,
    removeEventListener: (_name: string) => undefined,
  };
  globals.window = { ...listeners, localStorage: {} };
  globals.document = {
    ...listeners,
    documentElement: { dataset: {} },
    getElementById: (id: string) => {
      expect(id).toBe("root");
      return element;
    },
  };
  process.env.ONI_WS_URL = "ws://127.0.0.1:43210/ws";
  process.env.ONI_WS_TOKEN = "entry-token";
  delete process.env.ELECTRON_RENDERER_URL;
  try {
    await import("../src/main");
    await ready.promise;
    expect(windows).toHaveLength(1);
    expect(windows[0]?.options.backgroundColor).toBe("#0A0A0C");
    expect(windows[0]?.options.webPreferences).toMatchObject({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    });
    expect(loaded[0]?.endsWith("/renderer/index.html")).toBe(true);
    const first = windows[0];
    if (!first) throw new Error("Main entry did not create a window");
    first?.listeners.get("ready-to-show")?.();
    expect(first?.show).toHaveBeenCalledTimes(1);
    expect(first?.webContents.setBackgroundThrottling).toHaveBeenCalledWith(true);
    jest.useFakeTimers();
    first?.listeners.get("move")?.();
    first?.listeners.get("resize")?.();
    jest.runAllTimers();
    expect(
      parseWindowBounds(readFileSync(join(userData, "window-bounds.json"), "utf8")),
    ).toMatchObject({
      width: 1200,
      height: 800,
    });
    first?.listeners.get("close")?.();
    jest.useRealTimers();
    expect(menus).toHaveLength(1);
    expect(menus[0]).toBeGreaterThan(0);
    events.get("activate")?.();
    expect(windows).toHaveLength(1);
    windows[0]?.listeners.get("closed")?.();
    windows.length = 0;
    // The env is resolved once at bootstrap (#1245): flipping variables after
    // startup must not switch a later window into dev mode or move the gateway.
    process.env.ELECTRON_RENDERER_URL = "http://localhost:5173";
    process.env.ONI_WS_URL = "ws://127.0.0.1:43211/ws";
    events.get("activate")?.();
    expect(windows).toHaveLength(1);
    expect(loaded.at(-1)?.endsWith("/renderer/index.html")).toBe(true);
    expect(windows[0]?.webContents.openDevTools).not.toHaveBeenCalled();
    await import("../src/preload");
    if (!exposed) throw new Error("Preload did not expose the desktop bridge");
    expect(await exposed.gateway()).toEqual({
      url: "ws://127.0.0.1:43210/ws",
      token: "entry-token",
    });
    order.length = 0;
    await import("../src/renderer/main");
    expect(order).toEqual(["root", "render"]);
    expect(rendered).toHaveLength(1);
    // The entry bound the host platform (#1245): a store mint reads its ids,
    // so the session id is a real `crypto.randomUUID` value, never a stub.
    const sessionId = createSession(0);
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  } finally {
    consoleStore.setState(() => INITIAL_CLIENT_STATE);
    bindStorePlatform(testPlatform);
    restoreHost();
    jest.useRealTimers();
    rmSync(userData, { recursive: true, force: true });
    mock.restore();
    mock.module("react-dom/client", () => realClient);
  }
}, 15_000);
