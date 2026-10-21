import { describe, test, expect } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { z } from "zod";

import { NamedError } from "../src/error/index.js";

const packageRoot = join(import.meta.dir, "..");

describe("NamedError.create", () => {
  const MyError = NamedError.create(
    "MyError",
    z.object({
      message: z.string(),
      detail: z.number(),
    }),
  );

  test("returns a class with static schema helpers", () => {
    expect(typeof MyError).toBe("function");
    expect(MyError.name).toBe("MyError");
    expect(MyError.Schema).toBeDefined();
    expect(MyError.isInstance).toBeDefined();
  });

  test("creates instances with message and data from payload", () => {
    const error = new MyError({ message: "boom", detail: 42 });

    expect(error.name).toBe("MyError");
    expect(error.message).toBe("boom");
    expect(error.data).toEqual({ message: "boom", detail: 42 });
  });

  test("falls back to the error name when payload has no message", () => {
    const NoMessageError = NamedError.create(
      "NoMessageError",
      z.object({
        detail: z.number(),
      }),
    );

    const error = new NoMessageError({ detail: 7 });

    expect(error.message).toBe("NoMessageError");
    expect(error.data).toEqual({ detail: 7 });
  });

  test("returns the schema and object shape", () => {
    const error = new MyError({ message: "shape", detail: 1 });

    expect(error.schema()).toBe(MyError.Schema);
    expect(error.toObject()).toEqual({
      name: "MyError",
      data: { message: "shape", detail: 1 },
    });
  });

  test("sets cause when provided", () => {
    const cause = new Error("cause");
    const error = new MyError({ message: "boom", detail: 1 }, { cause });

    expect(Reflect.get(error, "cause")).toBe(cause);
  });

  test.each([null, false, 0, ""])("retains an explicitly provided falsy cause: %p", (cause) => {
    const error = new MyError({ message: "boom", detail: 1 }, { cause });

    expect(Object.getOwnPropertyDescriptor(error, "cause") !== undefined).toBe(true);
    expect(Reflect.get(error, "cause")).toBe(cause);
  });

  test("distinguishes omitted cause from an explicitly present undefined cause", () => {
    const omitted = new MyError({ message: "omitted", detail: 1 });
    const explicit = new MyError({ message: "explicit", detail: 1 }, { cause: undefined });

    expect(Object.getOwnPropertyDescriptor(omitted, "cause") !== undefined).toBe(false);
    expect(Object.getOwnPropertyDescriptor(explicit, "cause") !== undefined).toBe(true);
    expect(Reflect.get(explicit, "cause")).toBeUndefined();
  });

  test("isInstance matches real instances", () => {
    expect(MyError.isInstance(new MyError({ message: "ok", detail: 1 }))).toBe(true);
  });

  test("isInstance rejects null", () => {
    expect(MyError.isInstance(null)).toBe(false);
  });

  test("isInstance rejects plain objects with the same name", () => {
    expect(MyError.isInstance({ name: "MyError" })).toBe(false);
  });

  test("isInstance rejects plain objects with a different name", () => {
    expect(MyError.isInstance({ name: "OtherError" })).toBe(false);
  });

  test("isInstance recognizes instances from an independent copy of the class", () => {
    // bun resolves each workspace symlink to @oni/protocol separately,
    // so one process can hold two copies of the same generated class; the
    // guard must match across copies. A second create() with the same name
    // reproduces that dual-load shape.
    const CopyError = NamedError.create(
      "MyError",
      z.object({ message: z.string(), detail: z.number() }),
    );
    expect(MyError.isInstance(new CopyError({ message: "ok", detail: 1 }))).toBe(true);
  });

  test("isInstance rejects a real Error whose name merely matches", () => {
    const impostor = new Error("boom");
    impostor.name = "MyError";
    expect(MyError.isInstance(impostor)).toBe(false);
  });
});

// #500 C3: the APIError suite moved to packages/llm/test/error.test.ts with the
// schema — llm is its home now.

// NamedError payloads are object-shaped by contract: NamedError.create rejects
// non-object schemas at the type level (Data extends z.ZodType<object, object>),
// so the former string-payload fallback suite is unrepresentable. The
// name-fallback behavior itself is covered by the NoMessageError test above.

test("emits a concrete cross-package guard type", () => {
  const fixtureDirectory = join(import.meta.dir, ".named-error-declaration-fixture");
  const fixture = join(fixtureDirectory, "consumer.ts");
  mkdirSync(fixtureDirectory, { recursive: true });
  writeFileSync(
    fixture,
    `import { NamedError } from "@oni/protocol";
import { z } from "zod";
const ConcreteError = NamedError.create("ConcreteError", z.object({ message: z.string(), detail: z.number() }));
class DerivedError extends ConcreteError {
  derivedOnly(): string { return "derived"; }
}
declare const error: Error;
if (ConcreteError.isInstance(error)) {
  const message: string = error.data.message;
  const detail: number = error.data.detail;
  const missing: string = error.data.missing;
  const wrong: number = error.data.message;
}
const guard = ConcreteError.isInstance;
if (guard(error)) {
  const detachedMessage: string = error.data.message;
}
if (DerivedError.isInstance(error)) {
  const subclassMessage: string = error.data.message;
  const subclassOnly: string = error.derivedOnly();
}
`,
  );
  try {
    const program = ts.createProgram([fixture], {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      baseUrl: fixtureDirectory,
      paths: {
        "@oni/protocol": [join(packageRoot, "dist", "index.d.ts")],
        zod: [join(packageRoot, "node_modules", "zod", "index.d.ts")],
      },
    });
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
    expect(diagnostics.map((diagnostic) => diagnostic.code).sort()).toEqual([2322, 2339, 2339]);
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test("isInstance refuses a same-named error whose data violates this factory's schema", () => {
  const A = NamedError.create("SharedName", z.object({ code: z.string() }));
  const B = NamedError.create("SharedName", z.object({ count: z.number() }));
  const fromB = new B({ count: 3 });
  // Same brand value (name), incompatible payload contract: the guard's type
  // predicate must not admit it, or consumers read absent fields.
  expect(A.isInstance(fromB)).toBe(false);
  expect(B.isInstance(fromB)).toBe(true);
  expect(A.isInstance(new A({ code: "ok" }))).toBe(true);
});
