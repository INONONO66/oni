import { z } from "zod";
import { LedgerAction, LedgerSession, SessionGeneration } from "../ledger/l0.js";
import { toolOutputRefSchema } from "../tool/result.js";
import { Gateway } from "./schema.js";

const Id = z.string().min(1);
const Revision = z.number().int().nonnegative();

/** Plain data shared by the app-owned reader and its WebSocket consumers. */
export namespace SessionRead {
  export const Cursor = z.object({ revision: Revision, epoch: Revision }).strict();
  export type Cursor = z.infer<typeof Cursor>;

  export const Request = z.object({
    type: z.literal("session_read"),
    sessionId: Id,
    limit: z.number().int().positive().max(256),
    cursor: Cursor.optional(),
  }).strict();
  export type Request = z.infer<typeof Request>;

  export const Page = z.object({
    type: z.enum(["session_snapshot", "session_page"]),
    sessionId: Id,
    state: LedgerSession.State,
    phase: z.enum([
      "queued", "running", "waiting_approval", "waiting_input", "interrupted",
      "completed", "failed", "idle", "archived",
    ]),
    phaseSince: z.number().nonnegative(),
    epoch: Revision,
    afterRevision: Revision,
    headRevision: Revision,
    nextRevision: Revision.nullable(),
    actions: z.array(z.object({
      revision: Revision,
      actionId: Id,
      kind: LedgerAction.Kind,
      at: z.number().nonnegative(),
      /**
       * Fork boundary anchor (#1257): the action hash a `session_fork.at`
       * request may cite. Present only on boundary rows (turn terminals,
       * prompts, compactions); every other row is byte-identical to the
       * pre-#1257 frame.
       */
      forkAnchor: z.string().min(1).optional(),
      /**
       * Stored tool output reference (#1305): present only on rows whose
       * committed result was projected to a bounded preview; readers resolve
       * the full bytes through `Inspect.toolOutput`/`tool_output`.
       */
      outputRef: toolOutputRefSchema().optional(),
    }).strict()).max(256),
    usage: z.array(z.object({
      attemptId: Id,
      provenance: z.enum(["reported", "estimated", "unknown"]),
      inputTokens: z.number().nonnegative().nullable(),
      outputTokens: z.number().nonnegative().nullable(),
    }).strict()).max(256),
    toolWallMs: z.number().nonnegative(),
    /**
     * Fork ancestry projection (#1257): the parent edge, the genesis fork pin
     * and the history-only aside text. Inspect surface only — the reader
     * renders it; nothing here enters model context or compaction.
     */
    ancestry: z.object({
      parentId: Id.nullable(),
      forkedFrom: SessionGeneration.ForkAncestry.nullable(),
      aside: z.string().nullable(),
    }).strict().optional(),
    /**
     * Fork children projection (#1257): the inspect tree's direct children of
     * this session over catalog parent edges — each child id, its fork anchor
     * (absent for a commissioned, non-fork child) and its title where known
     * (the shipped catalog records none, so today's gateway omits it).
     * Present only when children exist, keeping every childless page
     * byte-identical to the pre-#1257 frame.
     */
    children: z.array(z.object({
      sessionId: Id,
      anchor: z.string().min(1).optional(),
      title: z.string().min(1).optional(),
    }).strict()).max(64).optional(),
  }).strict();
  export type Page = z.infer<typeof Page>;

  export const Gap = z.object({
    type: z.literal("session_gap"),
    sessionId: Id,
    epoch: Revision,
    headRevision: Revision,
    oldestRevision: Revision,
  }).strict();
  export const Response = z.union([Page, Gap]);
  export type Response = z.infer<typeof Response>;

  /** Frozen frame: an accepted receipt is exactly these two keys. */
  export const Receipt = z.object({
    type: z.literal("receipt"),
    status: z.literal("accepted"),
  }).strict();

  /**
   * Additive frame sent immediately after an accepted receipt on the same
   * socket. The admitted target is the durable identity, never a
   * renderer-created id.
   */
  export const Bound = z.object({
    type: z.literal("session_bound"),
    result: Gateway.IngestResult,
  }).strict();
  export type Bound = z.infer<typeof Bound>;
}

/**
 * Fork wire surface (#1257): fork a session at a verifiable boundary anchor
 * (`at` is the parent action hash of a turn terminal, prompt or compaction
 * row) into a new session with its own chain. The response is the pinned
 * ancestry or a typed refusal — never a silent success.
 */
export namespace SessionFork {
  export const Request = z.object({
    type: z.literal("session_fork"),
    sessionId: Id,
    /** The boundary anchor: a parent `actionHash`. */
    at: z.string().min(1),
    /** Caller-chosen child session id; the app mints one when absent. */
    childId: Id.optional(),
  }).strict();
  export type Request = z.infer<typeof Request>;

  export const Reason = z.enum([
    "parent_not_found", "parent_chain_broken", "schema_version",
    "anchor_not_found", "anchor_not_boundary", "byte_cap", "child_exists",
    "child_id_invalid", "output_missing", "storage",
  ]);
  export type Reason = z.infer<typeof Reason>;

  export const Forked = z.object({
    type: z.literal("session_forked"),
    sessionId: Id,
    parentId: Id,
    forkedFrom: SessionGeneration.ForkAncestry,
    head: z.string().min(1),
  }).strict();
  export type Forked = z.infer<typeof Forked>;

  export const Refused = z.object({
    type: z.literal("session_fork_refused"),
    sessionId: Id,
    reason: Reason,
    detail: z.string(),
  }).strict();
  export type Refused = z.infer<typeof Refused>;

  export const Response = z.union([Forked, Refused]);
  export type Response = z.infer<typeof Response>;
}
