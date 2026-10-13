import {
  EMIT_KINDS,
  type EmitKind,
  type GateRow,
  type PointRecord,
} from "@openomni/protocol";
import { GateComposeError, type GatePointTable } from "../points";

/** One row validated against its point record and the registered handler set, rejecting fail-closed. */

function reject(code: GateComposeError["data"]["code"], row: GateRow, detail?: string): never {
  throw new GateComposeError({
    code,
    rowId: row.id,
    point: row.on,
    ...(detail === undefined ? {} : { ref: detail }),
  });
}

function validateAction(row: GateRow, record: PointRecord): void {
  if (record.allowedDo.includes(row.do)) return;
  if (row.do === "emit" && record.end === true) reject("post_end_emit", row);
  reject("bad_action", row, row.do);
}

function validateFields(row: GateRow, record: PointRecord): void {
  for (const field of Object.keys(row.when)) {
    if (!record.whenFields.includes(field)) reject("bad_field", row, field);
  }
  if (row.do !== "rewrite") return;
  const fields = row.how.fields ?? [];
  if (fields.length === 0) reject("bad_field", row, "fields");
  if (record.rewriteOpen === true) return;
  for (const field of fields) {
    if (!record.rewritableFields.includes(field)) reject("bad_field", row, field);
  }
}

/** A non-emit row carries none. */
function validateEmit(row: GateRow, record: PointRecord): EmitKind | undefined {
  if (row.do !== "emit") return undefined;
  if (record.end === true) reject("post_end_emit", row);
  const kind = EMIT_KINDS.find((candidate) => candidate === row.how.emit);
  if (kind === undefined) reject("bad_action", row, row.how.emit ?? "emit");
  return kind;
}

/** Audit-only: never a verdict, obligation, rewrite field, or emission. */
function validateObserve(row: GateRow): void {
  if (
    row.how.ref === undefined ||
    row.how.verdict !== undefined ||
    row.how.metric !== undefined ||
    row.how.limit !== undefined ||
    row.how.fields !== undefined ||
    row.how.emit !== undefined
  )
    reject("bad_action", row, "how");
}

/** The fold applies exactly one mode: an admitted constant beside a declared guard would execute the constant and silently bypass the guard. */
function validateGate(row: GateRow): void {
  if (row.how.metric !== undefined) {
    // Obligation row: metric/limit under the projection-fixed allow; its optional
    // ref names the turn-boundary obligation handler, never a consulted guard.
    if (row.how.verdict !== "allow") reject("bad_action", row, "how");
    return;
  }
  // A constant verdict or a consulted handler: exactly one.
  if ((row.how.verdict !== undefined) === (row.how.ref !== undefined))
    reject("bad_action", row, "how");
}

function validateHow(row: GateRow, handlers: ReadonlySet<string>): void {
  if ((row.how.metric === undefined) !== (row.how.limit === undefined))
    reject("bad_field", row, "limit");
  if (row.do === "observe") validateObserve(row);
  if (row.do === "gate") validateGate(row);
  if (
    row.do === "rewrite" &&
    (row.how.ref === undefined || row.how.verdict !== undefined || row.how.metric !== undefined)
  )
    reject("bad_action", row, "how");
  if (
    row.do === "emit" &&
    (row.how.ref !== undefined ||
      row.how.verdict !== undefined ||
      row.how.metric !== undefined ||
      row.how.fields !== undefined)
  )
    reject("bad_action", row, "how");
  for (const ref of [row.how.ref, ...(row.how.requires ?? [])]) {
    if (ref !== undefined && !handlers.has(ref)) reject("unknown_handler", row, ref);
  }
}

export function admitRow(
  row: GateRow,
  table: GatePointTable,
  handlers: ReadonlySet<string>,
): EmitKind | undefined {
  const record = table.get(row.on);
  if (record === undefined) reject("unknown_point", row);
  validateAction(row, record);
  validateFields(row, record);
  const emit = validateEmit(row, record);
  validateHow(row, handlers);
  return emit;
}
