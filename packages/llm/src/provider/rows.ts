import { readFileSync } from "node:fs";
import { z } from "zod";
import { ProviderRowsError } from "../errors";
import bundled from "./bundled-rows.json";

const BUNDLED_NPM = ["@ai-sdk/anthropic", "@ai-sdk/openai"] as const;

export const ProviderRow = z
  .object({
    id: z.string().min(1),
    npm: z.enum(BUNDLED_NPM),
    baseUrl: z.url().optional(),
    headers: z
      .record(z.string().regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/), z.string().regex(/^[^\r\n]*$/))
      .optional(),
    /** Name of the environment variable the host reads the API key from; the package itself never reads it. */
    auth: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
    /** Absent uses the SDK's default language model; both named surfaces exist only on the OpenAI SDK. */
    api: z.enum(["responses", "chat"]).optional(),
  })
  .strict();
export type ProviderRow = z.infer<typeof ProviderRow>;

const ProviderRows = z
  .object({ providers: z.array(ProviderRow) })
  .strict()
  .refine((rows) => new Set(rows.providers.map((row) => row.id)).size === rows.providers.length, {
    message: "provider ids must be unique",
  });

export const BUNDLED_ROWS: readonly ProviderRow[] = ProviderRows.parse(bundled).providers;

export function mergeRows(configured: readonly ProviderRow[]): readonly ProviderRow[] {
  const ids = new Set(configured.map((row) => row.id));
  return [...BUNDLED_ROWS.filter((row) => !ids.has(row.id)), ...configured];
}

function parseJson(path: string, text: string): z.infer<ReturnType<typeof z.json>> {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new ProviderRowsError({ path, reason: "invalid_json", message: `${path} is not JSON: ${String(cause)}` });
  }
}

/** A malformed file is a typed refusal, never replaced by the bundled rows. */
export function readProviderRows(path: string): readonly ProviderRow[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    throw new ProviderRowsError({ path, reason: "unreadable", message: `${path} is unreadable: ${String(cause)}` });
  }
  const parsed = ProviderRows.safeParse(parseJson(path, text));
  if (parsed.success) return parsed.data.providers;
  const issue = parsed.error.issues[0];
  const unsupported = issue?.path.at(-1) === "npm";
  throw new ProviderRowsError({
    path,
    reason: unsupported ? "unsupported_npm" : "invalid_rows",
    message: `${path} is invalid at ${issue?.path.join(".") || "<root>"}: ${issue?.message}`,
  });
}
