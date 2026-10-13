import type { PointId } from "@openomni/protocol";

/** The one module that mints row ids; generations record `rowsVersion` and decision facts recorded under earlier identities keep their bytes. */
export const GATE_ROW_WRITER_VERSION = 1 as const;

/** Each run outside `[a-z0-9]` collapses to one `-` and a token not starting with a letter gains `row-`, so EVERY production row name satisfies the `GateRowId` grammar; the ordinal keeps colliding tokens unique. */
function rowNameToken(name: string): string {
  const token = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (token === "") return "row";
  return /^[a-z]/.test(token) ? token : `row-${token}`;
}

/** `<name token>/<point>#<ordinal>`; the ordinal is the priority-sorted index, so same-name rows on one point still get distinct ids. */
export function gateRowId(
  row: { readonly name: string },
  point: PointId,
  ordinal: number,
): string {
  return `${rowNameToken(row.name)}/${point}#${ordinal}`;
}
