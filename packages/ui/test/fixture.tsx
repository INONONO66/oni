import type { ConsoleShell, ConsoleStrip } from "../src/console";
import type { PendingApproval, TranscriptNode, TurnCost } from "../src/timeline/model";

/**
 * The test transcript, as data.
 *
 * It is a FIXTURE and not a second mock: it supplies input to `Console` and
 * `Timeline`, and nothing here decides how anything looks. The shape is chosen
 * to exercise every hard case the transcript has:
 *
 *   - TWO turns, so the 28px turn boundary is visible against the gaps inside
 *     a turn;
 *   - a tool → text → tool INTERLEAVE, so the prose split is visible and the
 *     column can be checked for true chronology rather than a gathered
 *     appendix;
 *   - a SIX-call group with one call still running, so the fold's summary line
 *     and its never-hide rule are on screen at once;
 *   - one PENDING approval, whose transcript row prints only the word while the
 *     tray above the composer carries the decision;
 *   - a COMPACTION rule, so the reader is told the ledger is not from zero;
 *   - a multi-paragraph answer, so the paragraph step inside one turn is
 *     visible against the block gap around it.
 */

export const transcript: readonly TranscriptNode[] = [
  // Everything above this was folded into a summary, so the transcript below is
  // not the whole session.
  { kind: "epoch", id: "e0", label: "compacted", at: "11:31" },
  {
    kind: "prompt",
    id: "p1",
    text: "The ledger append path takes the lease twice on the retry branch. Refactor it so the lease is acquired once per generation, then show me the fenced-write guard.",
  },
  // The interleave: three calls, a sentence, then more work. The sentence
  // splits the run into two groups, which is what makes the column chronology
  // rather than an appendix.
  {
    kind: "tool",
    id: "t1",
    tool: "read",
    target: "packages/kernel/src/ledger/append.rs",
    duration: "71ms",
    payload: [
      "138  async fn append(&self, e: Entry) -> Result<Lsn> {",
      "139    let lease = self.lease.acquire().await?;",
      "140    // one writer per generation",
    ],
  },
  {
    kind: "tool",
    id: "t2",
    tool: "read",
    target: "packages/kernel/src/ledger/lease.rs",
    duration: "52ms",
  },
  { kind: "tool", id: "t3", tool: "grep", target: "acquire\\(", duration: "18ms" },
  {
    kind: "assistant",
    id: "a0",
    streaming: false,
    blocks: [
      {
        kind: "p",
        text: "The retry branch re-enters acquire() while still holding the guard, so a fenced generation can commit twice. Checking what the suite already covers before I touch it.",
      },
    ],
  },
  // Six calls, one of them running: the fold's summary and its never-hide rule
  // on screen at the same time.
  {
    kind: "tool",
    id: "t4",
    tool: "read",
    target: "packages/kernel/tests/ledger.rs",
    duration: "44ms",
  },
  { kind: "tool", id: "t5", tool: "read", target: "docs/kernel-contract.md", duration: "31ms" },
  {
    kind: "tool",
    id: "t6",
    tool: "read",
    target: "packages/kernel/src/ledger/mod.rs",
    duration: "28ms",
  },
  {
    kind: "tool",
    id: "t7",
    tool: "edit",
    target: "packages/kernel/src/ledger/append.rs",
    duration: "12ms",
    payload: ["+  let lease = self.lease.acquire().await?;", "-  if lease.generation != self.g {"],
  },
  {
    kind: "tool",
    id: "t8",
    tool: "edit",
    target: "packages/kernel/src/ledger/lease.rs",
    duration: "9ms",
  },
  {
    kind: "tool",
    id: "t9",
    tool: "shell",
    target: "cargo test -p kernel ledger::",
    status: "running",
  },
  {
    kind: "assistant",
    id: "a1",
    streaming: false,
    blocks: [
      {
        kind: "p",
        text: "The retry branch re-entered `acquire` after the fence check, so a losing writer took the lease a second time before observing that its generation was stale.",
      },
      {
        kind: "p",
        text: "The lease is now acquired once, above the retry, and held across it.",
      },
      {
        kind: "p",
        text: "A stale generation returns `Fenced` instead of retrying.",
      },
    ],
  },
  // The second turn, so the turn boundary is visible against the gaps within.
  { kind: "prompt", id: "p2", text: "Run the suite and confirm the fence holds." },
  // The blocked row. It prints the WORD and nothing else — the decision is in
  // the tray, where it cannot scroll away.
  { kind: "tool", id: "t10", tool: "shell", target: "npm test", status: "waiting" },
];

/** Shown on hover or keyboard focus of a turn, never at rest. */
export const costs: Readonly<Record<number, TurnCost>> = {
  2: { at: "14:32", elapsed: "18s" },
  3: { at: "14:33", elapsed: "4s" },
};

/**
 * The outstanding decision. `toolId` joins it back to the transcript row, so
 * the row printing `waiting for approval` and the tray offering the buttons are
 * provably the same call.
 */
export const pending: readonly PendingApproval[] = [
  { toolId: "t10", summary: "shell wants to run npm test", reason: "outside declared scope" },
];

/** The frame at rest: sidebar open at its default width, an empty history. */
export const SHELL: ConsoleShell = {
  sidebarOpen: true,
  sidebarFloating: false,
  sidebarWidth: 240,
  onToggleSidebar: () => undefined,
  onSidebarFloatingChange: () => undefined,
  onSidebarWidthCommit: () => undefined,
};

export const STRIP: ConsoleStrip = {
  tabs: [],
  onActivate: () => undefined,
  onClose: () => undefined,
  createLabel: "New",
  onCreate: () => undefined,
  platform: "darwin",
  history: {
    entries: [],
    currentId: null,
    now: 0,
    canBack: false,
    canForward: false,
    onBack: () => undefined,
    onForward: () => undefined,
    onJump: () => undefined,
  },
};

export function stripWithActions(
  tabs: ConsoleStrip["tabs"],
  onActivate: ConsoleStrip["onActivate"],
  onClose: ConsoleStrip["onClose"],
  onCreate: ConsoleStrip["onCreate"] = STRIP.onCreate,
): ConsoleStrip {
  return { ...STRIP, tabs, onActivate, onClose, onCreate };
}
