import { z } from "zod";

/**
 * The thrown value as an Error: preserved when it already is one, wrapped
 * otherwise. zod is the narrowing layer for promise-rejection seams
 * (`Effect.tryPromise` catch), so no mapper parameter carries `unknown`.
 */
export const CaughtError = z.union([
  z.instanceof(Error),
  z.coerce.string().transform((text) => new Error(text)),
]);
