import { describe, expect, test } from "bun:test";
import { GATEWAY_CHANNEL, type DesktopApi, type GatewayEndpoint } from "../src/preload/api";

describe("DesktopApi contract", () => {
  test("versions carry the three runtime identifiers", () => {
    const api: DesktopApi = {
      versions: { electron: "1", chrome: "2", node: "3" },
      gateway: () => Promise.resolve(undefined),
      onShellCommand: () => () => undefined,
      closeWindow: () => undefined,
    };
    expect(Object.keys(api.versions).sort()).toEqual(["chrome", "electron", "node"]);
  });

  test("Given the api, When the renderer asks for the gateway, Then it gets an endpoint or nothing", async () => {
    // `undefined` is a real answer, not a failure: it is how a build with no
    // gateway configured tells the renderer to keep its composer disabled.
    const configured: DesktopApi = {
      versions: { electron: "1", chrome: "2", node: "3" },
      gateway: () => Promise.resolve<GatewayEndpoint>({ url: "ws://127.0.0.1:3000/ws" }),
      onShellCommand: () => () => undefined,
      closeWindow: () => undefined,
    };
    expect(await configured.gateway()).toEqual({ url: "ws://127.0.0.1:3000/ws" });
  });

  test("Given the ipc channel name, When read, Then both sides share one literal", () => {
    // `ipcMain.handle` and `ipcRenderer.invoke` are in two different bundles and
    // two different processes; a typo in either is a promise that never
    // settles, so the string is declared once in the leaf both import.
    expect(GATEWAY_CHANNEL).toBe("oni:gateway");
  });
});
