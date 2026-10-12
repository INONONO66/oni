import { type Effect, type Layer, Schema } from "effect";
import type { z } from "zod";
import type {
  AnyToolDefinition,
  GateRow,
  PlainValue,
  PointId,
  Tool,
} from "@openomni/protocol";
import type { AlarmFired } from "./alarm";
import type { SessionError } from "./failure";
import type { BundleLayerServices } from "./ports";

/**
 * The three #1255 declaration contracts: `Capability.define` (removable
 * built-in plugins: alarm, action, hook, compaction, tool), `Bundle.define`
 * (product compositions) and `Manifest.define` (the list of what is on).
 * Only capabilities declare journal kinds, points and loop steps; bundles
 * consume capability verbs through seams and never declare kinds — compose
 * (#1255 S2) rejects `product_declares_kind`. Declarations are plain frozen
 * data; `compose(manifest)` turns them into one journaled generation.
 */

/**
 * A seam identity: what a capability publishes and a declaration's `requires`
 * resolves against at compose. A seam is a KEY, deliberately not a
 * `Context.Service`: no composed context provides or reads one today, and the
 * boundary gate refuses an unread service tag (R9). Promotion to a live
 * service is additive — an Effect `Context.Service` class carries the same
 * `key` field, so one may stand where a `SeamTag` is expected.
 */
export interface SeamTag {
  readonly key: string;
}

/** `@openomni/<owner>/<Name>` — the key law the boundary gate holds Context tags to (R4). */
const SEAM_KEY = /^@openomni\/[a-z][a-z0-9-]*\/[A-Za-z][\w/-]*$/;

/**
 * Typed define-time refusal: `namespace` (a malformed name — the former
 * `BundleError{code: namespace}` moved here), `capability_declares_tools`
 * (model tools are bundle-owned) and `duplicate` (a repeated declaration
 * inside one contract).
 */
export class DefineRefused extends Schema.TaggedError<DefineRefused>(
  "@openomni/agent/core/DefineRefused",
)("DefineRefused", {
  code: Schema.Literals(["namespace", "capability_declares_tools", "duplicate"]),
  name: Schema.String,
  detail: Schema.String,
}) {}

/** Typed failure a capability's `onInput`/`onWake`/`step` hook reports. */
export class CapabilityHookError extends Schema.TaggedError<CapabilityHookError>(
  "@openomni/agent/core/CapabilityHookError",
)("CapabilityHookError", {
  capability: Schema.String,
  reason: Schema.String,
}) {}

/**
 * One journal kind a capability owns: its body schema, payload version and
 * fold reducer. The kind set stays closed (#1252); a capability's kind is
 * only registered while its owner is composed — rows of an off capability
 * stay opaque in the fold and reject as `deliver` input with `unknown_kind`.
 */
export interface CapabilityKindDeclaration {
  readonly schema: z.ZodType;
  readonly version: number;
  readonly reduce: (state: PlainValue, row: PlainValue) => PlainValue;
}

/**
 * The core context handed to a loaded capability's hooks (#1255). Frozen at
 * S1: later steps add fields, never rename.
 */
export interface CapabilityCore {
  /** The session the hook runs for. */
  readonly sessionId: string;
  /** Epoch-ms clock injected by the composition root. */
  readonly now: () => number;
}

/** The committed input row view a capability's `onInput` receives. */
export interface CapabilityInputRow {
  readonly kind: string;
  readonly seq: number;
  /** Canonical JSON of the committed row body. */
  readonly body: string;
}

/** The loop steps a capability may own; today only the tool step exists. */
export interface CapabilityStep {
  readonly tool?: (
    core: CapabilityCore,
    call: Tool.Call,
  ) => Effect.Effect<Tool.Result, CapabilityHookError>;
}

interface CapabilityHooks {
  readonly onInput?: (
    core: CapabilityCore,
    row: CapabilityInputRow,
  ) => Effect.Effect<void, CapabilityHookError>;
  readonly onWake?: (
    core: CapabilityCore,
    fired: AlarmFired,
  ) => Effect.Effect<void, CapabilityHookError>;
  readonly step?: CapabilityStep;
}

export interface CapabilityInput<
  Name extends string = string,
  Seam extends SeamTag = SeamTag,
  Verbs = object,
  Purpose = object,
  Handler = object,
> extends CapabilityHooks {
  readonly name: Name;
  /** Other capabilities' seam NAMES — resolution is by name, never by import. */
  readonly requires: readonly string[];
  readonly kinds?: Readonly<Record<string, CapabilityKindDeclaration>>;
  /** Journal kinds `deliver` may accept as input (action capability only). */
  readonly inputs?: readonly string[];
  readonly points?: readonly PointId[];
  /** Alarm purposes this capability registers (the alarm capability owns the registry). */
  readonly purposes?: Readonly<Record<string, Purpose>>;
  /** `how.ref` targets this capability registers. */
  readonly handlers?: Readonly<Record<string, Handler>>;
  /** The seam services other declarations consume via `requires`. */
  readonly verbs: Verbs;
  /** The Context tag others receive when they require this capability. */
  readonly seam: Seam;
  /** Model tools are bundle-owned; a capability declaring them refuses at define time. */
  readonly tools?: never;
}

export interface CapabilityDefinition<
  Name extends string = string,
  Seam extends SeamTag = SeamTag,
  Verbs = object,
  Purpose = object,
  Handler = object,
> extends CapabilityHooks {
  readonly contract: "capability";
  readonly name: Name;
  readonly requires: readonly string[];
  readonly kinds: Readonly<Record<string, CapabilityKindDeclaration>>;
  readonly inputs: readonly string[];
  readonly points: readonly PointId[];
  readonly purposes: Readonly<Record<string, Purpose>>;
  readonly handlers: Readonly<Record<string, Handler>>;
  readonly verbs: Verbs;
  readonly seam: Seam;
}

const NAME_SHAPE = /^[a-z][a-z0-9-]*$/;

function refuse(code: DefineRefused["code"], name: string, detail: string): never {
  throw new DefineRefused({ code, name, detail });
}

function checkName(name: string): void {
  if (!NAME_SHAPE.test(name)) refuse("namespace", name, name);
}

function checkUnique(values: readonly string[], name: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) refuse("duplicate", name, value);
    seen.add(value);
  }
}

function checkSeam(tag: SeamTag, name: string): void {
  if (!SEAM_KEY.test(tag.key)) refuse("namespace", name, tag.key);
}

/** `Bundle.seam(key)` — the one seam constructor; a key outside the `@openomni/<owner>/` law refuses `namespace`. */
export function seam(key: string): SeamTag {
  checkSeam({ key }, key);
  return Object.freeze({ key });
}

function defineCapability<
  const Name extends string,
  Seam extends SeamTag,
  Verbs,
  Purpose = object,
  Handler = object,
>(
  input: CapabilityInput<Name, Seam, Verbs, Purpose, Handler>,
): CapabilityDefinition<Name, Seam, Verbs, Purpose, Handler> {
  checkName(input.name);
  if ("tools" in input && input.tools !== undefined)
    refuse("capability_declares_tools", input.name, "model tools are bundle-owned");
  checkUnique(input.requires, input.name);
  checkUnique(input.points ?? [], input.name);
  checkUnique(input.inputs ?? [], input.name);
  checkSeam(input.seam, input.name);
  return Object.freeze({
    contract: "capability" as const,
    name: input.name,
    requires: Object.freeze([...input.requires]),
    kinds: Object.freeze({ ...(input.kinds ?? {}) }),
    inputs: Object.freeze([...(input.inputs ?? [])]),
    points: Object.freeze([...(input.points ?? [])]),
    purposes: Object.freeze({ ...(input.purposes ?? {}) }),
    handlers: Object.freeze({ ...(input.handlers ?? {}) }),
    verbs: input.verbs,
    seam: input.seam,
    ...(input.onInput === undefined ? {} : { onInput: input.onInput }),
    ...(input.onWake === undefined ? {} : { onWake: input.onWake }),
    ...(input.step === undefined ? {} : { step: input.step }),
  });
}

/** `Capability.define` — the one way a removable built-in declares what it owns. */
export const Capability = Object.freeze({ define: defineCapability });

/**
 * A bundle's acquisition Layer (#1255 P3): acquired inside the generation's
 * Scope over the seed services, failing only with the typed session errors
 * the generation's `configure`/`capture` unwind on — anything else is a defect.
 */
type BundleLayer = Layer.Layer<never, SessionError, BundleLayerServices>;

/** One bundle tool face; `idempotent` survives into the generation tool table. */
export type BundleTool = AnyToolDefinition & { readonly idempotent?: boolean };

/** One gate row a bundle contributes (#1251 row contract; generation assigned at compose). */
export type BundleGateRow = Omit<GateRow, "generation">;

export interface BundleContractInput<Name extends string, Handler, Purpose> {
  readonly name: Name;
  /** Capability seam tags or other bundles' provides tags. */
  readonly requires: readonly SeamTag[];
  /** Services published for later bundles. */
  readonly provides?: readonly SeamTag[];
  /** Implementation of `provides`. */
  readonly layer?: BundleLayer;
  readonly tools?: readonly BundleTool[];
  readonly rows?: readonly BundleGateRow[];
  /** `how.ref` targets (requires the action capability). */
  readonly handlers?: Readonly<Record<string, Handler>>;
  /** Alarm purposes (requires the alarm capability). */
  readonly purposes?: Readonly<Record<string, Purpose>>;
  /** Kinds, points and loop steps are capability-owned (`product_declares_kind`). */
  readonly kinds?: never;
  readonly points?: never;
  readonly step?: never;
}

export interface BundleContract<
  Name extends string = string,
  Handler = object,
  Purpose = object,
> {
  readonly contract: "bundle";
  readonly name: Name;
  readonly requires: readonly SeamTag[];
  readonly provides: readonly SeamTag[];
  readonly layer: BundleLayer | undefined;
  readonly tools: readonly BundleTool[];
  readonly rows: readonly BundleGateRow[];
  readonly handlers: Readonly<Record<string, Handler>>;
  readonly purposes: Readonly<Record<string, Purpose>>;
}

/** `Bundle.define` — the product-side contract; never kinds, points or steps. */
export function defineBundle<const Name extends string, Handler = object, Purpose = object>(
  input: BundleContractInput<Name, Handler, Purpose>,
): BundleContract<Name, Handler, Purpose> {
  checkName(input.name);
  checkUnique(input.requires.map((tag) => tag.key), input.name);
  checkUnique((input.provides ?? []).map((tag) => tag.key), input.name);
  checkUnique((input.tools ?? []).map((tool) => tool.name), input.name);
  checkUnique((input.rows ?? []).map((row) => row.id), input.name);
  for (const tag of [...input.requires, ...(input.provides ?? [])]) checkSeam(tag, input.name);
  return Object.freeze({
    contract: "bundle" as const,
    name: input.name,
    requires: Object.freeze([...input.requires]),
    provides: Object.freeze([...(input.provides ?? [])]),
    layer: input.layer,
    tools: Object.freeze([...(input.tools ?? [])]),
    rows: Object.freeze([...(input.rows ?? [])]),
    handlers: Object.freeze({ ...(input.handlers ?? {}) }),
    purposes: Object.freeze({ ...(input.purposes ?? {}) }),
  });
}

export interface ManifestInput {
  readonly capabilities: readonly CapabilityDefinition[];
  readonly bundles: readonly BundleContract[];
  /** Capability or bundle names turned off; compose cascades transitively. */
  readonly off?: readonly string[];
}

/** The single product list of what is on — plain data consumed by compose. */
export interface ManifestDefinition {
  readonly capabilities: readonly CapabilityDefinition[];
  readonly bundles: readonly BundleContract[];
  readonly off: readonly string[];
}

function defineManifest(input: ManifestInput): ManifestDefinition {
  checkUnique(
    [
      ...input.capabilities.map((capability) => capability.name),
      ...input.bundles.map((bundle) => bundle.name),
    ],
    "manifest",
  );
  checkUnique(input.off ?? [], "manifest");
  return Object.freeze({
    capabilities: Object.freeze([...input.capabilities]),
    bundles: Object.freeze([...input.bundles]),
    off: Object.freeze([...(input.off ?? [])]),
  });
}

/** `Manifest.define` — plain data; boot is config → manifest → compose → runtime. */
export const Manifest = Object.freeze({ define: defineManifest });
