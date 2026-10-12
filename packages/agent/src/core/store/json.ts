import { PlainValueSchema, type PlainValue } from "@openomni/protocol";
import { z } from "zod";
import { SchemaRefused } from "./errors";

/** Throwing decode: malformed text is `SchemaRefused{reason: json}`; a non-plain value keeps its schema rejection. */
export function parsePlainJson(text: string): PlainValue {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new SchemaRefused({ sessionId: "", actionId: "", kind: "json", reason: "json" });
  }
  return PlainValueSchema.parse(decoded);
}

/** Degraded decode: corrupt rows and malformed payloads read as `undefined`, never a throw. */
export function readPlainJson(text: string): PlainValue | undefined {
  try {
    return parsePlainJson(text);
  } catch {
    return undefined;
  }
}

export const SqliteCount = z
  .union([z.number().int(), z.bigint()])
  .transform(Number)
  .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));

// Wall-clock instants mirror protocol EpochMs: finite, non-negative, fractional allowed.
export const SqliteEpochMs = z
  .union([z.number(), z.bigint()])
  .transform(Number)
  .pipe(z.number().finite().nonnegative());
