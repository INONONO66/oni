import { expect, mock, test } from "bun:test";
import { resolveDesktopConfig } from "../src/main/config";

test("window decisions preserve the pinned gateway, chrome, security, and renderer target", async () => {
  const ready = Promise.withResolvers<void>();
  mock.module("electron", () => ({
    BrowserWindow: class {},
    Menu: {},
    ipcMain: {},
    nativeTheme: { shouldUseDarkColors: true },
    app: {
      whenReady: () => ready.promise,
      on: () => undefined,
      commandLine: { appendSwitch: () => undefined },
    },
  }));
  const previousPort = process.env.OPENOMNI_WS_PORT;
  delete process.env.OPENOMNI_WS_PORT;
  try {
    const instance: string = "../src/main/index?window-decisions";
    const { rendererTarget, windowOptions } = (await import(instance)) as typeof import("../src/main/index");
    const config = resolveDesktopConfig({
      OPENOMNI_WS_PORT: "4321",
      OPENOMNI_WS_TOKEN: "pinned",
      ELECTRON_RENDERER_URL: "http://localhost:5173",
    });
    expect(config).toEqual({
      gateway: { url: "ws://127.0.0.1:4321/ws", token: "pinned" },
      rendererDevUrl: "http://localhost:5173",
    });
    if ("kind" in config) throw new Error("expected resolved gateway");
    const file = "/app/renderer/index.html";
    expect(rendererTarget(config.rendererDevUrl, file)).toEqual({
      kind: "url",
      target: "http://localhost:5173",
    });
    expect(rendererTarget(undefined, file)).toEqual({ kind: "file", target: file });
    const bounds = { x: 10, y: 20, width: 900, height: 700 };
    const preload = "/app/preload/index.cjs";
    expect(windowOptions(bounds, true, preload)).toEqual({
      ...bounds,
      minWidth: 400,
      minHeight: 600,
      show: false,
      backgroundColor: "#0A0A0C",
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 17, y: 14 },
      webPreferences: {
        preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    expect(windowOptions({ width: 1280, height: 800 }, false, preload)).toMatchObject({
      width: 1280,
      height: 800,
      backgroundColor: "#EFEFF0",
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
  } finally {
    if (previousPort === undefined) delete process.env.OPENOMNI_WS_PORT;
    else process.env.OPENOMNI_WS_PORT = previousPort;
    mock.restore();
  }
});
