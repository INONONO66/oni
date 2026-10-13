import { PlainValueSchema, type PlainValue } from "@openomni/protocol";
import { z } from "zod";
import { SchemaRefused } from "./errors";

/** Malformed text is `SchemaRefused{reason: json}`. */
export function parsePlainJson(text: string): PlainValue {
  try {
    return PlainValueSchema.parse(JSON.parse(text));
  } catch (cause) {
    if (cause instanceof SyntaxError) throw new SchemaRefused({ reason: "json", detail: cause.message });
    throw cause;
  }
}

/** Corrupt rows read as `undefined`, never a throw. */
export function readPlainJson(text: string): PlainValue | undefined {
  try {
    return parsePlainJson(text);
  } catch {
    return undefined;
  }
}

const sqliteNumeric = <Check extends z.ZodType<number, number>>(member: z.ZodType<number>, check: Check) =>
  z.union([member, z.bigint()]).transform(Number).pipe(check);

export const SqliteCount = sqliteNumeric(
  z.number().int(),
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
);

export const SqliteEpochMs = sqliteNumeric(z.number(), z.number().finite().nonnegative());
