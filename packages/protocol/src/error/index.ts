import { z } from "zod";

// Cross-copy identity brand: bun resolves each workspace package's
// node_modules symlink to @oni/protocol independently, so one process
// can hold two copies of a generated error class. `instanceof` alone is
// therefore unsound across package boundaries; the Symbol.for-registered
// brand carries the error name and is set only by this factory, so the
// guard recognizes instances from any copy while still rejecting plain
// objects that merely mimic the `name` property. The brand alone cannot
// distinguish same-named factories with different schemas, so isInstance
// additionally validates the candidate's `data` against this factory's
// schema — the guard's type predicate is only sound when the payload
// actually has the promised shape.
const NAMED_ERROR_BRAND = Symbol.for("oni.protocol.namedError");

// Payloads are object-shaped by contract: an unconstrained z.ZodType defaults
// to ZodType<unknown, unknown>, which would leak `unknown` into every
// generated class and every caller.
type NamedErrorData = z.ZodType<object, object>;

// Extracts a human message from an otherwise opaque payload without ever
// touching an untyped property access.
const MessageCarrier = z.object({ message: z.string() });

type NamedErrorInstance<Name extends string, Data extends NamedErrorData> = NamedError & {
  readonly name: Name;
  readonly data: z.input<Data>;
  schema(): z.ZodObject<{ name: z.ZodLiteral<Name>; data: Data }>;
  toObject(): { name: Name; data: z.input<Data> };
};

// Explicit static shape of a generated class. Annotating create's return type
// keeps the generated class fully typed; left to inference it resolves to an
// implicit any through the class expression in buildNamedErrorClass.
export type NamedErrorClass<Name extends string, Data extends NamedErrorData> = {
  new (
    data: z.input<Data>,
    options?: { cause?: Error | null | boolean | number | string | undefined },
  ): NamedErrorInstance<Name, Data>;
  readonly Schema: z.ZodObject<{ name: z.ZodLiteral<Name>; data: Data }>;
  readonly prototype: NamedErrorInstance<Name, Data>;
  isInstance<Input>(input: Input): input is Input & NamedErrorInstance<Name, Data>;
};

// The generated class lives in this module-scope, non-generic builder: a class
// expression declared inside a generic function carries the outer type
// parameters, and TypeScript instantiates its `prototype` with `any` — an
// owned implicit-any reachable from every factory result. The base class is a
// parameter (not a captured binding) so the builder has no dependency on the
// module-scope class binding.
function buildNamedErrorClass(
  base: typeof NamedError,
  name: string,
  data: NamedErrorData,
): NamedErrorClass<string, NamedErrorData> {
  const schema = z.object({
    name: z.literal(name),
    data,
  });
  const result = class extends base {
    public static readonly Schema = schema;

    public override readonly name = name;

    constructor(
      public readonly data: z.input<NamedErrorData>,
      options?: { cause?: Error | null | boolean | number | string | undefined },
    ) {
      const carried = MessageCarrier.safeParse(data);
      super(carried.success ? carried.data.message : name);
      if (options !== undefined && "cause" in options) {
        Object.defineProperty(this, "cause", {
          value: options.cause,
          configurable: true,
          writable: true,
        });
      }
      this.name = name;
    }

    static isInstance<Input>(
      input: Input,
    ): input is Input & NamedErrorInstance<string, NamedErrorData> {
      if (!(input instanceof Error)) return false;
      if (Reflect.get(input, NAMED_ERROR_BRAND) !== name) {
        return false;
      }
      return data.safeParse(Reflect.get(input, "data")).success;
    }

    schema() {
      return schema;
    }

    toObject() {
      return {
        name: name,
        data: this.data,
      };
    }
  };
  Object.defineProperty(result, "name", { value: name });
  Object.defineProperty(result.prototype, NAMED_ERROR_BRAND, { value: name });
  return result;
}

// Deliberate variance boundary, not a suppression: the builder captures
// exactly `name` and `data`, so the returned class enforces the narrow
// contract at runtime; only the static type is refined back to the caller's
// literals. Overload resolution performs the refinement so no top type
// appears.
function refineNamedErrorClass<Name extends string, Data extends NamedErrorData>(
  generated: NamedErrorClass<string, NamedErrorData>,
): NamedErrorClass<Name, Data>;
function refineNamedErrorClass(generated: NamedErrorClass<string, NamedErrorData>) {
  return generated;
}

export abstract class NamedError extends Error {
  protected constructor(message: string) {
    super(message);
    this.name = "NamedError";
  }

  abstract schema(): z.ZodType<object, object>;
  abstract toObject(): { name: string; data: object };

  static create<Name extends string, Data extends NamedErrorData>(
    name: Name,
    data: Data,
  ): NamedErrorClass<Name, Data> {
    return refineNamedErrorClass<Name, Data>(buildNamedErrorClass(NamedError, name, data));
  }

}

// #500 C3: NamedError STAYS here — it is consumed by protocol's own schemas
// (json.ts CanonicalJsonError, channel/index.ts SurfaceKeyError,
// provisioning/schema.ts StoreError/VaultError, ledger/l0.ts ConfigureError).
// The concrete errors that lived beside it moved to their caller-proven
// owners: APIError → the agent model plane (model/error.ts — model-only
// callers).
