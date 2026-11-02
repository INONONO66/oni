import { z } from "zod";
import { EpochMs } from "../time.js";
import { ChildLifecycleEvidence } from "../transcript/reference.js";

const Id = z.string().min(1);

/**
 * Child current-state wire surface (#1604): a console or `cli:` contact asks
 * for one child turn's derived state and receives the reconciler's winning
 * receipt as plain facts. Every field is a reference or a phase name; the
 * remote transcript's bytes never cross this frame.
 */
export namespace ChildState {
  export const Phase = ChildLifecycleEvidence.shape.phase;
  export type Phase = z.infer<typeof Phase>;

  /** The authority the winning receipt came from, lowest to highest. */
  export const Source = z.enum(["screen", "transcript", "hook"]);
  export type Source = z.infer<typeof Source>;

  export const Request = z.object({
    type: z.literal("child_state"),
    requestId: Id,
    /** The parent session whose journal admitted the child's rows. */
    sessionId: Id,
    child: Id,
    turn: Id,
  }).strict();
  export type Request = z.infer<typeof Request>;

  export const Frame = z.object({
    type: z.literal("child_state"),
    requestId: Id,
    sessionId: Id,
    child: Id,
    turn: Id,
    phase: Phase,
    source: Source,
    /** When the winning receipt was first observed; a later read of the same bytes keeps it. */
    since: EpochMs,
    /** Every admitted fact of this turn in admission order, including the one the phase came from. */
    facts: z.array(z.object({ toolUseId: Id.optional(), phase: Phase }).strict()),
    /** The winning receipt's diagnostics, then the turn's damaged-record diagnostics. */
    diagnostics: ChildLifecycleEvidence.shape.diagnostics,
  }).strict();
  export type Frame = z.infer<typeof Frame>;

  export const Reason = z.enum(["invalid_request", "unavailable", "session_not_found", "unknown"]);
  export type Reason = z.infer<typeof Reason>;

  export const Refused = z.object({
    type: z.literal("child_state_refused"),
    requestId: Id,
    reason: Reason,
    detail: z.string(),
  }).strict();
  export type Refused = z.infer<typeof Refused>;

  export const Response = z.union([Frame, Refused]);
  export type Response = z.infer<typeof Response>;
}
