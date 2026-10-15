/**
 * Every rendered piece of this surface has a stable, visible ADDRESS.
 *
 * Every exported component stamps `data-ui` on its root element, and the value
 * comes from HERE and from nowhere else, so a rename propagates in one edit and
 * a review can name an element (`ToolGroup.Summary`) instead of describing it.
 *
 * Dotted names are PARTS, not variants: `Turn.Prompt` is the prompt region
 * inside a `Turn`, whose own name is in the DOM above it.
 *
 * Ordered by where the eye lands: the frame, then the navigator's parts, then
 * the transcript top-down, then the input zone, then the primitives that appear
 * inside all of them.
 */
export const UI_NAMES = {
  /** A tonal surface — the window, a column, a recessed region. */
  Panel: "Panel",
  /** The window's top row: the controls zone, the one tab, the create control. */
  TabStrip: "TabStrip",
  /** The strip's left zone: window controls, sidebar toggle, history trio. */
  TabStripControls: "TabStrip.Controls",
  /** The one sidebar toggle, first in the strip's zone in every state. */
  SidebarToggle: "Sidebar.Toggle",
  /** The toggle's glyph; `data-opened` is the column's visibility (pinned or revealed). */
  SidebarToggleIcon: "Sidebar.Toggle.Icon",
  /** The history trio: clock, back, forward. Right-aligned to the sidebar's edge while open. */
  TabStripTrio: "TabStrip.Trio",
  TabStripList: "TabStrip.List",
  TabStripCreate: "TabStrip.Create",
  Tab: "Tab",
  TabIcon: "Tab.Icon",
  TabTitle: "Tab.Title",
  TabClose: "Tab.Close",
  ConsoleContent: "Console.Content",
  /** The window root: sidebar state and the runtime `--sidebar-width` live here. */
  Sidebar: "Sidebar",
  /** The in-flow spacer the fixed sidebar container sits over. */
  SidebarGap: "Sidebar.Gap",
  /** The fixed box that slides; pinned, revealed as an overlay, or hidden (`data-mode`). */
  SidebarContainer: "Sidebar.Container",
  /** The fading column inside the container; `inert` while hidden. */
  SidebarContent: "Sidebar.Content",
  /** The 8px hot zone on the window's left edge while the sidebar is collapsed. */
  SidebarEdge: "Sidebar.Edge",
  /** The 16px grab zone on the sidebar's right edge; pinned mode only. */
  SidebarResizeHandle: "Sidebar.ResizeHandle",
  /** The primary destinations: the column's first row, directly under the strip. */
  SidebarNav: "Sidebar.Nav",
  /** One destination in the nav. */
  NavItem: "NavItem",
  /** A section's title row, or its search field while searching. */
  SectionHeader: "SectionHeader",
  /** The section header's one control: search open, search closed. */
  SectionHeaderToggle: "SectionHeader.Toggle",
  /** The sidebar's bottom row, above a hairline. */
  SidebarFooter: "Sidebar.Footer",
  /** One line of the tree, at one of three depths. */
  TreeRow: "TreeRow",
  /** The clock: the last twenty places the main column has been. */
  HistoryMenu: "HistoryMenu",
  /** One place in the history: a title and how long ago. */
  HistoryMenuItem: "HistoryMenu.Item",

  /** The transcript column. */
  Timeline: "Timeline",
  /** One exchange: the Owner's message and everything that answered it. */
  Turn: "Turn",
  /** The Owner's own message — the right-aligned block. */
  TurnPrompt: "Turn.Prompt",
  /** One block of the agent's answer: a paragraph, a heading, a fence. */
  TurnResponse: "Turn.Response",
  /** The line that closes a response: wall time and elapsed. */
  TurnMeta: "Turn.Meta",
  /** A boundary in the ledger — a compaction, a resume. */
  EpochRule: "EpochRule",
  /** Rendered markdown: a paragraph of prose. */
  MarkdownBlock: "MarkdownBlock",
  /** A code block: one quiet tonal step, bounded by a hairline. */
  CodeFence: "CodeFence",
  /** One numbered line inside a fence, with its change marker. */
  CodeFenceGutter: "CodeFence.Gutter",
  /** A run of adjacent tool calls. */
  ToolGroup: "ToolGroup",
  /** The fold's summary line: `6 tools · 3 read · 2 edit`. */
  ToolGroupSummary: "ToolGroup.Summary",
  /** One tool call, one line: the verb, the thing, the cost. */
  ToolRow: "ToolRow",
  /** The status clause at the end of a tool row: the mark and the word. */
  ToolRowStatus: "ToolRow.Status",

  /** The input zone's field and its meta lines. */
  Composer: "Composer",
  /** The auto-growing textarea itself. */
  ComposerInput: "Composer.Input",
  /** The send affordance. */
  ComposerSend: "Composer.Send",
  /** What the send affordance becomes while a turn is being interrupted. */
  ComposerStop: "Composer.Stop",
  /** The line under the field: what is answering, what the turn has cost. */
  ComposerMeta: "Composer.Meta",
  /** The pending-decision tray, docked above the composer. */
  ApprovalTray: "ApprovalTray",
  /** The screen's one accent-filled control. */
  ApprovalTrayApprove: "ApprovalTray.Approve",
  /** The quiet half of the pair. */
  ApprovalTrayDeny: "ApprovalTray.Deny",

  /** A square control whose only child is a glyph. */
  IconButton: "IconButton",
  /** The system's one moving element: a live claim, drawn. */
  Spinner: "Spinner",
  /** A drawn 6px status mark in a fixed 2ch column. */
  StatusDot: "StatusDot",
  StatusGlyph: "StatusGlyph",
  /** The brand mark naming the surface a session arrived on. */
  OriginMark: "OriginMark",
  /** Match emphasis inside a label, as weight only. */
  Highlight: "Highlight",
  /** The named scroll owner. */
  ScrollArea: "ScrollArea",
  /** Text on the shared type scale, bound to a tone. */
  Text: "Text",
  /** Text in one of the transcript's three voices. */
  Voice: "Voice",
  /** One syntax-toned run inside a fence. */
  CodeToken: "CodeToken",
  /** The tail of streaming output. */
  Caret: "Caret",
} as const;
