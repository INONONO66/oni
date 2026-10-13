import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Crypto, Effect } from "effect";
import { BunCrypto } from "../src/composition/cluster-crypto";
import {
  assertWsExposure,
  ConfigurationError,
  loadConfig,
  parseWsPort,
  resolveAlarmSweep,
  resolveSessionFork, resolveToolOutput,
  resolveClusterStorage,
  validateMachinePlane,
} from "../src/config";
import { startOpenOmni } from "../src";
import { runEffect } from "./helpers/effect";

const ENV_KEYS = [
  "DISCORD_BOT_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "GITHUB_WEBHOOK_SECRET",
  "OPENOMNI_CATALOG_PATH",
  "OPENOMNI_SESSIONS_DIR",
  "OPENOMNI_ENTITY_IDLE_MS",
  "OPENOMNI_ALARM_SWEEP_FULL",
  "OPENOMNI_ALARM_SWEEP_IDLE_DAYS",
  "OPENOMNI_FORK_COPY_BYTE_CAP",
  "OPENOMNI_TOOL_OUTPUT_BUDGET_BYTES",
  "OPENOMNI_WS_HOST",
  "OPENOMNI_WS_PORT",
  "OPENOMNI_WS_TOKEN",
  "OPENOMNI_MODEL_PROVIDER",
  "OPENOMNI_MODEL_ID",
  "OPENOMNI_MODEL_API_KEY",
  "OPENOMNI_MODEL_BASE_URL",
  "OPENOMNI_MODEL_HEADERS",
  "OPENOMNI_MODEL_FALLBACKS",
  "OPENOMNI_COMPACTION_SUMMARIZER",
  "OPENOMNI_SOCIAL_BUDGETS",
  "OPENOMNI_HOOKS_PATH",
  "OPENOMNI_MACHINES_DEFAULT",
  "OPENOMNI_MACHINES_ENROLLED",
  "OPENOMNI_MACHINES_SELF",
  "OPENOMNI_MACHINES_SOCKET",
  "OPENOMNI_MACHINES_TCP_HOST",
  "OPENOMNI_MACHINES_TCP_PORT",
  "OPENOMNI_MACHINES_TLS_CERT",
  "OPENOMNI_MACHINES_TLS_KEY",
  "OPENOMNI_CHANNEL_ALLOWED_SENDERS",
  "OPENOMNI_BUNDLES_OFF",
] as const;

let saved: Record<string, string | undefined>;

/** expect.objectContaining, typed as the value the partial shape matches. */
function containing<T extends object>(shape: Partial<T> & object): T {
  return expect.objectContaining(shape) as T;
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.OPENOMNI_MODEL_PROVIDER = "fake";
  process.env.OPENOMNI_MODEL_ID = "resident-test";
  process.env.OPENOMNI_MODEL_API_KEY = "test-key";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});


const selfEnv = JSON.stringify({
  capabilities: ["fs.read", "fs.write", "shell.exec"],
  exports: [{ name: "workspace", path: "/tmp/self-root" }],
});

describe("machines network listener config", () => {
  const enrolled = JSON.stringify([
    {
      machineId: "alpha",
      name: "the laptop",
      allowedCapabilities: ["fs.read"],
      publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      enrolledAt: 0,
    },
  ]);
  function tlsFiles() {
    const dir = mkdtempSync(join(tmpdir(), "om-config-tls-"));
    const cert = join(dir, "host-cert.pem");
    const key = join(dir, "host-key.pem");
    writeFileSync(cert, "CERT-PEM");
    writeFileSync(key, "KEY-PEM");
    return { dir, cert, key };
  }

  /** The complete, valid four-field tuple plus enrollment; tests then poke one field. */
  function setTcpTuple(cert: string, key: string, port = "7643"): void {
    process.env.OPENOMNI_MACHINES_SELF = selfEnv;
    process.env.OPENOMNI_MACHINES_ENROLLED = enrolled;
    process.env.OPENOMNI_MACHINES_TCP_HOST = "0.0.0.0";
    process.env.OPENOMNI_MACHINES_TCP_PORT = port;
    process.env.OPENOMNI_MACHINES_TLS_CERT = cert;
    process.env.OPENOMNI_MACHINES_TLS_KEY = key;
  }

  it("absent tcp env keeps a unix-only listener set", () => {
    process.env.OPENOMNI_MACHINES_SOCKET = "/tmp/machines-config-test.sock";
    process.env.OPENOMNI_MACHINES_SELF = selfEnv;
    process.env.OPENOMNI_MACHINES_ENROLLED = enrolled;
    const machines = loadConfig().machines;
    expect(machines?.listen).toEqual({ unix: "/tmp/machines-config-test.sock" });
    expect(machines?.tls).toBeUndefined();
  });

  it("the full tuple yields the tcp endpoint with the PEM contents read at boot", () => {
    const { dir, cert, key } = tlsFiles();
    try {
      setTcpTuple(cert, key);
      const machines = loadConfig().machines;
      expect(machines?.listen.tcp).toEqual({ host: "0.0.0.0", port: 7643 });
      expect(machines?.tls).toEqual({ certificate: "CERT-PEM", privateKey: "KEY-PEM" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    "OPENOMNI_MACHINES_TCP_HOST",
    "OPENOMNI_MACHINES_TCP_PORT",
    "OPENOMNI_MACHINES_TLS_CERT",
    "OPENOMNI_MACHINES_TLS_KEY",
  ])("a tuple missing %s fails closed rather than binding unencrypted", (missing) => {
    const { dir, cert, key } = tlsFiles();
    try {
      setTcpTuple(cert, key);
      delete process.env[missing];
      expect(() => loadConfig()).toThrow("must be set together");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a port outside 1-65535 and an unreadable PEM path", () => {
    const { dir, cert, key } = tlsFiles();
    try {
      setTcpTuple(cert, key, "70000");
      expect(() => loadConfig()).toThrow("OPENOMNI_MACHINES_TCP_PORT is invalid");
      process.env.OPENOMNI_MACHINES_TCP_PORT = "7643";
      process.env.OPENOMNI_MACHINES_TLS_CERT = join(dir, "missing.pem");
      expect(() => loadConfig()).toThrow("OPENOMNI_MACHINES_TLS_CERT is unreadable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("declared channel cutover", () => {
  it.each(["DISCORD_BOT_TOKEN", "TELEGRAM_BOT_TOKEN", "GITHUB_WEBHOOK_SECRET"])(
    "refuses legacy %s with the typed provisioning replacement",
    (key) => {
      process.env[key] = "legacy-secret";
      expect(loadConfig).toThrow(
        expect.objectContaining({
          name: "OpenOmniConfigurationError",
          data: containing({
            code: "legacy_channel_credentials",
            replacement: { tool: "provision", op: "channel_add" },
          }),
        }),
      );
    },
  );

  it("ignores blank legacy variables", () => {
    process.env.DISCORD_BOT_TOKEN = " ";
    process.env.TELEGRAM_BOT_TOKEN = "";
    expect(loadConfig().model.provider).toBe("fake");
  });

  // #1256: the hooks file path rides OPENOMNI_HOOKS_PATH; blank means absent.
  it("reads OPENOMNI_HOOKS_PATH and treats blank as absent", () => {
    process.env.OPENOMNI_HOOKS_PATH = " /etc/openomni/hooks.json ";
    expect(loadConfig().hooksPath).toBe("/etc/openomni/hooks.json");
    process.env.OPENOMNI_HOOKS_PATH = "  ";
    expect(loadConfig().hooksPath).toBeUndefined();
  });
});

describe("cluster storage config", () => {
  const home = "/tmp/openomni-config-test-home";
  const expectStorageDefaults = () => {
    const config = loadConfig(home);
    expect(config.catalogPath).toBe(join(home, ".openomni", "catalog.sqlite"));
    expect(config.sessionsDir).toBe(join(home, ".openomni", "sessions"));
    expect(config.entityIdleMs).toBe(60_000);
  };

  it("defaults the catalog file, sessions dir, and idle budget under the home", () => {
    expectStorageDefaults();
  });

  it("resolves injected partial configs through the same default owner", () => {
    const config = loadConfig(home);
    expect({
      catalogPath: config.catalogPath,
      sessionsDir: config.sessionsDir,
      entityIdleMs: config.entityIdleMs,
    }).toEqual(resolveClusterStorage({}, home));
    expect(
      resolveClusterStorage(
        { catalogPath: "/elsewhere/cat.sqlite", sessionsDir: "/elsewhere/sessions", entityIdleMs: 250 },
        home,
      ),
    ).toEqual({
      catalogPath: "/elsewhere/cat.sqlite",
      sessionsDir: "/elsewhere/sessions",
      entityIdleMs: 250,
    });
  });

  it("reads operator overrides from the environment", () => {
    process.env.OPENOMNI_CATALOG_PATH = "/var/omni/catalog.sqlite";
    process.env.OPENOMNI_SESSIONS_DIR = "/var/omni/sessions";
    process.env.OPENOMNI_ENTITY_IDLE_MS = "250";

    const config = loadConfig(home);

    expect(config.catalogPath).toBe("/var/omni/catalog.sqlite");
    expect(config.sessionsDir).toBe("/var/omni/sessions");
    expect(config.entityIdleMs).toBe(250);
  });

  it("treats whitespace-only overrides as unset", () => {
    process.env.OPENOMNI_CATALOG_PATH = "  ";
    process.env.OPENOMNI_SESSIONS_DIR = "";
    process.env.OPENOMNI_ENTITY_IDLE_MS = " ";

    expectStorageDefaults();
  });

  it.each(["0", "-5", "1.5", "not-ms"])(
    "refuses OPENOMNI_ENTITY_IDLE_MS=%p with a typed configuration code",
    (raw) => {
      process.env.OPENOMNI_ENTITY_IDLE_MS = raw;
      expect(() => loadConfig(home)).toThrow(
        expect.objectContaining({
          name: "OpenOmniConfigurationError",
          data: containing({ code: "invalid_entity_idle_ms" }),
        }),
      );
    },
  );

  // #1254 S3: the boot alarm sweep is config, not a core constant.
  it("reads the boot alarm sweep from the environment and defaults it off", () => {
    expect(loadConfig(home).alarmSweep).toBeUndefined();
    expect(resolveAlarmSweep(loadConfig(home))).toEqual({ full: false, idleDays: 7 });

    process.env.OPENOMNI_ALARM_SWEEP_FULL = "on";
    process.env.OPENOMNI_ALARM_SWEEP_IDLE_DAYS = "3";
    const config = loadConfig(home);
    expect(config.alarmSweep).toEqual({ full: true, idleDays: 3 });
    expect(resolveAlarmSweep(config)).toEqual({ full: true, idleDays: 3 });

    process.env.OPENOMNI_ALARM_SWEEP_FULL = "off";
    delete process.env.OPENOMNI_ALARM_SWEEP_IDLE_DAYS;
    expect(loadConfig(home).alarmSweep).toEqual({ full: false, idleDays: 7 });
  });

  // #1257 M-5: the fork copy cap is generation configuration, not a core constant.
  it("reads the fork copy byte cap from the environment and defaults it to 4 MiB", () => {
    expect(loadConfig(home).forkCopyByteCap).toBeUndefined();
    expect(resolveSessionFork(loadConfig(home))).toEqual({ copyByteCap: 4 * 1024 * 1024 });

    process.env.OPENOMNI_FORK_COPY_BYTE_CAP = "65536";
    const config = loadConfig(home);
    expect(config.forkCopyByteCap).toBe(65536);
    expect(resolveSessionFork(config)).toEqual({ copyByteCap: 65536 });
  });

  it.each([["0"], ["-1"], ["1.5"], ["lots"]])(
    "refuses OPENOMNI_FORK_COPY_BYTE_CAP=%s with the typed code",
    (raw) => {
      process.env.OPENOMNI_FORK_COPY_BYTE_CAP = raw;
      expect(() => loadConfig(home)).toThrow(
        expect.objectContaining({
          name: "OpenOmniConfigurationError",
          data: containing({ code: "invalid_fork_copy_byte_cap" }),
        }),
      );
    },
  );

  // #1305: the tool output budget is generation configuration, not a core constant.
  it("reads the tool output budget from the environment and leaves the core default when unset", () => {
    expect(loadConfig(home).toolOutputBudgetBytes).toBeUndefined();
    expect(resolveToolOutput(loadConfig(home))).toEqual({});

    process.env.OPENOMNI_TOOL_OUTPUT_BUDGET_BYTES = "200";
    const config = loadConfig(home);
    expect(config.toolOutputBudgetBytes).toBe(200);
    expect(resolveToolOutput(config)).toEqual({ budgetBytes: 200 });
  });

  it.each([["0"], ["-1"], ["1.5"], ["lots"]])(
    "refuses OPENOMNI_TOOL_OUTPUT_BUDGET_BYTES=%s with the typed code",
    (raw) => {
      process.env.OPENOMNI_TOOL_OUTPUT_BUDGET_BYTES = raw;
      expect(() => loadConfig(home)).toThrow(
        expect.objectContaining({
          name: "OpenOmniConfigurationError",
          data: containing({ code: "invalid_tool_output_budget_bytes" }),
        }),
      );
    },
  );

  it.each([
    ["OPENOMNI_ALARM_SWEEP_FULL", "yes"],
    ["OPENOMNI_ALARM_SWEEP_IDLE_DAYS", "0"],
    ["OPENOMNI_ALARM_SWEEP_IDLE_DAYS", "1.5"],
    ["OPENOMNI_ALARM_SWEEP_IDLE_DAYS", "soon"],
  ])("refuses %s=%p with a typed configuration code", (key, raw) => {
    process.env[key] = raw;
    expect(() => loadConfig(home)).toThrow(
      expect.objectContaining({
        name: "OpenOmniConfigurationError",
        data: containing({ code: "invalid_alarm_sweep" }),
      }),
    );
  });
});

describe("cluster crypto layer", () => {
  it("serves webcrypto random bytes and SHA-256 digests", async () => {
    const { bytes, digest } = await runEffect(
      Effect.gen(function* () {
        const service = yield* Crypto.Crypto;
        const randomBytes = yield* service.randomBytes(16);
        const hashed = yield* service.digest("SHA-256", new Uint8Array([1, 2, 3]));
        return { bytes: randomBytes, digest: hashed };
      }).pipe(Effect.provide(BunCrypto)),
    );

    expect(bytes).toHaveLength(16);
    expect(Buffer.from(digest).toString("hex")).toBe(
      "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
    );
  });
});

describe("compaction summarizer config", () => {
  it("defaults on and accepts only explicit off", () => {
    expect(loadConfig().compactionSummarizer).toBe(true);
    process.env.OPENOMNI_COMPACTION_SUMMARIZER = "off";
    expect(loadConfig().compactionSummarizer).toBe(false);
  });

  it("fails closed on unknown values with a typed configuration code", () => {
    process.env.OPENOMNI_COMPACTION_SUMMARIZER = "false";

    expect(loadConfig).toThrow(
      expect.objectContaining({
        name: "OpenOmniConfigurationError",
        data: containing({ code: "invalid_compaction_summarizer" }),
      }),
    );
  });
});

describe("ws port parsing", () => {
  it("is the single owner of the bound port, including the unset default", () => {
    expect(parseWsPort(undefined)).toBe(loadConfig().wsPort);
    process.env.OPENOMNI_WS_PORT = "4123";
    expect(loadConfig().wsPort).toBe(4123);
  });

  it("accepts 0 as the ephemeral bind the daemon honors", () => {
    process.env.OPENOMNI_WS_PORT = "0";
    expect(parseWsPort("0")).toBe(0);
    expect(loadConfig().wsPort).toBe(0);
  });

  it.each([
    "-1",
    "70000",
    "8080.5",
    "not-a-port",
  ])("refuses %p with a typed configuration code", (raw) => {
    expect(() => parseWsPort(raw)).toThrow(
      expect.objectContaining({
        name: "OpenOmniConfigurationError",
        data: containing({ code: "invalid_ws_port" }),
      }),
    );
  });
});

describe("ws exposure enforcement", () => {
  it("refuses a non-loopback host without an upgrade token", () => {
    expect(() => assertWsExposure({ host: "0.0.0.0" })).toThrow(
      "OPENOMNI_WS_TOKEN is required when OPENOMNI_WS_HOST is not loopback",
    );
    expect(() => assertWsExposure({ host: "0.0.0.0", wsToken: "" })).toThrow(
      "OPENOMNI_WS_TOKEN is required when OPENOMNI_WS_HOST is not loopback",
    );
  });

  it("refuses injected non-loopback config before binding", async () => {
    // `/dev/null/...` cannot be opened: if the refusal ever stopped preceding
    // the ledger and the bind, this would fail on that path instead.
    await expect(
      startOpenOmni({
        config: {
          catalogPath: "/dev/null/never-created.sqlite",
          host: "0.0.0.0",
          wsPort: 0,
          kek: { kind: "locked", reason: "no vault key in this fixture" },
          model: { provider: "fake", id: "resident-test", apiKey: "test-key" },
        },
      }),
    ).rejects.toThrow("OPENOMNI_WS_TOKEN is required when OPENOMNI_WS_HOST is not loopback");
  });

  it("accepts a non-loopback host once a token is set", () => {
    process.env.OPENOMNI_WS_HOST = "0.0.0.0";
    process.env.OPENOMNI_WS_TOKEN = "shared-secret";
    const config = loadConfig();
    expect(config.host).toBe("0.0.0.0");
    expect(config.wsToken).toBe("shared-secret");
  });

  it("allows loopback without a token and omits the field", () => {
    const config = loadConfig();
    expect(config.host).toBe("127.0.0.1");
    expect("wsToken" in config).toBe(false);
  });

  it("refuses a missing required model value", () => {
    delete process.env.OPENOMNI_MODEL_API_KEY;
    expect(() => loadConfig()).toThrow();
  });

  it("leaves the model transport overrides absent when unset", () => {
    const config = loadConfig();
    expect("baseUrl" in config.model).toBe(false);
    expect("headers" in config.model).toBe(false);
  });

  it("reads the operator's model base URL and headers", () => {
    process.env.OPENOMNI_MODEL_BASE_URL = "https://gateway.internal/v1";
    process.env.OPENOMNI_MODEL_HEADERS = JSON.stringify({
      "x-tenant": "acme",
      "user-agent": "acme-fleet/2",
    });

    const config = loadConfig();

    expect(config.model.baseUrl).toBe("https://gateway.internal/v1");
    expect(config.model.headers).toEqual({ "x-tenant": "acme", "user-agent": "acme-fleet/2" });
  });

  it("fails closed on malformed OPENOMNI_MODEL_HEADERS JSON", () => {
    process.env.OPENOMNI_MODEL_HEADERS = "{not json";

    expect(() => loadConfig()).toThrow("OPENOMNI_MODEL_HEADERS is invalid JSON");
  });

  it.each([
    { name: "a JSON array", value: JSON.stringify(["x-tenant", "acme"]) },
    { name: "a bare string", value: JSON.stringify("x-tenant: acme") },
    { name: "non-string header values", value: JSON.stringify({ "x-retries": 3 }) },
    { name: "an empty header name", value: JSON.stringify({ "": "acme" }) },
    {
      name: "a header name containing a CR/LF",
      value: JSON.stringify({ "x-bad\r\ninjected": "acme" }),
    },
    {
      name: "a header value containing a CR/LF",
      value: JSON.stringify({ "x-tenant": "acme\r\ninjected" }),
    },
  ])("fails closed on $name", ({ value }) => {
    process.env.OPENOMNI_MODEL_HEADERS = value;

    expect(() => loadConfig()).toThrow("OPENOMNI_MODEL_HEADERS is invalid");
  });

  it("leaves the fallback chain absent when unset", () => {
    expect(loadConfig().model.fallbacks).toBeUndefined();
  });

  it("reads a comma-separated provider/model fallback chain in order", () => {
    process.env.OPENOMNI_MODEL_FALLBACKS = "openai/gpt-5, anthropic/claude-x";

    expect(loadConfig().model.fallbacks).toEqual([
      { provider: "openai", id: "gpt-5" },
      { provider: "anthropic", id: "claude-x" },
    ]);
  });

  it("keeps a model id containing slashes intact — only the first slash splits", () => {
    process.env.OPENOMNI_MODEL_FALLBACKS = "openai/meta-llama/llama-4";

    expect(loadConfig().model.fallbacks).toEqual([
      { provider: "openai", id: "meta-llama/llama-4" },
    ]);
  });

  it.each([
    { name: "an entry with no provider separator", value: "gpt-5" },
    { name: "an empty provider segment", value: "/gpt-5" },
    { name: "an empty model segment", value: "openai/" },
    { name: "a blank entry between two valid ones", value: "openai/gpt-5,,anthropic/claude-x" },
    { name: "whitespace inside a segment", value: "open ai/gpt-5" },
    {
      name: "a provider absent from the bundled catalog",
      value: "definitely-unknown-provider/model",
    },
  ])("fails closed on $name", ({ value }) => {
    process.env.OPENOMNI_MODEL_FALLBACKS = value;

    expect(() => loadConfig()).toThrow("OPENOMNI_MODEL_FALLBACKS is invalid");
  });

  it("treats a whitespace-only value as unset rather than as an empty chain", () => {
    process.env.OPENOMNI_MODEL_FALLBACKS = "   ";

    expect(loadConfig().model.fallbacks).toBeUndefined();
  });

  it("reads the Owner's export allowlist off the enrollment", () => {
    process.env.OPENOMNI_MACHINES_SOCKET = "/tmp/machines-config-test.sock";
    process.env.OPENOMNI_MACHINES_SELF = selfEnv;
    process.env.OPENOMNI_MACHINES_ENROLLED = JSON.stringify([
      {
        machineId: "alpha",
        name: "the laptop",
        allowedCapabilities: ["fs.read"],
        allowedExports: ["notes", "src"],
        publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        enrolledAt: 0,
      },
    ]);

    expect(loadConfig().machines?.enrolled[0]?.allowedExports).toEqual(["notes", "src"]);
  });

  it("leaves the allowlist absent when the Owner named no export — no config, no reach", () => {
    process.env.OPENOMNI_MACHINES_SELF = selfEnv;
    process.env.OPENOMNI_MACHINES_ENROLLED = JSON.stringify([
      { machineId: "alpha", name: "the laptop", allowedCapabilities: ["fs.read"], publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", enrolledAt: 0 },
    ]);

    expect(loadConfig().machines?.enrolled[0]?.allowedExports).toBeUndefined();
  });

  it("refuses an enrollment whose export names collide or break the grammar", () => {
    process.env.OPENOMNI_MACHINES_SELF = selfEnv;
    process.env.OPENOMNI_MACHINES_ENROLLED = JSON.stringify([
      {
        machineId: "alpha",
        name: "the laptop",
        allowedCapabilities: ["fs.read"],
        allowedExports: ["notes", "notes"],
        publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        enrolledAt: 0,
      },
    ]);
    expect(loadConfig).toThrow(
      "OPENOMNI_MACHINES_ENROLLED is invalid: export names must be unique",
    );

    process.env.OPENOMNI_MACHINES_ENROLLED = JSON.stringify([
      {
        machineId: "alpha",
        name: "the laptop",
        allowedCapabilities: ["fs.read"],
        allowedExports: ["../escape"],
        publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        enrolledAt: 0,
      },
    ]);
    expect(loadConfig).toThrow(
      "OPENOMNI_MACHINES_ENROLLED is invalid: export name must be lowercase alphanumeric with - or _ (e.g. notes)",
    );
  });

  it("reads explicit social budgets while keeping the default absent", () => {
    expect(loadConfig().socialBudgets).toBeUndefined();
    process.env.OPENOMNI_SOCIAL_BUDGETS = JSON.stringify([
      {
        id: "budget:alice",
        targetActorId: "alice",
        maxPerWindow: 2,
        windowMs: 60_000,
        cooldownMs: 0,
      },
    ]);
    expect(loadConfig().socialBudgets).toEqual([
      {
        id: "budget:alice",
        targetActorId: "alice",
        maxPerWindow: 2,
        windowMs: 60_000,
        cooldownMs: 0,
      },
    ]);
  });

  it("reads per-surface sender allowlists, absent by default", () => {
    expect(loadConfig().channelAllowedSenders).toBeUndefined();
    process.env.OPENOMNI_CHANNEL_ALLOWED_SENDERS = JSON.stringify({ telegram: ["111"] });
    expect(loadConfig().channelAllowedSenders).toEqual({ telegram: ["111"] });
    process.env.OPENOMNI_CHANNEL_ALLOWED_SENDERS = "not-json";
    expect(() => loadConfig()).toThrow("OPENOMNI_CHANNEL_ALLOWED_SENDERS is invalid JSON");
  });
});

describe("machines self enrollment config (#1271)", () => {
  const selfExports = [{ name: "workspace", path: "/tmp/self-root" }];
  const enrolledAlpha = JSON.stringify([
    {
      machineId: "alpha",
      name: "the laptop",
      allowedCapabilities: ["fs.read"],
      publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      enrolledAt: 0,
    },
  ]);

  it("defaults the self id and the default machine to self", () => {
    process.env.OPENOMNI_MACHINES_SELF = selfEnv;
    const machines = loadConfig().machines;
    expect(machines?.self).toEqual({
      id: "self",
      capabilities: ["fs.read", "fs.write", "shell.exec"],
      exports: selfExports,
    });
    expect(machines?.default).toBeUndefined();
    expect(machines?.enrolled).toEqual([]);
    if (machines === undefined) throw new Error("machines plane expected");
    expect(validateMachinePlane(machines).defaultMachine).toBe("self");
  });

  it("the default machine follows an explicit self id", () => {
    process.env.OPENOMNI_MACHINES_SELF = JSON.stringify({
      id: "brain",
      capabilities: ["fs.read"],
      exports: selfExports,
    });
    const machines = loadConfig().machines;
    if (machines === undefined) throw new Error("machines plane expected");
    expect(validateMachinePlane(machines)).toEqual({
      self: { id: "brain", capabilities: ["fs.read"], exports: selfExports },
      defaultMachine: "brain",
    });
  });

  it("a configured plane without self is a typed refusal", () => {
    process.env.OPENOMNI_MACHINES_ENROLLED = enrolledAlpha;
    expect(loadConfig).toThrow(ConfigurationError);
    expect(loadConfig).toThrow(
      "OPENOMNI_MACHINES_SELF is required when the machine plane is configured",
    );
  });

  it.each([
    ["empty exports", { capabilities: ["fs.read"], exports: [] }],
    ["a relative export", { capabilities: ["fs.read"], exports: [{ name: "workspace", path: "relative/root" }] }],
    ["a duplicate export name", { capabilities: ["fs.read"], exports: [{ name: "workspace", path: "/a" }, { name: "workspace", path: "/b" }] }],
    ["duplicate capabilities", { capabilities: ["fs.read", "fs.read"], exports: [{ name: "workspace", path: "/a" }] }],
    ["no capabilities", { capabilities: [], exports: [{ name: "workspace", path: "/a" }] }],
  ])("refuses self with %s before boot", (_name, self) => {
    process.env.OPENOMNI_MACHINES_SELF = JSON.stringify(self);
    expect(loadConfig).toThrow(ConfigurationError);
    expect(loadConfig).toThrow("OPENOMNI_MACHINES_SELF is invalid");
  });

  it("rejects a self id colliding with an enrolled machine", () => {
    process.env.OPENOMNI_MACHINES_SELF = JSON.stringify({
      id: "alpha",
      capabilities: ["fs.read"],
      exports: selfExports,
    });
    process.env.OPENOMNI_MACHINES_ENROLLED = enrolledAlpha;
    expect(loadConfig).toThrow(ConfigurationError);
    expect(loadConfig).toThrow("machines ids must be unique: alpha");
  });

  it("rejects a default machine absent from the effective enrollments", () => {
    process.env.OPENOMNI_MACHINES_SELF = selfEnv;
    process.env.OPENOMNI_MACHINES_DEFAULT = "ghost";
    expect(loadConfig).toThrow(ConfigurationError);
    expect(loadConfig).toThrow("machines.default is not an enrolled machine: ghost");
  });

  it("accepts an enrolled machine as the default target", () => {
    process.env.OPENOMNI_MACHINES_SELF = selfEnv;
    process.env.OPENOMNI_MACHINES_ENROLLED = enrolledAlpha;
    process.env.OPENOMNI_MACHINES_DEFAULT = "alpha";
    const machines = loadConfig().machines;
    if (machines === undefined) throw new Error("machines plane expected");
    expect(machines.default).toBe("alpha");
    expect(validateMachinePlane(machines).defaultMachine).toBe("alpha");
  });
});

describe("off tuple (#1255, #1306)", () => {
  it("unset means absent: everything declared stays on", () => {
    expect(loadConfig().off).toBeUndefined();
  });

  it("parses the Owner's off names: bundles and capabilities ride one list", () => {
    process.env.OPENOMNI_BUNDLES_OFF = '["monitor","cron","hook","tool"]';
    expect(loadConfig().off).toEqual(["monitor", "cron", "hook", "tool"]);
  });

  it("keeps names the manifest never declared: compose ignores them, parsing does not", () => {
    process.env.OPENOMNI_BUNDLES_OFF = '["not-a-capability"]';
    expect(loadConfig().off).toEqual(["not-a-capability"]);
  });

  it("refuses the boot on malformed JSON or an empty name (fail-closed)", () => {
    process.env.OPENOMNI_BUNDLES_OFF = "monitor";
    expect(loadConfig).toThrow(ConfigurationError);
    expect(loadConfig).toThrow("OPENOMNI_BUNDLES_OFF is invalid JSON");
    process.env.OPENOMNI_BUNDLES_OFF = '[""]';
    expect(loadConfig).toThrow("OPENOMNI_BUNDLES_OFF is invalid");
  });
});
