import type { ChildLifecycleEvidence } from "@openomni/protocol";
import type { ScreenState } from "../dialects/pack";

/**
 * The idle/working/blocked data rule (#1512): an app judgement over the
 * reconciler's persisted facts, never a machine-side wait rule. `unknown`
 * fails closed — the contact writes nothing to a pane it cannot account for.
 */
export type ChildState = "idle" | "working" | "blocked" | "unknown";
type Phase = ChildLifecycleEvidence["phase"];

export interface ChildStateInput {
  /** The highest-sequence hook fact's phase for the turn; absent without hook evidence. */
  readonly hook?: Phase;
  /** Whether the transcript admitted the turn's terminal row (the turn's own end). */
  readonly transcriptTerminal: boolean;
  /**
   * The structural screen snapshot's manifest match (#1510). The seam is
   * typed here and unused in this increment: the snapshot read lands with
   * #1603, and screen state never ends a turn.
   */
  readonly screen?: ScreenState;
}

/**
 * Hook authority first: an open permission request blocks; a process end or
 * the transcript's terminal row is idle; any other hook phase is a turn in
 * flight (`observed` collapses the vendor's start/submit/stop events, so it
 * can only be read as working until the transcript ends the turn). The
 * screen decides only when neither file source has spoken.
 */
export function childState(input: ChildStateInput): ChildState {
  if (input.hook === "waiting") return "blocked";
  if (input.hook === "terminal" || input.transcriptTerminal) return "idle";
  if (input.hook !== undefined) return "working";
  if (input.screen === "permission_prompt") return "blocked";
  if (input.screen === "working") return "working";
  if (input.screen === "idle_prompt") return "idle";
  return "unknown";
}

/** One joined receipt as the rule reads it: its fact's phase and the source reference that carried it. */
export interface StateEvidence {
  readonly phase: Phase;
  readonly ref: ChildLifecycleEvidence["ref"];
}

/**
 * The rule's inputs as a running fold over one turn's receipts (#1512 r2 L9):
 * the latest hook phase by sequence and whether the transcript ended the
 * turn. Two scalars per turn, however many receipts the turn admits — the
 * runner keeps this, never the rows.
 */
export interface StateFold {
  readonly hook?: { readonly seq: number; readonly phase: Phase };
  readonly transcriptTerminal: boolean;
}

export const NOTHING_SPOKEN: StateFold = { transcriptTerminal: false };

/** One more receipt: a higher hook sequence replaces the hook phase; a transcript terminal row is a fact that stays. */
export function foldState(current: StateFold, evidence: StateEvidence): StateFold {
  const ref = evidence.ref;
  if ("kind" in ref)
    return current.hook === undefined || ref.seq > current.hook.seq ? { ...current, hook: { seq: ref.seq, phase: evidence.phase } } : current;
  return evidence.phase === "terminal" && !current.transcriptTerminal ? { ...current, transcriptTerminal: true } : current;
}

/** The rule's input from a fold: the latest hook phase, the transcript terminal as a fact. */
export function stateInputOf(fold: StateFold): Omit<ChildStateInput, "screen"> {
  return { ...(fold.hook === undefined ? {} : { hook: fold.hook.phase }), transcriptTerminal: fold.transcriptTerminal };
}
