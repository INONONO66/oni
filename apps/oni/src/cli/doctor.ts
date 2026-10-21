import { Result } from "effect";
import { z } from "zod";
import { assertDeclaredChannelConfig, ConfigurationError, parseWsPort } from "../config";

/** The one failure shape the config gates throw; zod is the narrowing layer for the caught value. */
const ConfigThrown = z.custom<ConfigurationError>(ConfigurationError.isInstance);

/**
 * Read-only diagnostics. Every fact arrives through `DoctorPorts` so the
 * verdict mapping is deterministic and testable; the CLI wires real probes.
 */
export interface DoctorPorts {
  readonly bunVersion: string;
  readonly envFilePresent: boolean;
  /** Effective config: env file merged under process-env overrides. */
  readonly effectiveEnv: ReadonlyMap<string, string>;
  readonly unitInstalled: boolean;
  readonly daemonActive: boolean;
  /** Linger state on systemd hosts; undefined = not applicable (launchd). */
  readonly lingerEnabled: boolean | undefined;
  readonly probeHealth: (port: number) => Promise<boolean>;
}

export interface DoctorCheck {
  readonly name: string;
  readonly status: "pass" | "warn" | "fail";
  readonly detail: string;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  readonly ok: boolean;
}

const REQUIRED_KEYS = [
  "ONI_MODEL_PROVIDER",
  "ONI_MODEL_ID",
  "ONI_MODEL_API_KEY",
] as const;

/**
 * The daemon binds whatever `parseWsPort` returns, so the probe asks that
 * one owner instead of deriving a port `start` would never have used.
 */
async function healthCheck(ports: DoctorPorts): Promise<DoctorCheck> {
  const port = Result.try({
    try: () => parseWsPort(ports.effectiveEnv.get("ONI_WS_PORT")),
    catch: ConfigThrown.parse,
  });
  if (Result.isFailure(port)) {
    // A value that would make `start` throw is the operator's real problem;
    // probing some substituted port would hide that boot failure.
    return { name: "health", status: "fail", detail: port.failure.data.message };
  }
  if (port.success === 0) {
    // An ephemeral bind has no port known before the daemon picks one;
    // guessing one resurrects the false failure this check exists to avoid.
    return {
      name: "health",
      status: "warn",
      detail: "ephemeral WS port (ONI_WS_PORT=0) — health probe skipped",
    };
  }
  const url = `http://127.0.0.1:${port.success}/health`;
  if (await ports.probeHealth(port.success))
    return { name: "health", status: "pass", detail: `${url} ok` };
  return {
    name: "health",
    status: ports.daemonActive ? "fail" : "warn",
    detail: `no response on ${url}`,
  };
}

export async function runDoctor(ports: DoctorPorts): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [{ name: "bun", status: "pass", detail: ports.bunVersion }];

  checks.push(
    ports.envFilePresent
      ? { name: "env file", status: "pass", detail: "present" }
      : {
          name: "env file",
          status: "warn",
          detail: "missing — exported environment only (run `oni onboard` to create one)",
        },
  );
  // A blank value fails startup exactly like a missing one.
  const missing = REQUIRED_KEYS.filter(
    (key) => (ports.effectiveEnv.get(key) ?? "").trim().length === 0,
  );
  checks.push(
    missing.length === 0
      ? { name: "model config", status: "pass", detail: "provider, id, and API key set" }
      : { name: "model config", status: "fail", detail: `missing ${missing.join(", ")}` },
  );

  const channelConfig = Result.try({
    try: () => assertDeclaredChannelConfig(Object.fromEntries(ports.effectiveEnv)),
    catch: ConfigThrown.parse,
  });
  if (Result.isFailure(channelConfig)) {
    checks.push({ name: "channel config", status: "fail", detail: channelConfig.failure.data.message });
  }

  if (ports.unitInstalled) {
    checks.push(
      ports.daemonActive
        ? { name: "daemon", status: "pass", detail: "active" }
        : { name: "daemon", status: "fail", detail: "installed but not active" },
    );
    if (ports.lingerEnabled === false) {
      checks.push({
        name: "linger",
        status: "warn",
        detail: "disabled — daemon dies at logout; run `loginctl enable-linger`",
      });
    }
  } else {
    checks.push({
      name: "daemon",
      status: "warn",
      detail: "not installed — run `oni daemon install`",
    });
  }

  checks.push(await healthCheck(ports));

  return { checks, ok: checks.every((check) => check.status !== "fail") };
}
