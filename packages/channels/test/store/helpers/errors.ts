import { expect } from "bun:test";
import type { PlainValue } from "@oni/protocol";

export function expectNamedFailure(
  operation: () => void,
  errorName: string,
  fields: Record<string, PlainValue>,
): void {
  const expectedFields: object = expect.objectContaining(fields);
  expect(operation).toThrow(
    expect.objectContaining({
      name: errorName,
      [Symbol.for("oni.protocol.namedError")]: errorName,
      data: expectedFields,
    }),
  );
}
