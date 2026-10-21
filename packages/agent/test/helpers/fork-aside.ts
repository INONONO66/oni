import type { SessionGeneration } from "@oni/protocol";
import type { NamedTransformer } from "../../src/core/gate/registry";
import { FORK_ASIDE_REF, forkAside } from "../../src/inspect/tree";

/**
 * The registration-ready `prompt.pre` transformer that prepends the fork
 * aside to a string prompt value (test-only — no composition registers
 * it, so it lives next to its only consumer). Anything else (a root session,
 * a non-string value) passes through unchanged.
 */
export function forkAsideTransformer(
  ancestryOf: (sessionId: string) => SessionGeneration.ForkAncestry | null,
  sessionId: string,
): NamedTransformer {
  return {
    name: FORK_ASIDE_REF,
    apply: (args) => {
      const ancestry = ancestryOf(sessionId);
      if (ancestry === null || args === null || typeof args !== "object" || Array.isArray(args))
        return args;
      // The prompt.pre point's one rewritable text field is `body`.
      const body = args.body;
      if (typeof body !== "string") return args;
      return { ...args, body: `${forkAside(ancestry)}\n\n${body}` };
    },
  };
}
