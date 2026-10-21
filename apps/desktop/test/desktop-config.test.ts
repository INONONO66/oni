import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { resolveDesktopConfig, resolveGatewayEndpoint } from "../src/main/config";

/**
 * The main process is the only part of the desktop that may read the
 * environment, so the env-to-endpoint decision is pulled out of Electron and
 * asserted here as a pure function of a plain record.
 *
 * What has to be pinned is the FALLBACK, not the happy path: an explicit
 * `ONI_WS_URL` is trivially correct, while the derived loopback URL is a
 * copy of a default that lives in `apps/oni/src/config.ts` and would
 * otherwise drift silently the day the daemon moves off port 3000.
 */

describe("the gateway endpoint is resolved from the environment", () => {
  test("Given an explicit URL, When resolved, Then it is used verbatim", () => {
    // Verbatim including the path: an operator pointing the console at a
    // reverse proxy has already said where the socket is, and appending `/ws`
    // to their answer would silently rewrite it.
    expect(resolveGatewayEndpoint({ ONI_WS_URL: "wss://gateway.example/socket" })).toEqual({
      url: "wss://gateway.example/socket",
    });
  });

  test("Given no URL but a port, When resolved, Then loopback carries that port", () => {
    expect(resolveGatewayEndpoint({ ONI_WS_PORT: "4100" })).toEqual({
      url: "ws://127.0.0.1:4100/ws",
    });
  });

  test("Given neither URL nor port, When resolved, Then the daemon's default port is used", () => {
    // 3000 is `parseWsPort`'s default in apps/oni/src/config.ts. The
    // literal is copied rather than imported (the desktop topology forbids the
    // dependency), so this assertion is the copy's only alarm.
    expect(resolveGatewayEndpoint({})).toEqual({ url: "ws://127.0.0.1:3000/ws" });
  });

  test("Given a token, When resolved, Then it rides alongside the url", () => {
    expect(resolveGatewayEndpoint({ ONI_WS_TOKEN: "s3cret" })).toEqual({
      url: "ws://127.0.0.1:3000/ws",
      token: "s3cret",
    });
  });

  test("Given no token, When resolved, Then the key is absent rather than empty", () => {
    // `exactOptionalPropertyTypes` is on, and an empty-string token would be
    // offered to the gateway as a real credential and rejected.
    expect("token" in resolveGatewayEndpoint({ ONI_WS_TOKEN: "  " })).toBe(false);
    expect("token" in resolveGatewayEndpoint({})).toBe(false);
  });

  test("Given padded values, When resolved, Then they are trimmed before use", () => {
    expect(
      resolveGatewayEndpoint({ ONI_WS_URL: "  ws://host:9/ws  ", ONI_WS_TOKEN: " t " }),
    ).toEqual({ url: "ws://host:9/ws", token: "t" });
  });

  test("Given a blank URL, When resolved, Then the loopback fallback still applies", () => {
    // An exported-but-empty variable is the shape a shell script produces with
    // `export ONI_WS_URL=`; treating it as a URL would connect to nothing.
    expect(resolveGatewayEndpoint({ ONI_WS_URL: "   ", ONI_WS_PORT: "" })).toEqual({
      url: "ws://127.0.0.1:3000/ws",
    });
  });

  test("Given an unusable port, When resolved, Then a typed error names the variable (#1312)", () => {
    // A present-but-invalid value is a typed refusal, never a silent 3000: a
    // typo in ONI_WS_PORT must fail at the variable, not connect the
    // console to a port nobody asked for. Only unset (or blank) means default.
    for (const port of ["-1", "70000", "8080abc", "80.5", "abc"]) {
      expect(resolveGatewayEndpoint({ ONI_WS_PORT: port })).toEqual({
        kind: "desktop_config_error",
        variable: "ONI_WS_PORT",
        value: port,
        message: `ONI_WS_PORT is not a port: "${port}" (expected an integer in 0..65535; unset means 3000)`,
      });
    }
  });

  test("Given an explicit URL and an invalid port, When resolved, Then the URL wins and the port is never read", () => {
    expect(
      resolveGatewayEndpoint({ ONI_WS_URL: "ws://host:9/ws", ONI_WS_PORT: "abc" }),
    ).toEqual({ url: "ws://host:9/ws" });
  });

  test("Given an invalid port, When the whole config resolves, Then the error propagates (#1312)", () => {
    expect(resolveDesktopConfig({ ONI_WS_PORT: "70000" })).toMatchObject({
      kind: "desktop_config_error",
      variable: "ONI_WS_PORT",
    });
  });
});

describe("the desktop config is resolved once from an explicit env record (#1245)", () => {
  test("Given a full record, When resolved, Then gateway and dev URL come out typed", () => {
    expect(
      resolveDesktopConfig({
        ONI_WS_URL: "ws://host:9/ws",
        ONI_WS_TOKEN: "t",
        ELECTRON_RENDERER_URL: "http://localhost:5173",
      }),
    ).toEqual({
      gateway: { url: "ws://host:9/ws", token: "t" },
      rendererDevUrl: "http://localhost:5173",
    });
  });

  test("Given an empty record, When resolved, Then defaults apply and dev mode is off", () => {
    const config = resolveDesktopConfig({});
    expect(config).toEqual({ gateway: { url: "ws://127.0.0.1:3000/ws" } });
    expect("rendererDevUrl" in config).toBe(false);
  });

  test("Given a blank renderer URL, When resolved, Then the key is absent rather than empty", () => {
    expect("rendererDevUrl" in resolveDesktopConfig({ ELECTRON_RENDERER_URL: "   " })).toBe(false);
  });
});

describe("the desktop source keeps its environment and runtime boundaries (#1245)", () => {
  test("Given src/, When scanned, Then no file reads process.env and none imports effect", async () => {
    const root = join(import.meta.dirname, "../src");
    const envOffenders: string[] = [];
    const effectOffenders: string[] = [];
    for await (const file of new Glob("**/*.{ts,tsx}").scan({ cwd: root })) {
      const text = readFileSync(join(root, file), "utf-8");
      if (text.includes("process.env")) envOffenders.push(file);
      if (/from\s+"effect"/.test(text)) effectOffenders.push(file);
    }
    expect(envOffenders.toSorted()).toEqual([]);
    expect(effectOffenders.toSorted()).toEqual([]);
  });
});
