/**
 * A composition/wiring invariant violation: a state the app promised could
 * not occur. Thrown from plain code (where it surfaces as an Effect defect,
 * never a typed refusal) so callers cannot `catchTag` their way past a bug.
 */
export class AppInvariantError extends Error {
  /** The machine-consumed refusal code (#1256 r3 M-4); messages stay prose. */
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "AppInvariantError";
    if (code !== undefined) this.code = code;
  }
}
