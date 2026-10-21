import { expect, mock, spyOn, test } from "bun:test";
import { runIsolated } from "./helpers/isolated-entry";

/**
 * #1312: an invalid `ONI_WS_PORT` is a typed configuration error, and the
 * main process REFUSES on it — no window opens on a guessed port 3000. The
 * manual check in the issue ("run the desktop with ONI_WS_PORT=abc; the
 * window does not open and main prints the error naming the variable") is
 * pinned here against the bootstrap path itself.
 */
test("an invalid ONI_WS_PORT quits before any window opens and names the variable", async () => {
  if (process.env.ONI_CONFIG_ERROR_CHILD !== "1") {
    await runIsolated(import.meta.path, { ONI_CONFIG_ERROR_CHILD: "1" });
    return;
  }

  let constructed = 0;
  let readied = 0;
  let quits = 0;
  const error = spyOn(console, "error").mockImplementation(() => undefined);
  const previousPort = process.env.ONI_WS_PORT;
  const previousUrl = process.env.ONI_WS_URL;

  class WindowDouble {
    constructor() {
      constructed += 1;
    }
  }
  mock.module("electron", () => ({
    BrowserWindow: WindowDouble,
    app: {
      whenReady: () => {
        readied += 1;
        return Promise.resolve();
      },
      getPath: () => "/tmp",
      on: () => undefined,
      quit: () => {
        quits += 1;
      },
      commandLine: { appendSwitch: () => undefined },
    },
    ipcMain: { handle: () => undefined, on: () => undefined },
    nativeTheme: { shouldUseDarkColors: true },
    Menu: {
      buildFromTemplate: (template: object[]) => template,
      setApplicationMenu: () => undefined,
    },
  }));
  process.env.ONI_WS_PORT = "abc";
  delete process.env.ONI_WS_URL;
  try {
    await import("../src/main/index");
    expect(constructed).toBe(0);
    expect(readied).toBe(0);
    expect(quits).toBe(1);
    expect(error).toHaveBeenCalledTimes(1);
    const printed = String(error.mock.calls[0]?.[0]);
    expect(printed).toContain("ONI_WS_PORT");
    expect(printed).toContain('"abc"');
  } finally {
    error.mockRestore();
    if (previousPort === undefined) delete process.env.ONI_WS_PORT;
    else process.env.ONI_WS_PORT = previousPort;
    if (previousUrl === undefined) delete process.env.ONI_WS_URL;
    else process.env.ONI_WS_URL = previousUrl;
    mock.restore();
  }
}, 15_000);
