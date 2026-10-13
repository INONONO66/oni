import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Actor, Gateway, Machine, NamedError, type Model, type PlainValue } from "@openomni/protocol";
import { type KekResolution, resolveKek } from "./provisioning/vault-key";
import { Result } from "effect";
import { z } from "zod";

export const ConfigurationError = NamedError.create(
  "OpenOmniConfigurationError",
  z.object({
    code: z.enum([
      "invalid_compaction_summarizer",
      "invalid_alarm_sweep",
      "invalid_entity_idle_ms",
      "invalid_env_json",
      "invalid_fork_copy_byte_cap",
      "invalid_machines_default",
      "invalid_machines_self",
      "invalid_machines_tcp",
      "invalid_model_fallbacks",
      "invalid_tool_output_budget_bytes",
      "invalid_ws_port",
      // #1271 r1 M4: the machine plane is not optional — a boot without a
      // `machines` block refuses before any listener exists.
      "machines_required",
      "legacy_channel_credentials",
      "missing_env",
      "ws_token_required",
    ]),
    message: z.string(),
    replacement: z.object({ tool: z.literal("provision"), op: z.literal("channel_add") }).optional(),
  }),
);
export type ConfigurationError = InstanceType<typeof ConfigurationError>;

export interface OpenOmniConfig {
  /**
   * Cluster catalog SQLite file: the session index, actor/grant/policy rows,
   * and the cluster_* mailbox tables.
   */
  readonly catalogPath?: string;
  /** Directory of per-session ledger files (`<sessionsDir>/<sessionId>.sqlite`). */
  readonly sessionsDir?: string;
  /** Milliseconds of mailbox silence before a session entity passivates. */
  readonly entityIdleMs?: number;
  /** Boot alarm sweep (#1254 S3): full rescan toggle and the idle-days floor. */
  readonly alarmSweep?: { readonly full: boolean; readonly idleDays: number };
  /** Fork copy cap in bytes (#1257): refuse forks copying more than this. */
  readonly forkCopyByteCap?: number;
  /** Tool output budget in bytes (#1305): project larger results to stored refs. */
  readonly toolOutputBudgetBytes?: number;
  readonly host: string;
  readonly wsPort: number;
  /** Enabled unless explicitly disabled with OPENOMNI_COMPACTION_SUMMARIZER=off. */
  readonly compactionSummarizer?: boolean;
  /** Required for non-loopback hosts; every ws sender is granted owner tier. */
  readonly wsToken?: string;
  /**
   * The vault key-encryption-key, resolved exactly once at config time
   * (#1245): boot wiring and declared provisioning receive this resolution
   * as an argument and never read the environment themselves.
   */
  readonly kek: KekResolution;
  readonly model: {
    readonly provider: string;
    readonly id: string;
    readonly apiKey: string;
    /**
     * Operator-chosen provider endpoint, replacing the models.dev catalog's.
     * Absent keeps the catalog URL.
     */
    readonly baseUrl?: string;
    /**
     * Operator-chosen request headers for every model call (tenant routing,
     * gateway auth, a fleet user-agent). Absent sends only this client's own
     * identity, which any entry here overrides by name.
     */
    readonly headers?: Readonly<Record<string, string>>;
    /**
     * Ordered models tried AFTER `id` when a run's failures advance the
     * chain (the agent loop's `modelFallbacks`). Absent means every attempt
     * uses the primary.
     */
    readonly fallbacks?: readonly Model.Ref[];
  };
  /**
   * Absent means this brain has no body: no socket is bound and machine-backed
   * tools refuse fail-closed. Present requires `self`, because the boot chain
   * attaches the host's own in-process daemon before any tool port exists.
   */
  readonly machines?: {
    /**
     * The application host's own machine (#1271): the Owner-bounded
     * capabilities and the mandatory absolute export roots the in-process
     * daemon may expose. Boot attaches this machine over loopback before any
     * tool port exists; there is no local filesystem or shell path beside it.
     */
    readonly self: {
      /** Defaults to "self". */
      readonly id?: string;
      readonly capabilities: readonly string[];
      readonly exports: readonly { readonly name: string; readonly path: string }[];
    };
    /** The machine a prefix-less path resolves to; defaults to the self id. */
    readonly default?: string;
    /**
     * Where the host accepts daemons. Unix is always bound (same-box daemons
     * stay zero-config); tcp appears only when the Owner configured the full
     * network tuple, because a network listener without TLS is a non-option.
     */
    readonly listen: {
      readonly unix: string;
      readonly tcp?: { readonly host: string; readonly port: number };
    };
    /** Host TLS identity (PEM contents, read at boot) — present iff tcp is. */
    readonly tls?: { readonly certificate: string; readonly privateKey: string };
    readonly enrolled: readonly Machine.Enrollment[];
  };
  /**
   * External actors the Owner has admitted as delegation targets. Absent
   * means the channel transport has nobody to reach: sends are denied
   * ungranted rather than the driver being unwired.
   */
  readonly actors?: readonly RegisteredActor[];
  /** Owner-declared allowances for cold proactive sends; absent denies all. */
  readonly socialBudgets?: readonly Gateway.SocialBudget[];
  /**
   * Names the Owner turns off (#1255, #1306): the manifest's `off` list.
   * One key, one meaning — it accepts bundle names (`monitor`, `cron`) and
   * capability names (`alarm`, `action`, `hook`, `compaction`, `tool`)
   * alike; compose owns the cascade semantics and ignores names the
   * manifest never declared. Absent means everything declared is on.
   */
  readonly off?: readonly string[];
  /**
   * Path of the Owner's hooks JSON file (#1256, `OPENOMNI_HOOKS_PATH`).
   * Absent composes the hooks-json bundle with zero rows. The file is read
   * and validated at compose time; any refusal fails the boot fail-closed.
   */
  readonly hooksPath?: string;
  /**
   * Per-surface sender allowlists for the trusted-channel grant (external
   * ids on that surface, e.g. Telegram user ids). A surface listed here
   * serves only the listed senders; everyone else finds no grant and the
   * perimeter blocks fail-closed. A surface absent from the map keeps the
   * open posture — acceptable only for loopback-bound surfaces like ws.
   */
  readonly channelAllowedSenders?: Readonly<Record<string, readonly string[]>>;
}

export interface RegisteredActor {
  readonly actorId: string;
  /** The identity the actor's connection declares (`?actor=<externalId>`). */
  readonly externalId: string;
  /** The configured delivery surface; existing configs remain WebSocket actors. */
  readonly channel?: "ws" | "discord" | "telegram";
  readonly trustTier: Actor.TrustTier;
  readonly kind: Actor.Kind;
  readonly displayName?: string;
}

/**
 * The operator's transport config in the shape the agent and llm packages
 * take, or absent when the operator configured neither. One owner for the
 * translation, so every call site (Resident, child loop, process child, the
 * llm tool) sends the same thing.
 */
export function modelTransport(
  model: OpenOmniConfig["model"],
): { baseUrl?: string; headers?: Record<string, string> } | undefined {
  if (model.baseUrl === undefined && model.headers === undefined) return undefined;
  return {
    ...(model.baseUrl === undefined ? {} : { baseUrl: model.baseUrl }),
    ...(model.headers === undefined ? {} : { headers: { ...model.headers } }),
  };
}

function required(name: string, env: Record<string, string | undefined>): string {
  const value = env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new ConfigurationError({ code: "missing_env", message: `${name} is required` });
  }
  return value;
}

/**
 * The one parser for `OPENOMNI_WS_PORT`: `startOpenOmni` binds what this
 * returns, so every other reader (doctor's health probe) must ask here
 * rather than re-deriving a port the daemon never bound. `0` is a legal
 * ephemeral bind, and an unset value resolves to the same default the
 * daemon uses — the default has no second home.
 */
export function parseWsPort(raw: string | undefined): number {
  if (raw === undefined) return 3000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ConfigurationError({
      code: "invalid_ws_port",
      message: "OPENOMNI_WS_PORT must be an integer from 0 to 65535",
    });
  }
  return port;
}

/** Entity passivation default: 60 s of mailbox silence before the session sleeps. */
const DEFAULT_ENTITY_IDLE_MS = 60_000;

/** The cluster plane's storage roots and idle budget, fully resolved. */
export interface ClusterStorageConfig {
  readonly catalogPath: string;
  readonly sessionsDir: string;
  readonly entityIdleMs: number;
}

/**
 * The one owner of the cluster storage defaults: `loadConfig` resolves env
 * input through this, and injected configs resolve their partial values
 * through the same function, so the defaults have no second home.
 */
export function resolveClusterStorage(
  config: Pick<OpenOmniConfig, "catalogPath" | "sessionsDir" | "entityIdleMs">,
  home: string = homedir(),
): ClusterStorageConfig {
  return {
    catalogPath: config.catalogPath ?? join(home, ".openomni", "catalog.sqlite"),
    sessionsDir: config.sessionsDir ?? join(home, ".openomni", "sessions"),
    entityIdleMs: config.entityIdleMs ?? DEFAULT_ENTITY_IDLE_MS,
  };
}

/** Boot alarm sweep defaults (#1254 S3): flagged sessions only, 7 idle days. */
const DEFAULT_ALARM_SWEEP = { full: false, idleDays: 7 } as const;

/**
 * D3 loop consumption defaults (#1254 S4): at most 4 alarm wakes admit before
 * a queued prompt, 64 armed alarms per session, and passivation after the
 * entity idle budget. Typed in core (`Core.AlarmDrainConfig`); the VALUES live
 * here, at the composition root, and nowhere else.
 */
const DEFAULT_ALARM_DRAIN = { alarmsBeforePrompt: 4, maxArmed: 64 } as const;

/** Core-shaped drain config (structurally `Core.AlarmDrainConfig`). */
export interface AlarmDrainSettings {
  readonly alarmsBeforePrompt: number;
  readonly maxArmed: number;
  readonly idleMs: number;
  readonly sweep: { readonly full: boolean; readonly idleDays: number };
}

/**
 * Session fork copy cap (#1257): the one owner of the resolved startup value,
 * mirroring `resolveAlarmDrain`. The cap itself is generation configuration —
 * `session.configure{settings.forkCopyByteCap}` — and this resolved VALUE is
 * the input the composition writes into each new session's genesis settings.
 */
const DEFAULT_FORK_COPY = { byteCap: 4 * 1024 * 1024 } as const;

export interface SessionForkSettings {
  readonly copyByteCap: number;
}

export function resolveSessionFork(
  config: Pick<OpenOmniConfig, "forkCopyByteCap">,
): SessionForkSettings {
  return { copyByteCap: config.forkCopyByteCap ?? DEFAULT_FORK_COPY.byteCap };
}

/**
 * Tool output budget (#1305), mirroring `resolveSessionFork`: the budget is
 * generation configuration — `session.configure{settings.toolOutputBudgetBytes}`
 * — and this resolved value (or absent, meaning the core default) is what the
 * composition writes into each new session's genesis settings.
 */
export interface ToolOutputSettings {
  readonly budgetBytes?: number;
}

export function resolveToolOutput(
  config: Pick<OpenOmniConfig, "toolOutputBudgetBytes">,
): ToolOutputSettings {
  return config.toolOutputBudgetBytes === undefined
    ? {}
    : { budgetBytes: config.toolOutputBudgetBytes };
}

/** The one owner of the D3 drain values, mirroring `resolveClusterStorage`. */
export function resolveAlarmDrain(
  config: Pick<OpenOmniConfig, "alarmSweep" | "entityIdleMs">,
): AlarmDrainSettings {
  return {
    alarmsBeforePrompt: DEFAULT_ALARM_DRAIN.alarmsBeforePrompt,
    maxArmed: DEFAULT_ALARM_DRAIN.maxArmed,
    idleMs: config.entityIdleMs ?? DEFAULT_ENTITY_IDLE_MS,
    sweep: resolveAlarmSweep(config),
  };
}

/** The one owner of the alarm sweep defaults, mirroring `resolveClusterStorage`. */
export function resolveAlarmSweep(
  config: Pick<OpenOmniConfig, "alarmSweep">,
): { readonly full: boolean; readonly idleDays: number } {
  return config.alarmSweep ?? DEFAULT_ALARM_SWEEP;
}

function alarmSweepFromEnv(
  env: Record<string, string | undefined>,
): OpenOmniConfig["alarmSweep"] {
  const full = env.OPENOMNI_ALARM_SWEEP_FULL?.trim();
  const idle = env.OPENOMNI_ALARM_SWEEP_IDLE_DAYS?.trim();
  if ((full === undefined || full.length === 0) && (idle === undefined || idle.length === 0)) {
    return undefined;
  }
  if (full !== undefined && full.length > 0 && full !== "on" && full !== "off") {
    throw new ConfigurationError({
      code: "invalid_alarm_sweep",
      message: 'OPENOMNI_ALARM_SWEEP_FULL must be "on" or "off" when set',
    });
  }
  const idleDays = idle === undefined || idle.length === 0 ? DEFAULT_ALARM_SWEEP.idleDays : Number(idle);
  if (!Number.isInteger(idleDays) || idleDays <= 0) {
    throw new ConfigurationError({
      code: "invalid_alarm_sweep",
      message: "OPENOMNI_ALARM_SWEEP_IDLE_DAYS must be a positive integer of days",
    });
  }
  return { full: full === "on", idleDays };
}

function entityIdleMsFromEnv(env: Record<string, string | undefined>): number | undefined {
  const raw = env.OPENOMNI_ENTITY_IDLE_MS?.trim();
  if (raw === undefined || raw.length === 0) return undefined;
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms <= 0) {
    throw new ConfigurationError({
      code: "invalid_entity_idle_ms",
      message: "OPENOMNI_ENTITY_IDLE_MS must be a positive integer of milliseconds",
    });
  }
  return ms;
}

function forkCopyByteCapFromEnv(env: Record<string, string | undefined>): number | undefined {
  const raw = env.OPENOMNI_FORK_COPY_BYTE_CAP?.trim();
  if (raw === undefined || raw.length === 0) return undefined;
  const cap = Number(raw);
  if (!Number.isInteger(cap) || cap <= 0) {
    throw new ConfigurationError({
      code: "invalid_fork_copy_byte_cap",
      message: "OPENOMNI_FORK_COPY_BYTE_CAP must be a positive integer of bytes",
    });
  }
  return cap;
}

function toolOutputBudgetBytesFromEnv(env: Record<string, string | undefined>): number | undefined {
  const raw = env.OPENOMNI_TOOL_OUTPUT_BUDGET_BYTES?.trim();
  if (raw === undefined || raw.length === 0) return undefined;
  const budget = Number(raw);
  if (!Number.isInteger(budget) || budget <= 0) {
    throw new ConfigurationError({
      code: "invalid_tool_output_budget_bytes",
      message: "OPENOMNI_TOOL_OUTPUT_BUDGET_BYTES must be a positive integer of bytes",
    });
  }
  return budget;
}

function compactionSummarizerFromEnv(env: Record<string, string | undefined>): boolean {
  const raw = env.OPENOMNI_COMPACTION_SUMMARIZER?.trim();
  if (raw === undefined || raw.length === 0) return true;
  if (raw === "off") return false;
  throw new ConfigurationError({
    code: "invalid_compaction_summarizer",
    message: 'OPENOMNI_COMPACTION_SUMMARIZER must be "off" when set',
  });
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

// The gateway grants every ws sender owner tier (src/gateway.ts), so a
// non-loopback bind without upgrade authentication would expose owner-tier
// ingress to the network. startOpenOmni calls this before binding — the
// single enforcement layer for this invariant, covering injected config too.
export function assertWsExposure(config: Pick<OpenOmniConfig, "host" | "wsToken">): void {
  if (
    !LOOPBACK_HOSTS.has(config.host) &&
    (config.wsToken === undefined || config.wsToken.length === 0)
  ) {
    throw new ConfigurationError({
      code: "ws_token_required",
      message: "OPENOMNI_WS_TOKEN is required when OPENOMNI_WS_HOST is not loopback",
    });
  }
}

/**
 * Header maps are the operator's, so they are validated as a shape rather
 * than trusted: a non-object, a non-string value, or an unnamed header is a
 * misconfiguration that must fail at boot, not produce a silently dropped
 * header on every model call.
 */
const ModelHeaders = z.record(
  z.string().regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/),
  z.string().regex(/^[^\r\n]*$/),
);

/**
 * `OPENOMNI_MODEL_FALLBACKS` — the chain the run advances to, as a
 * comma-separated list of `provider/model` entries, in order:
 *
 *     OPENOMNI_MODEL_FALLBACKS="openai/gpt-5,anthropic/claude-x"
 *
 * Surrounding whitespace around each entry is trimmed; only the FIRST slash
 * separates, so a model id containing slashes (`openrouter/meta-llama/llama-4`)
 * survives intact. Validation is fail-closed on the whole variable: an entry
 * with no separator, an empty segment, or inner whitespace rejects the boot
 * rather than silently shortening the chain — a fallback the operator thinks
 * they configured but which never loads is worse than no fallback at all.
 */
// The bundled catalog intentionally supports only these provider SDKs. Keep
// this synchronous with config parsing so an unknown fallback cannot defer its
// failure until a live turn reaches it.
const CATALOG_PROVIDER_IDS = new Set(["anthropic", "openai"]);

function modelFallbacksFromEnv(env: Record<string, string | undefined>): readonly Model.Ref[] | undefined {
  const raw = env.OPENOMNI_MODEL_FALLBACKS?.trim();
  if (raw === undefined || raw.length === 0) return undefined;
  return raw.split(",").map((entry) => {
    const trimmed = entry.trim();
    const separator = trimmed.indexOf("/");
    const provider = separator === -1 ? "" : trimmed.slice(0, separator);
    const id = separator === -1 ? "" : trimmed.slice(separator + 1);
    if (provider.length === 0 || id.length === 0 || /\s/.test(trimmed)) {
      throw new ConfigurationError({
        code: "invalid_model_fallbacks",
        message: `OPENOMNI_MODEL_FALLBACKS is invalid: "${entry}" is not a "provider/model" entry`,
      });
    }
    if (!CATALOG_PROVIDER_IDS.has(provider)) {
      throw new ConfigurationError({
        code: "invalid_model_fallbacks",
        message: `OPENOMNI_MODEL_FALLBACKS is invalid: provider "${provider}" is not in the bundled catalog`,
      });
    }
    return { provider, id };
  });
}

const Enrollments = z.array(Machine.Enrollment).min(1);

/**
 * `OPENOMNI_MACHINES_SELF` — the host's own machine as env JSON (#1271):
 *
 *     OPENOMNI_MACHINES_SELF='{"capabilities":["fs.read","fs.write","shell.exec"],
 *       "exports":[{"name":"workspace","path":"/absolute/host/root"}]}'
 *
 * `id` is optional and defaults to "self". Exports are mandatory and
 * absolute: the daemon exposes nothing outside them, and an empty or relative
 * root is a boot refusal, never an implicit process working directory.
 */
const SelfMachine = z
  .object({
    id: Machine.MachineId.default("self"),
    capabilities: z
      .array(Machine.CapabilityId)
      .min(1)
      .superRefine((capabilities, ctx) => {
        if (new Set(capabilities).size !== capabilities.length)
          ctx.addIssue({ code: "custom", message: "capabilities must be unique" });
      }),
    exports: z
      .array(z.object({ name: Machine.ExportName, path: Machine.AbsolutePath }).strict())
      .min(1)
      .superRefine((entries, ctx) => {
        if (new Set(entries.map((entry) => entry.name)).size !== entries.length)
          ctx.addIssue({ code: "custom", message: "export names must be unique" });
      }),
  })
  .strict();

/** The machine plane with every default resolved; what boot composes from. */
export interface MachinePlane {
  readonly self: {
    readonly id: string;
    readonly capabilities: readonly string[];
    readonly exports: readonly { readonly name: string; readonly path: string }[];
  };
  readonly defaultMachine: string;
}

/**
 * The one semantic validator for a configured machine plane (#1271), run by
 * `loadConfig` and again by boot for injected configs — BEFORE any listener
 * exists: self shape (defaults applied, absolute non-empty exports),
 * duplicate self/enrolled ids, and a default machine absent from the
 * effective enrollments are all rejected here.
 */
export function validateMachinePlane(
  machines: NonNullable<OpenOmniConfig["machines"]>,
): MachinePlane {
  const parsed = SelfMachine.safeParse(machines.self);
  if (!parsed.success) {
    throw new ConfigurationError({
      code: "invalid_machines_self",
      message: `machines.self is invalid: ${parsed.error.issues[0]?.message}`,
    });
  }
  const self = parsed.data;
  const ids = new Set<string>([self.id]);
  for (const enrollment of machines.enrolled) {
    if (ids.has(enrollment.machineId)) {
      throw new ConfigurationError({
        code: "invalid_machines_self",
        message: `machines ids must be unique: ${enrollment.machineId}`,
      });
    }
    ids.add(enrollment.machineId);
  }
  const defaultMachine = machines.default ?? self.id;
  if (!ids.has(defaultMachine)) {
    throw new ConfigurationError({
      code: "invalid_machines_default",
      message: `machines.default is not an enrolled machine: ${defaultMachine}`,
    });
  }
  return { self, defaultMachine };
}
const SocialBudgets = z.array(Gateway.SocialBudget);

const Actors = z
  .array(
    z
      .object({
        actorId: z.string().min(1),
        externalId: z.string().min(1),
        channel: z.enum(["ws", "discord", "telegram"]).optional(),
        trustTier: Actor.TrustTier,
        kind: Actor.Kind.default("human"),
        displayName: z.string().min(1).optional(),
      })
      .strict(),
  )
  .min(1);

/** Reads an env var holding JSON, naming the variable on both parse and schema failure. */
function parseEnvJson<T>(
  name: string,
  schema: z.ZodType<T>,
  env: Record<string, string | undefined>,
): T | undefined {
  const raw = env[name]?.trim();
  if (raw === undefined || raw.length === 0) return undefined;
  const json = Result.try({ try: (): PlainValue => JSON.parse(raw), catch: String });
  if (Result.isFailure(json)) {
    throw new ConfigurationError({ code: "invalid_env_json", message: `${name} is invalid JSON: ${json.failure}` });
  }
  const parsed = schema.safeParse(json.success);
  if (!parsed.success) {
    throw new ConfigurationError({ code: "invalid_env_json", message: `${name} is invalid: ${parsed.error.issues[0]?.message}` });
  }
  return parsed.data;
}

/**
 * Like enrollment, actor admission is the Owner's decision read from config:
 * who may be delegated to is never inferred from whoever connects.
 */
function actorsFromEnv(env: Record<string, string | undefined>): OpenOmniConfig["actors"] {
  return parseEnvJson("OPENOMNI_ACTORS", Actors, env);
}

const ChannelAllowedSenders = z.record(z.string(), z.array(z.string().min(1)).min(1));

function channelAllowedSendersFromEnv(
  env: Record<string, string | undefined>,
): OpenOmniConfig["channelAllowedSenders"] {
  return parseEnvJson("OPENOMNI_CHANNEL_ALLOWED_SENDERS", ChannelAllowedSenders, env);
}

/** Declared ChannelInstance rows are the sole channel provisioning owner. */
export function assertDeclaredChannelConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const legacy = ["DISCORD_BOT_TOKEN", "TELEGRAM_BOT_TOKEN", "GITHUB_WEBHOOK_SECRET"]
    .filter((key) => (env[key]?.trim().length ?? 0) > 0);
  if (legacy.length > 0) {
    throw new ConfigurationError({
      code: "legacy_channel_credentials",
      message: `Remove ${legacy.join(", ")}; use the provision tool with op channel_add to declare channels.`,
      replacement: { tool: "provision", op: "channel_add" },
    });
  }
}

/**
 * `OPENOMNI_BUNDLES_OFF` — JSON array of bundle or capability names the
 * Owner turns off (#1306):
 *
 *     OPENOMNI_BUNDLES_OFF='["monitor","hook"]'
 *
 * Unset or empty means everything the manifest declares is on. Validation is
 * fail-closed: a non-array or an empty name rejects the boot rather than
 * silently keeping something the Owner meant to turn off.
 */
const OffNames = z.array(z.string().min(1));

function offFromEnv(env: Record<string, string | undefined>): OpenOmniConfig["off"] {
  return parseEnvJson("OPENOMNI_BUNDLES_OFF", OffNames, env);
}

function socialBudgetsFromEnv(env: Record<string, string | undefined>): OpenOmniConfig["socialBudgets"] {
  return parseEnvJson("OPENOMNI_SOCIAL_BUDGETS", SocialBudgets, env);
}

function modelFromEnv(env: Record<string, string | undefined>): OpenOmniConfig["model"] {
  const baseUrl = env.OPENOMNI_MODEL_BASE_URL?.trim();
  const headers = parseEnvJson("OPENOMNI_MODEL_HEADERS", ModelHeaders, env);
  const fallbacks = modelFallbacksFromEnv(env);
  return {
    provider: required("OPENOMNI_MODEL_PROVIDER", env),
    id: required("OPENOMNI_MODEL_ID", env),
    apiKey: required("OPENOMNI_MODEL_API_KEY", env),
    ...(baseUrl === undefined || baseUrl.length === 0 ? {} : { baseUrl }),
    ...(headers === undefined ? {} : { headers }),
    ...(fallbacks === undefined ? {} : { fallbacks }),
  };
}

/**
 * Enrollment is the Owner's admission decision, so it is read from config
 * rather than inferred from whoever connects. Ledger-backed enrollment is a
 * later slice; the shape the host consumes is already the protocol's.
 */
function machinesTcpFromEnv(env: Record<string, string | undefined>) {
  const host = env.OPENOMNI_MACHINES_TCP_HOST?.trim() || undefined;
  const port = env.OPENOMNI_MACHINES_TCP_PORT?.trim() || undefined;
  const certPath = env.OPENOMNI_MACHINES_TLS_CERT?.trim() || undefined;
  const keyPath = env.OPENOMNI_MACHINES_TLS_KEY?.trim() || undefined;
  if (host === undefined && port === undefined && certPath === undefined && keyPath === undefined) {
    return undefined;
  }
  // A partial tuple is a misconfiguration, never a silently-unencrypted bind.
  if (host === undefined || port === undefined || certPath === undefined || keyPath === undefined) {
    throw new ConfigurationError({
      code: "invalid_machines_tcp",
      message:
        "OPENOMNI_MACHINES_TCP_HOST, OPENOMNI_MACHINES_TCP_PORT, OPENOMNI_MACHINES_TLS_CERT and OPENOMNI_MACHINES_TLS_KEY must be set together",
    });
  }
  const parsedPort = z.coerce.number().int().min(1).max(65535).safeParse(port);
  if (!parsedPort.success) {
    throw new ConfigurationError({
      code: "invalid_machines_tcp",
      message: `OPENOMNI_MACHINES_TCP_PORT is invalid: ${port}`,
    });
  }
  const pem = (name: string, path: string): string => {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      throw new ConfigurationError({
        code: "invalid_machines_tcp",
        message: `${name} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };
  return {
    tcp: { host, port: parsedPort.data },
    tls: {
      certificate: pem("OPENOMNI_MACHINES_TLS_CERT", certPath),
      privateKey: pem("OPENOMNI_MACHINES_TLS_KEY", keyPath),
    },
  };
}

/**
 * Env mapping (#1271): `OPENOMNI_MACHINES_SELF` declares the host's own
 * machine, `OPENOMNI_MACHINES_DEFAULT` names the prefix-less target (defaults
 * to the self id), `OPENOMNI_MACHINES_ENROLLED` admits remote machines. Any
 * of the three configures the plane; a configured plane without self is a
 * contradiction, because boot attaches the in-process daemon unconditionally.
 */
function machinesFromEnv(
  home: string,
  env: Record<string, string | undefined>,
): OpenOmniConfig["machines"] {
  const self = parseEnvJson("OPENOMNI_MACHINES_SELF", SelfMachine, env);
  const enrolled = parseEnvJson("OPENOMNI_MACHINES_ENROLLED", Enrollments, env);
  const defaultMachine = env.OPENOMNI_MACHINES_DEFAULT?.trim() || undefined;
  if (self === undefined && enrolled === undefined && defaultMachine === undefined) return undefined;
  if (self === undefined) {
    throw new ConfigurationError({
      code: "invalid_machines_self",
      message: "OPENOMNI_MACHINES_SELF is required when the machine plane is configured",
    });
  }
  const network = machinesTcpFromEnv(env);
  const unix = env.OPENOMNI_MACHINES_SOCKET?.trim() || join(home, ".openomni", "machines.sock");
  const machines: NonNullable<OpenOmniConfig["machines"]> = {
    self,
    ...(defaultMachine === undefined ? {} : { default: defaultMachine }),
    listen: { unix, ...(network === undefined ? {} : { tcp: network.tcp }) },
    ...(network === undefined ? {} : { tls: network.tls }),
    enrolled: enrolled ?? [],
  };
  validateMachinePlane(machines);
  return machines;
}

export function loadConfig(
  home: string = homedir(),
  env: Record<string, string | undefined> = process.env,
): OpenOmniConfig {
  assertDeclaredChannelConfig(env);
  const host = env.OPENOMNI_WS_HOST?.trim() || "127.0.0.1";
  const wsToken = env.OPENOMNI_WS_TOKEN?.trim();
  const machines = machinesFromEnv(home, env);
  const actors = actorsFromEnv(env);
  const socialBudgets = socialBudgetsFromEnv(env);
  const alarmSweep = alarmSweepFromEnv(env);
  const forkCopyByteCap = forkCopyByteCapFromEnv(env);
  const toolOutputBudgetBytes = toolOutputBudgetBytesFromEnv(env);
  const channelAllowedSenders = channelAllowedSendersFromEnv(env);
  const off = offFromEnv(env);
  const hooksPath = env.OPENOMNI_HOOKS_PATH?.trim() || undefined;
  return {
    ...resolveClusterStorage(
      {
        catalogPath: env.OPENOMNI_CATALOG_PATH?.trim() || undefined,
        sessionsDir: env.OPENOMNI_SESSIONS_DIR?.trim() || undefined,
        entityIdleMs: entityIdleMsFromEnv(env),
      },
      home,
    ),
    host,
    wsPort: parseWsPort(env.OPENOMNI_WS_PORT),
    compactionSummarizer: compactionSummarizerFromEnv(env),
    ...(alarmSweep === undefined ? {} : { alarmSweep }),
    ...(forkCopyByteCap === undefined ? {} : { forkCopyByteCap }),
    ...(toolOutputBudgetBytes === undefined ? {} : { toolOutputBudgetBytes }),
    ...(wsToken === undefined || wsToken.length === 0 ? {} : { wsToken }),
    kek: resolveKek(env, home),
    model: modelFromEnv(env),
    ...(machines === undefined ? {} : { machines }),
    ...(actors === undefined ? {} : { actors }),
    ...(socialBudgets === undefined ? {} : { socialBudgets }),
    ...(channelAllowedSenders === undefined ? {} : { channelAllowedSenders }),
    ...(off === undefined ? {} : { off }),
    ...(hooksPath === undefined ? {} : { hooksPath }),
  };
}
