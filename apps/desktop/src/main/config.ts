/**
 * The desktop main process's one environment resolution (#1245): the Electron
 * entry passes the host process object once (`bootstrap(process)`), this
 * module resolves every variable the shell consumes, and no other desktop
 * file reads the environment.
 */

interface GatewayEndpoint {
  readonly url: string;
  readonly token?: string;
}

// Copied literal from apps/oni/src/config.ts (`parseWsPort` default):
// the console must not import the kernel app, so the default port lives here
// as a named copy of its source.
const DEFAULT_WS_PORT = 3000;

// Copied literal from apps/oni/src/index.ts (the daemon's websocket
// upgrade path): same no-kernel-import reason as the port default above.
const GATEWAY_PATH = "/ws";

/**
 * The env this reads, as a plain record (the ambient environment's shape), so
 * a test needs no ambient process. Consumed keys: ONI_WS_URL,
 * ONI_WS_PORT, ONI_WS_TOKEN, ELECTRON_RENDERER_URL.
 */
export type DesktopEnv = Readonly<Record<string, string | undefined>>;

/** Trimmed, or absent — `export FOO=` yields an empty string, not an unset var. */
function read(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/**
 * A configuration the main process refuses to boot on (#1312). A plain tagged
 * object — the desktop imports no Effect — carried to `bootstrap`, which
 * prints `message` and quits instead of opening a window on a guessed port.
 */
export interface DesktopConfigError {
  readonly kind: "desktop_config_error";
  readonly variable: "ONI_WS_PORT";
  readonly value: string;
  readonly message: string;
}

/**
 * An unset (or blank) port still means the daemon default; a PRESENT invalid
 * value is a typed error, never a silent 3000 (#1312) — a typo in
 * `ONI_WS_PORT` must fail at the variable, not connect somewhere else.
 */
function port(raw: string | undefined): number | DesktopConfigError {
  const value = read(raw);
  if (value === undefined) return DEFAULT_WS_PORT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    return {
      kind: "desktop_config_error",
      variable: "ONI_WS_PORT",
      value,
      message: `ONI_WS_PORT is not a port: "${value}" (expected an integer in 0..65535; unset means ${DEFAULT_WS_PORT})`,
    };
  }
  return parsed;
}

export function resolveGatewayEndpoint(env: DesktopEnv): GatewayEndpoint | DesktopConfigError {
  const explicit = read(env.ONI_WS_URL);
  let url: string;
  if (explicit === undefined) {
    const resolved = port(env.ONI_WS_PORT);
    if (typeof resolved !== "number") return resolved;
    url = `ws://127.0.0.1:${resolved}${GATEWAY_PATH}`;
  } else {
    // An explicit URL wins outright: the port variable is never read, so an
    // invalid value next to a good URL is not an error.
    url = explicit;
  }
  const token = read(env.ONI_WS_TOKEN);
  return token === undefined ? { url } : { url, token };
}

export interface DesktopConfig {
  readonly gateway: GatewayEndpoint;
  /** electron-vite's dev-server URL; presence switches the shell into development mode. */
  readonly rendererDevUrl?: string;
}

export function resolveDesktopConfig(env: DesktopEnv): DesktopConfig | DesktopConfigError {
  const gateway = resolveGatewayEndpoint(env);
  if ("kind" in gateway) return gateway;
  const rendererDevUrl = read(env.ELECTRON_RENDERER_URL);
  return {
    gateway,
    ...(rendererDevUrl === undefined ? {} : { rendererDevUrl }),
  };
}
