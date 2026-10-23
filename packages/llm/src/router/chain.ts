import type { Model } from "@oni/protocol";
import { z } from "zod";

const Selector = z.string().regex(/^[^/]+\/.+$/);
const Row = z.object({
  category: z.string().optional(),
  primary: Selector.optional(),
  selectors: z.array(Selector).nonempty(),
  nearestFallback: z.string().optional(),
}).refine((row) => row.category !== undefined || row.primary !== undefined);

export type ChainRow = z.input<typeof Row>;

export function candidates(rows: readonly ChainRow[], primary: string, category?: string) {
  const row = rows.find((entry) => entry.category !== undefined && entry.category === category)
    ?? rows.find((entry) => entry.primary === primary);
  return {
    category: category ?? primary,
    selectors: row === undefined ? [primary] : [...new Set(row.selectors)],
    nearestFallback: row?.nearestFallback ?? null,
    configured: row !== undefined,
  };
}

export function parseRows(rows: readonly ChainRow[]): readonly ChainRow[] {
  return z.array(Row).parse(rows);
}

export function reference(selector: string): Model.Ref {
  const slash = selector.indexOf("/");
  return { provider: selector.slice(0, slash), id: selector.slice(slash + 1) };
}
