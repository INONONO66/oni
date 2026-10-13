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

/** Only capabilities declare journal kinds, points and loop steps; bundles consume capability verbs through seams and never declare kinds. */

/** A seam is a KEY, deliberately not a `Context.Service`: nothing reads one today and the boundary gate refuses an unread tag. A service class carrying `key` may stand in. */
export interface SeamTag {
  readonly key: string;
}

/** `@openomni/<owner>/<Name>` — the key law the boundary gate holds Context tags to. */
const SEAM_KEY = /^@openomni\/[a-z][a-z0-9-]*\/[A-Za-z][\w/-]*$/;

/** `capability_declares_tools`: model tools are bundle-owned. */
export class DefineRefused extends Schema.TaggedError<DefineRefused>(
  "@openomni/agent/core/DefineRefused",
)("DefineRefused", {
  code: Schema.Literals(["namespace", "capability_declares_tools", "duplicate"]),
  name: Schema.String,
  detail: Schema.String,
}) {}

export class CapabilityHookError extends Schema.TaggedError<CapabilityHookError>(
  "@openomni/agent/core/CapabilityHookError",
)("CapabilityHookError", {
  capability: Schema.String,
  reason: Schema.String,
}) {}

/** A kind is registered only while its owner is composed: rows of an off capability stay opaque in the fold and reject as `deliver` input. */
export interface CapabilityKindDeclaration {
  readonly schema: z.ZodType;
  readonly version: number;
  readonly reduce: (state: PlainValue, row: PlainValue) => PlainValue;
}

export interface CapabilityCore {
  readonly sessionId: string;
  /** Injected by the composition root. */
  readonly now: () => number;
}

export interface CapabilityInputRow {
  readonly kind: string;
  readonly seq: number;
  readonly body: string;
}

/** Today only the tool step exists. */
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
  /** Resolution is by NAME, never by import. */
  readonly requires: readonly string[];
  readonly kinds?: Readonly<Record<string, CapabilityKindDeclaration>>;
  readonly inputs?: readonly string[];
  readonly points?: readonly PointId[];
  readonly purposes?: Readonly<Record<string, Purpose>>;
  readonly handlers?: Readonly<Record<string, Handler>>;
  readonly verbs: Verbs;
  readonly seam: Seam;
  /** Model tools are bundle-owned; declaring them refuses at define time. */
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

/** A key outside the `@openomni/<owner>/` law refuses `namespace`. */
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

export const Capability = Object.freeze({ define: defineCapability });

/** Acquired inside the generation's Scope; fails only with the typed session errors the generation unwinds on — anything else is a defect. */
type BundleLayer = Layer.Layer<never, SessionError, BundleLayerServices>;

export type BundleTool = AnyToolDefinition & { readonly idempotent?: boolean };

/** Generation assigned at compose. */
export type BundleGateRow = Omit<GateRow, "generation">;

export interface BundleContractInput<Name extends string, Handler, Purpose> {
  readonly name: Name;
  readonly requires: readonly SeamTag[];
  readonly provides?: readonly SeamTag[];
  readonly layer?: BundleLayer;
  readonly tools?: readonly BundleTool[];
  readonly rows?: readonly BundleGateRow[];
  /** Requires the action capability. */
  readonly handlers?: Readonly<Record<string, Handler>>;
  /** Requires the alarm capability. */
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
  /** Compose cascades transitively. */
  readonly off?: readonly string[];
}

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

/** Boot is config → manifest → compose → runtime. */
export const Manifest = Object.freeze({ define: defineManifest });
