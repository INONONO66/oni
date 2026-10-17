import type { ChildLifecycleEvidence } from "@openomni/protocol";
import type { ScreenState } from "../dialects/pack";
import type { StateReceipt } from "../reconcile";

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

/** The rule's inputs from one turn's joined receipts: the latest hook phase by seq, the transcript terminal as a fact. */
export function stateInput(receipts: readonly StateReceipt[]): Omit<ChildStateInput, "screen"> {
  let hook: { readonly seq: number; readonly phase: Phase } | undefined;
  let transcriptTerminal = false;
  for (const entry of receipts) {
    const ref = entry.receipt.ref;
    if ("kind" in ref) {
      if (hook === undefined || ref.seq > hook.seq) hook = { seq: ref.seq, phase: entry.fact.phase };
    } else if (entry.fact.phase === "terminal") {
      transcriptTerminal = true;
    }
  }
  return { ...(hook === undefined ? {} : { hook: hook.phase }), transcriptTerminal };
}
