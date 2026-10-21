import { z } from "zod";

/**
 * The app's one foreign-boundary decoder: a thrown value from a `try` body
 * becomes a string cause for the given failure constructor, mirroring the
 * package-owned `decode*Failure` decoders so no catch parameter stays untyped.
 */
export function foreignFailure<F>(
  construct: (fields: { readonly operation: string; readonly cause: string }) => F,
  operation: string,
) {
  return z
    .preprocess(String, z.string())
    .transform((cause) => construct({ operation, cause })).parse;
}
