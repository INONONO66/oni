import { AutomationConfigurationError } from "../errors.js";

const patterns = new Map<string, RegExp>();

/** Compile at configuration admission; reuse the same stateless expression at match time. */
export function compiledPattern(pattern: string): RegExp {
  const cached = patterns.get(pattern);
  if (cached !== undefined) return cached;
  if (pattern.length > 512) throw new AutomationConfigurationError({ reason: "invalid_regex" });
  try {
    const compiled = new RegExp(pattern);
    patterns.set(pattern, compiled);
    return compiled;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new AutomationConfigurationError({ reason: "invalid_regex" });
  }
}
