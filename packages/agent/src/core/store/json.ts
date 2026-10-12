import { PlainValueSchema } from "@openomni/protocol";
import { z } from "zod";
import { SchemaRefused } from "./errors";

/** Parse JSON without disguising a valid value's schema rejection as a syntax error. */
export function parsePlainJson(text: string) {
  let value: z.input<typeof PlainValueSchema>;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SchemaRefused({ reason: "json" });
  }
  return PlainValueSchema.parse(value);
}

export const parseStoredJson = parsePlainJson;

export const SqliteCount = z
  .union([z.number().int(), z.bigint()])
  .transform(Number)
  .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));

// Wall-clock instants mirror protocol EpochMs: finite, non-negative, fractional allowed.
export const SqliteEpochMs = z
  .union([z.number(), z.bigint()])
  .transform(Number)
  .pipe(z.number().finite().nonnegative());
