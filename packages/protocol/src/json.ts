import { z } from "zod";
import { NamedError } from "./error/index.js";
import { sha256Hex } from "./sha256.js";

/**
 * Typed refusal for values outside the canonical JSON grammar: non-finite
 * numbers, exotic objects, and undefined slots cannot be rendered or keyed
 * canonically. One class for the whole concern; the message names the site.
 */
export const CanonicalJsonError = NamedError.create(
  "CanonicalJsonError",
  z.object({ message: z.string() }),
);
export type CanonicalJsonError = InstanceType<typeof CanonicalJsonError>;

/**
 * Single owner for plain-JSON validation and canonical JSON serialization.
 * Protocol modules import it relatively; the package barrel re-exports the
 * canonical helpers and plain-value schemas for external consumers (policy
 * effects and stable archive hashing).
 */

export type PlainObject = { [key: string]: PlainValue };

export type PlainValue = null | boolean | number | string | PlainValue[] | PlainObject;

// Validation at this boundary must never execute caller-supplied code:
// property values are read through data-property descriptors (an accessor
// property is refused without invoking its getter), symbol-keyed own
// properties are refused (JSON serialization would silently drop them),
// and any throw from an exotic object (hostile Proxy trap) is contained by
// the guard and reported as an ordinary parse failure. A fully transparent
// Proxy over plain data is indistinguishable by design — the contract here
// is structural.
interface PlainValuePolicy {
  readonly key: (key: string) => boolean;
  /**
   * Whether an explicit `undefined` record slot is accepted. JSON.stringify
   * drops such slots on the wire without changing any value, so the
   * JSON-shaped wire profile keeps them; the canonical plain profiles refuse
   * them (a persisted fact must not carry an inexpressible slot).
   */
  readonly recordUndefined: boolean;
}

const strictPlainKey = (key: string): boolean =>
  key !== "__proto__" && key !== "constructor" && key !== "prototype";
const strictPlain: PlainValuePolicy = { key: strictPlainKey, recordUndefined: false };
const persistedPlain: PlainValuePolicy = { key: () => true, recordUndefined: false };
const jsonShaped: PlainValuePolicy = { key: strictPlainKey, recordUndefined: true };

function isPlainValueUnsafe<Input>(value: Input, policy: PlainValuePolicy): value is Input & PlainValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  if (Array.isArray(value)) return isPlainArray(value, policy);
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return isPlainObject(value, policy);
}

function isPlainArray<Entry>(value: readonly Entry[], policy: PlainValuePolicy): value is Entry[] & PlainValue[] {
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  // Named own properties make key count exceed length; holes surface as
  // absent index descriptors below — together this refuses sparse arrays,
  // extra properties, and the one-hole + one-named-property cancellation.
  if (Object.keys(value).length !== value.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (descriptor === undefined || !("value" in descriptor)) return false;
    if (!isPlainValueUnsafe(descriptor.value, policy)) return false;
  }
  return true;
}

function isPlainObject(value: object, policy: PlainValuePolicy): value is PlainObject {
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  for (const key of Object.keys(value)) {
    if (!policy.key(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return false;
    if (descriptor.value === undefined) {
      if (!policy.recordUndefined) return false;
      continue;
    }
    if (!isPlainValueUnsafe(descriptor.value, policy)) return false;
  }
  return true;
}

/**
 * A JSON-shaped tree whose optional slots may be explicit undefined
 * (JSON.stringify drops them on the wire). This is the honest static shape
 * of values that ride a JSON wire before serialization; the schema below is
 * its runtime boundary (#1312): non-finite numbers, exotic objects, and
 * undefined anywhere but a record slot are refused instead of silently
 * normalized by the serializer.
 */
export type JsonShapedValue =
  | undefined
  | null
  | boolean
  | number
  | string
  | readonly JsonShapedValue[]
  | { readonly [key: string]: JsonShapedValue };

/**
 * Runtime JSON-shape boundary: functions, Dates and other exotic objects,
 * non-finite numbers, and undefined inside an array are rejected; a record
 * slot holding explicit undefined stays accepted because JSON.stringify
 * drops it without changing any value. Top-level undefined remains the
 * expressible "absent" of the static type; optional wrappers own absence.
 */
export const JsonShapedValueSchema: z.ZodType<JsonShapedValue, JsonShapedValue> =
  z.custom<JsonShapedValue>(isJsonShapedValue, { message: "Expected a JSON-shaped value" });

// Named generic guard: z.custom's inline callback parameter would be
// contextually typed `unknown`; a generic parameter carries no top type.
function isJsonShapedValue<Input>(value: Input): boolean {
  if (value === undefined) return true;
  try {
    return isPlainValueUnsafe(value, jsonShaped);
  } catch {
    return false;
  }
}

/**
 * Strict live-boundary profile (policy effects): own keys named __proto__,
 * constructor, or prototype are refused outright — hostile input never gets
 * to look like plain data.
 */
export function isPlainValue<Input>(value: Input): value is Input & PlainValue {
  try {
    return isPlainValueUnsafe(value, strictPlain);
  } catch {
    return false;
  }
}

/**
 * Persisted-fact profile: identical structural
 * guard, but own keys named __proto__/constructor/prototype are ACCEPTED.
 * Pre-hardening schemas admitted such keys into immutable persisted facts
 * before hardening,
 * so a read schema that refused them would invalidate historical bytes (era
 * law). Values are only ever READ through data-property descriptors and
 * canonically rendered — never assigned onto another object — so accepting
 * these key names creates no prototype-pollution path here. The remaining
 * strictness deltas vs the old schema (-0, accessor properties, symbol keys,
 * sparse arrays) are unreachable in persisted bytes: rows are written with
 * JSON.stringify (never emits -0) and read with JSON.parse (only dense
 * arrays and plain data properties), so no historical row is invalidated.
 */
export const PlainValueSchema: z.ZodType<PlainValue, PlainValue> = z.custom<PlainValue>(
  isPersistedPlainValue,
  { message: "Expected a plain JSON value" },
);

// Named generic guard: z.custom's inline callback parameter would be
// contextually typed `unknown`; a generic parameter carries no top type.
function isPersistedPlainValue<Input>(value: Input): boolean {
  try {
    return isPlainValueUnsafe(value, persistedPlain);
  } catch {
    return false;
  }
}

/** The persisted-fact profile narrowed to one JSON object: tool arguments and other record-shaped facts. */
export const PlainObjectSchema: z.ZodType<PlainObject, PlainValue> = PlainValueSchema.transform(
  (value, context) => {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value;
    context.addIssue({ code: "custom", message: "Expected a plain JSON object" });
    return z.NEVER;
  },
);

type CanonicalInput = PlainValue | object | undefined;

// Array.isArray's `arg is any[]` predicate would smear `any` over the
// narrowed value; this guard keeps the element type explicit.
function isCanonicalArray(value: CanonicalInput): value is readonly CanonicalInput[] {
  return Array.isArray(value);
}

function renderCanonical(value: CanonicalInput): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new CanonicalJsonError({ message: "canonical JSON accepts finite numbers only" });
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (isCanonicalArray(value)) return `[${value.map((entry) => renderCanonical(entry)).join(",")}]`;
  if (typeof value === "object") {
    const prototype: object | null = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalJsonError({ message: "canonical JSON accepts plain objects only" });
    }
    const fields: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const nested = (value as PlainObject)[key];
      if (nested === undefined)
        throw new CanonicalJsonError({ message: `canonical JSON cannot express undefined at ${key}` });
      fields.push(`${JSON.stringify(key)}:${renderCanonical(nested)}`);
    }
    return `{${fields.join(",")}}`;
  }
  throw new CanonicalJsonError({ message: `canonical JSON cannot express a ${typeof value}` });
}

/**
 * Stable typed-key profile used when canonical JSON values need an in-memory
 * equality key rather than persisted JSON bytes. The primitive tags are an
 * established profile and deliberately remain byte-for-byte compatible with
 * policy conflict keys; accepting values is still owned by the one plain-JSON
 * grammar above.
 */
export function canonicalKey(value: PlainValue): string {
  if (!isPlainValue(value))
    throw new CanonicalJsonError({ message: "canonical key accepts plain JSON values only" });
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalKey).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalKey(value[key] as PlainValue)}`)
      .join(",")}}`;
  }
  return `${typeof value}:${JSON.stringify(value)}`;
}

/**
 * ONE canonical JSON byte owner for persisted facts that travel as text
 * (alarm payloads, message origins): sorted object keys, no whitespace,
 * finite numbers, plain data only. Every byte string it emits parses back
 * with `JSON.parse`; `canonicalKey` is the in-memory equality profile and
 * does not.
 */
export function canonicalJson(value: PlainValue): string {
  return renderCanonical(value);
}

/**
 * ONE digest owner for canonical JSON identity: sorted object keys, no
 * whitespace, finite numbers, plain data only — undefined and non-JSON
 * values fail loudly — hashed with sha256 under the `sha256:` prefix.
 */
export function canonicalDigest(value: PlainValue | object | undefined): string {
  return `sha256:${sha256Hex(renderCanonical(value))}`;
}

/**
 * ONE JSON wire parser. Text that is not JSON, a value that fails `schema`,
 * or a validation that throws (a hostile exotic value) all yield undefined;
 * the caller owns the drop, the warning, or the default that follows.
 */
export function parseJson<Output>(schema: z.ZodType<Output>, text: string): Output | undefined {
  try {
    const result = schema.safeParse(JSON.parse(text));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}
