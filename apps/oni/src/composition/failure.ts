import { z } from "zod";
import { Core } from "@oni/agent";
import { AppInvariantError } from "../invariant";

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

/** Preserve the facade's failure and defect contract while Core owns the fenced write. */
export const configureFailures = {
  commitFailure: foreignFailure((fields) => new Core.AgentFailure(fields), "session.configure"),
  missingAuthority: (id: string) => new AppInvariantError(`session has no activation authority: ${id}`),
};
