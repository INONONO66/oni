/**
 * The transcript's INPUT SHAPE — what a ledger column has to be handed in order
 * to be laid out, and nothing else.
 *
 * This is the boundary that lets the transcript live in the design system at
 * all. `apps/desktop`'s mock declares a `TimelineNode` carrying a
 * `PolicyVerdict`, per-call `phases`, and a `RunState` — kernel vocabulary, and
 * correctly the app's. The transcript reads NONE of it. What layout actually
 * needs is: who spoke, in what order, what a tool call was called, how it
 * ended, and where the ledger's own boundaries are.
 *
 * No state here is a product state. `ToolStatus` is a CALL OUTCOME, and the
 * only structural question the layout asks of it is "may this row be folded
 * away" — never "what is this run doing". A product that called its states
 * `green`/`amber`/`red` would map onto this unchanged.
 */

/**
 * A tool call's state, as the transcript needs to reason about it.
 *
 * `done` is the default and stays implicit: the overwhelming majority of a
 * transcript's calls succeeded, and a field repeated on forty rows to say
 * "nothing went wrong" is noise in the data as much as on screen.
 *
 * The other four are exactly the states that print a WORD on the row and that a
 * collapse may never hide. That is one rule expressed once — `LOUD` below is
 * derived from this union, so a new loud state cannot be added to the type
 * without the never-hide rule picking it up.
 */
export type ToolStatus = "done" | "running" | "waiting" | "failed" | "denied";

/**
 * One block of an agent's answer: a paragraph of prose, and nothing else.
 *
 * A discriminated union with required payload per kind (#1312): the former
 * optional `text`/`items`/`lines` let a payload-less block type-check and
 * render an empty element, and the `h2`/`bullets`/`code` variants had no
 * production producer (the desktop adapter emits paragraphs only). Adding a
 * variant later means adding its producer in the same PR.
 */
export interface TranscriptMarkdown {
  readonly kind: "p";
  readonly text: string;
}

/** The Owner's turn. Right-aligned prose; no fill, no border, no marker. */
export interface TranscriptPrompt {
  readonly kind: "prompt";
  readonly id: string;
  readonly text: string;
  /** Shared by text and attachments from the same user message. */
  readonly promptId?: string;
}

/** A labelled machine reference, never browser-fetchable media. */
export interface TranscriptAttachment {
  readonly kind: "attachment";
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly ref: string;
  /** Present for user attachments, including attachment-only prompts. */
  readonly promptId?: string;
}

/**
 * A ledger boundary — a compaction, a resume. Something that happened TO the
 * ledger, not a separator between turns: routine turns are divided by
 * whitespace, and only a real event earns a rule.
 */
export interface TranscriptEpoch {
  readonly kind: "epoch";
  readonly id: string;
  readonly label: string;
  /** Already formatted for reading: `11:31`. */
  readonly at: string;
}

/**
 * One tool call in the ledger — one 12px mono line.
 *
 * `payload` is what the chevron reveals. Its absence is what makes the row
 * inert: a disclosure that opens onto nothing is a control that lies, so the
 * chevron slot renders empty rather than clickable when there is nothing under
 * it.
 */
export interface TranscriptTool {
  readonly kind: "tool";
  readonly id: string;
  /** The verb: `read`, `edit`, `shell`. One word, lowercase, the surface's. */
  readonly tool: string;
  /** What it acted on: a path, a command, a pattern. */
  readonly target: string;
  /** Already formatted: `34ms`, `1.8s`. Absent while a call is still open. */
  readonly duration?: string;
  readonly status?: Exclude<ToolStatus, "done">;
  /** Revealed by the chevron. No payload, no chevron. */
  readonly payload?: readonly string[];
}

/** The agent's turn: prose with no box, no avatar, and no name. */
export interface TranscriptAssistant {
  readonly kind: "assistant";
  readonly id: string;
  readonly blocks: readonly TranscriptMarkdown[];
  readonly streaming: boolean;
}

/** The flat ledger, in order. `segmentTurns` gives it structure. */
export type TranscriptNode =
  | TranscriptPrompt
  | TranscriptEpoch
  | TranscriptTool
  | TranscriptAttachment
  | TranscriptAssistant;

/**
 * A decision the agent is blocked on.
 *
 * It is NOT a transcript node. A pending approval is not a thing that happened
 * in the ledger — it is a thing that is happening to the Owner right now, and
 * the surface that owns "right now" is the input zone. So it docks above the
 * composer and the transcript's matching tool row prints `waiting for
 * approval` and nothing else. Two places to approve one call is one place too
 * many, and the inline one is the one that scrolls away.
 */
export interface PendingApproval {
  /** Matches the `id` of the `TranscriptTool` row this decision blocks. */
  readonly toolId: string;
  /** `shell wants to run npm test` — one sentence, the surface's words. */
  readonly summary: string;
  /** Why it stopped here: `outside declared scope`. */
  readonly reason: string;
}

/**
 * What a turn cost. Shown on HOVER or FOCUS of the turn and never at rest.
 *
 * A timestamp printed on every turn is a column of numbers nobody read, and it
 * is the first thing that makes a transcript look like a log file instead of a
 * conversation. The fact is kept because it is occasionally load-bearing; the
 * permanent column is not.
 */
export interface TurnCost {
  /** Wall clock, already formatted: `14:32`. */
  readonly at: string;
  /** Elapsed, already formatted: `18s`. */
  readonly elapsed: string;
}
