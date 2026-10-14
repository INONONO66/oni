import { readFileSync } from "node:fs";
import { Bundle } from "@openomni/agent";
import type { PlainValue } from "@openomni/protocol";
import { z } from "zod";
import { AppInvariantError } from "../../invariant";

/**
 * The `hooks-json` product bundle (#1256): COMPILES a hooks JSON file into
 * frozen #1251 gate rows over the hook capability's `hook/process` handler —
 * the file is config compiled at the composition boundary, never a runtime
 * lookup, so an entry on an unknown event or an unknown key refuses the boot
 * fail-closed instead of partially activating. The bundle itself owns no
 * journal kind and no point; it `requires` the hook seam, so `off: ["hook"]`
 * (or `off: ["action"]` through the hook's own requires) cascades this bundle
 * off with the root recorded as `because`.
 */

/** The in-process example handler's `how.ref`; a transformer, not a process. */
export const SECRETS_GUARD_REF = "hooks-json/secrets-guard";

/** Hook events this product maps onto #1251 points; anything else refuses. */
const EVENT_POINTS = Object.freeze({
  PreToolUse: "tool.pre",
  PostToolUse: "tool.post",
  UserPromptSubmit: "prompt.pre",
  SessionStart: "session.open",
} as const);
type HookEvent = keyof typeof EVENT_POINTS;

/**
 * One external command hook: a consulted row over `hook/process`. The default
 * is a gate (PostToolUse: audit-only observe); `do: "rewrite"` (#1256 r4 H-2)
 * compiles the consulted rewrite instead — the child's `{type: "rewrite"}`
 * response rewrites ONLY the declared `fields`, which must name the point's
 * rewritable fields (`UserPromptSubmit` defaults to `body`; tool events are
 * caller-shaped and must spell theirs out; `SessionStart` allows none).
 */
const CommandEntry = z.strictObject({
  command: z.array(z.string().min(1)).min(1),
  /** Bounds one handler call via the composed clock; never an alarm. */
  timeoutMs: z.number().int().positive().max(600_000).default(5_000),
  do: z.literal("rewrite").optional(),
  fields: z.array(z.string().min(1)).min(1).optional(),
});

/**
 * The shipped in-process example: a rewrite row over the secrets-guard
 * transformer. A rewrite row MUST declare the fields it rewrites (#1256 r3
 * H-3): `fields` names them explicitly; `UserPromptSubmit` defaults to the
 * point registry's `body`. Tool events are caller-shaped, so their guard
 * entries must spell their fields out; `SessionStart` allows no rewrite.
 */
const GuardEntry = z.strictObject({
  guard: z.literal("secrets-guard"),
  fields: z.array(z.string().min(1)).min(1).optional(),
});

/** Default rewrite fields per event; absent means the entry must declare its own. */
const GUARD_DEFAULT_FIELDS: Partial<Record<HookEvent, readonly string[]>> = {
  UserPromptSubmit: ["body"],
};

function rewriteFields(
  event: HookEvent,
  entry: { readonly fields?: readonly string[] },
  example: string,
): readonly string[] {
  if (event === "SessionStart")
    throw new AppInvariantError(
      "hooks-json: SessionStart allows no rewrite row; a rewrite entry cannot compile there",
      "session_start_rewrite",
    );
  const fields = entry.fields ?? GUARD_DEFAULT_FIELDS[event];
  if (fields === undefined || fields.length === 0)
    throw new AppInvariantError(
      `hooks-json: a ${event} rewrite entry must declare the fields it rewrites (e.g. ${example})`,
      "missing_rewrite_fields",
    );
  return fields;
}

function guardFields(event: HookEvent, entry: z.infer<typeof GuardEntry>): readonly string[] {
  return rewriteFields(event, entry, '{"guard":"secrets-guard","fields":["command"]}');
}

/** A command entry's declared fields are meaningless outside `do: "rewrite"`. */
function commandRowShape(
  event: HookEvent,
  entry: z.infer<typeof CommandEntry>,
): Pick<Bundle.BundleGateRow, "do" | "how"> {
  const params = { event, command: entry.command, timeoutMs: entry.timeoutMs };
  if (entry.do === "rewrite") {
    // #1256 r4 H-2: the consulted rewrite — the declared fields ride both the
    // row (`how.fields`, validated against the point registry at compile) and
    // the params the live policy plane re-projects (`config.fields`).
    const fields = rewriteFields(event, entry, '{"command":["mask"],"do":"rewrite","fields":["command"]}');
    return {
      do: "rewrite",
      how: { ref: Bundle.HOOK_PROCESS_REF, fields: [...fields], params: { ...params, fields: [...fields] } },
    };
  }
  if (entry.fields !== undefined)
    throw new AppInvariantError(
      `hooks-json: a ${event} command entry declares fields without do:"rewrite"`,
      "invalid_config",
    );
  return {
    // PostToolUse cannot retroactively block a finished tool call: it
    // compiles audit-only (#1256 — observe rows annotate, every other event
    // gates through the consulted hook process).
    do: event === "PostToolUse" ? "observe" : "gate",
    how: { ref: Bundle.HOOK_PROCESS_REF, params },
  };
}

const HooksJson = z.strictObject(
  Object.fromEntries(
    Object.keys(EVENT_POINTS).map((event) => [
      event,
      z.array(z.union([CommandEntry, GuardEntry])).optional(),
    ]),
  ) as Record<
    HookEvent,
    z.ZodOptional<z.ZodArray<z.ZodUnion<[typeof CommandEntry, typeof GuardEntry]>>>
  >,
);

/** The parsed hooks config the manifest receives; produced by `readHooksJson`. */
export type HooksJsonInput = z.infer<typeof HooksJson>;

/**
 * Reads and validates the Owner's hooks JSON file. Every refusal is the typed
 * app invariant failure thrown BEFORE any listener exists: an unknown event
 * key names itself (`unmapped_event`), unreadable bytes or an invalid shape
 * name the file.
 */
export function readHooksJson(path: string): HooksJsonInput {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw new AppInvariantError(`hooks-json: cannot read ${path}: ${String(cause)}`, "unreadable_path");
  }
  let parsed: PlainValue;
  try {
    parsed = JSON.parse(raw) as PlainValue;
  } catch (cause) {
    throw new AppInvariantError(`hooks-json: ${path} is not JSON: ${String(cause)}`, "not_json");
  }
  const result = HooksJson.safeParse(parsed);
  if (!result.success) {
    const unrecognized = result.error.issues.find((issue) => issue.code === "unrecognized_keys");
    if (unrecognized !== undefined && unrecognized.code === "unrecognized_keys")
      throw new AppInvariantError(
        `hooks-json: unmapped_event ${unrecognized.keys.join(", ")} in ${path}; mapped events are ${Object.keys(EVENT_POINTS).join(", ")}`,
        "unmapped_event",
      );
    throw new AppInvariantError(`hooks-json: invalid config in ${path}: ${result.error.message}`, "invalid_config");
  }
  return result.data;
}

const SECRET_PATTERN =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g;

/**
 * The in-process example handler (#1256): a pure rewrite transformer masking
 * secret-shaped tokens in every string of the decision input. It runs on the
 * live plane's transform channel today — no process, no timeout, no verdict.
 */
export function secretsGuard(args: PlainValue, _config: PlainValue): PlainValue {
  if (typeof args === "string") return args.replace(SECRET_PATTERN, "[redacted]");
  if (Array.isArray(args)) return args.map((entry) => secretsGuard(entry, _config));
  if (args !== null && typeof args === "object")
    return Object.fromEntries(
      Object.entries(args).map(([key, value]) => [key, secretsGuard(value, _config)]),
    );
  return args;
}

/**
 * Compiles the parsed hooks config into rows. Row ids are the durable
 * `hooks-json/<point>#<n>` names, so recomposing the same file is the no-op
 * policy write the seed path already recognizes; `order` follows file order
 * after the kernel's own rows.
 */
function compileRows(config: HooksJsonInput): readonly Bundle.BundleGateRow[] {
  const rows: Bundle.BundleGateRow[] = [];
  const perPoint = new Map<string, number>();
  for (const event of Object.keys(EVENT_POINTS) as readonly HookEvent[]) {
    for (const entry of config[event] ?? []) {
      const on = EVENT_POINTS[event];
      const ordinal = (perPoint.get(on) ?? 0) + 1;
      perPoint.set(on, ordinal);
      rows.push(
        "guard" in entry
          ? {
              id: `hooks-json/${on}#${ordinal}`,
              on,
              when: {},
              do: "rewrite",
              // #1256 r3 H-3: the declared rewrite fields ride both the row
              // (`how.fields`, validated against the point registry at
              // compile) and the params the live policy plane re-projects.
              how: {
                ref: SECRETS_GUARD_REF,
                fields: [...guardFields(event, entry)],
                params: { event, fields: [...guardFields(event, entry)] },
              },
              order: 500 + rows.length,
            }
          : {
              id: `hooks-json/${on}#${ordinal}`,
              on,
              when: {},
              ...commandRowShape(event, entry),
              order: 500 + rows.length,
            },
      );
    }
  }
  return rows;
}

/**
 * The bundle contract: compiled rows plus the one registered in-process
 * handler. With no config (or an empty one) the bundle still composes — it
 * ships the secrets-guard registration and zero rows.
 */
export function hooksJsonBundle(config: HooksJsonInput = {}): Bundle.BundleContract<"hooks-json"> {
  return Bundle.define({
    name: "hooks-json",
    requires: [Bundle.HookPort],
    rows: compileRows(config),
    handlers: { [SECRETS_GUARD_REF]: { apply: secretsGuard } },
  });
}
