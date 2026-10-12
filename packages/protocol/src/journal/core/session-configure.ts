/**
 * `session.configure` — generation change: manifest hash, role, parent,
 * bundles and `settings{steering, followUp, forkCopyByteCap, checkpoint}` holding the
 * `all|one` consumption widths, the fork copy cap and the checkpoint policy. Single writer: the entity configure constructor
 * (`packages/agent/src/core/store/fence.ts`), also used at genesis by the app
 * cluster runtime and by `Session.fork` (#1257), whose child genesis pins the
 * fork boundary in `forkedFrom`.
 */
import { z } from "zod";
import { RowBody, declare, refineField } from "../declaration.js";

/** How many queued inputs one boundary consumes for each delivery mode. */
export const ConsumptionWidth = z.enum(["all", "one"]);
export type ConsumptionWidth = z.infer<typeof ConsumptionWidth>;

/**
 * Durable checkpoint policy (#1347): how many non-checkpoint actions one
 * `fold.checkpoint` row covers and the largest serialized suffix (bytes, no
 * row bound) a restore may fold after the latest checkpoint before it refuses.
 */
export const CheckpointPolicy = z
  .object({
    everyActions: z.number().int().positive(),
    maxTailBytes: z.number().int().positive(),
  })
  .strict();
export type CheckpointPolicy = z.infer<typeof CheckpointPolicy>;

export const Settings = z
  .object({
    steering: ConsumptionWidth,
    followUp: ConsumptionWidth,
    /**
     * Copied-bytes cap for forking THIS session (#1257): generation
     * configuration folded like the widths; absent falls back to the core
     * default. The composition root writes its resolved startup value here.
     */
    forkCopyByteCap: z.number().int().positive().optional(),
    /**
     * Byte budget for one tool result's model-facing projection (#1305):
     * generation configuration folded like the widths; absent falls back to
     * the core default. The composition root writes its resolved startup
     * value here.
     */
    toolOutputBudgetBytes: z.number().int().positive().optional(),
    /**
     * Checkpoint cadence and restore tail budget (#1347): generation
     * configuration folded like the widths; absent falls back to the core
     * default `{ everyActions: 256, maxTailBytes: 4 MiB }`.
     */
    checkpoint: CheckpointPolicy.optional(),
  })
  .strict();
export type Settings = z.infer<typeof Settings>;

/**
 * Fork ancestry pinned at child genesis (#1257): the parent session, the
 * boundary anchor (the parent action hash forked at), the anchor's parent
 * ordinal, the parent chain head at fork time (so later parent appends cannot
 * alter verification) and how many parent rows were copied onto the child
 * chain after genesis.
 */
export const ForkedFrom = z
  .object({
    session: z.string().min(1),
    anchor: z.string().min(1),
    parentSeq: z.number().int().positive(),
    parentHead: z.string().min(1),
    copied: z.number().int().nonnegative(),
  })
  .strict();
export type ForkedFrom = z.infer<typeof ForkedFrom>;

/** One intended deactivation of the off cascade (#1255): `because` is the root `off` name. */
export const DisabledEntry = z.object({ name: z.string().min(1), because: z.string().min(1) }).strict();
export type DisabledEntry = z.infer<typeof DisabledEntry>;

/** The composed generation's full off cascade, journaled with the configure. */
export const Disabled = z.array(DisabledEntry).readonly();
export type Disabled = z.infer<typeof Disabled>;

export const sessionConfigure = declare(
  "session.configure",
  RowBody.superRefine(refineField("intent", "settings", Settings))
    .superRefine(refineField("intent", "disabled", Disabled))
    .superRefine(refineField("intent", "forkedFrom", ForkedFrom)),
);
