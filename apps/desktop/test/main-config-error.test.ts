import { expect, mock, spyOn, test } from "bun:test";

/** An invalid port refuses boot before creating a window. */
test("an invalid OPENOMNI_WS_PORT quits before any window opens and names the variable", async () => {
  if (process.env.OPENOMNI_CONFIG_ERROR_CHILD !== "1") {
    const proc = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, OPENOMNI_CONFIG_ERROR_CHILD: "1" },
      stderr: "pipe",
      stdout: "pipe",
    });
    const exit = await proc.exited;
    if (exit !== 0) throw new Error(await new Response(proc.stderr).text());
    expect(exit).toBe(0);
    return;
  }

  let constructed = 0;
  let readied = 0;
  let quits = 0;
  const error = spyOn(console, "error").mockImplementation(() => undefined);
  const previousPort = process.env.OPENOMNI_WS_PORT;
  const previousUrl = process.env.OPENOMNI_WS_URL;

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
  process.env.OPENOMNI_WS_PORT = "abc";
  delete process.env.OPENOMNI_WS_URL;
  try {
    await import("../src/main/index");
    expect(constructed).toBe(0);
    expect(readied).toBe(0);
    expect(quits).toBe(1);
    expect(error).toHaveBeenCalledTimes(1);
    const printed = String(error.mock.calls[0]?.[0]);
    expect(printed).toContain("OPENOMNI_WS_PORT");
    expect(printed).toContain('"abc"');
  } finally {
    error.mockRestore();
    if (previousPort === undefined) delete process.env.OPENOMNI_WS_PORT;
    else process.env.OPENOMNI_WS_PORT = previousPort;
    if (previousUrl === undefined) delete process.env.OPENOMNI_WS_URL;
    else process.env.OPENOMNI_WS_URL = previousUrl;
    mock.restore();
  }
}, 15_000);
