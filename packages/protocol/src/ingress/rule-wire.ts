import { z } from "zod";
import { Events } from "../event/ingress.js";
import { EpochMs } from "../time.js";
import { Rule } from "./rule.js";

const Id = z.string().min(1);
const Correlation = z.object({ requestId: Id });

export const RefusalReason = z.enum([
  "not_found",
  "require_approval",
  "invalid_record",
  "store_unconfigured",
  "store_failed",
  "seed_protected",
  "invalid_position",
]);
export type RefusalReason = z.infer<typeof RefusalReason>;

export const LedgerFilter = z.object({
  surface: Id.optional(),
  decision: z.enum(["matched", "filtered", "refused", "deduped", "grouped", "superseded"]).optional(),
  recordId: Id.optional(),
  since: EpochMs.optional(),
  until: EpochMs.optional(),
  limit: z.number().int().positive().default(200),
}).strict();
export type LedgerFilter = z.infer<typeof LedgerFilter>;

export const Request = z.discriminatedUnion("type", [
  Correlation.extend({
    type: z.literal("rule_add"),
    // Seed rows are the composing app's alone: a client never mints one, so nothing undeletable comes in over the wire.
    record: Rule.omit({ seed: true }).extend({ id: Id.optional() }),
  }).strict(),
  Correlation.extend({ type: z.literal("rule_remove"), id: Id }).strict(),
  Correlation.extend({ type: z.literal("rule_enable"), id: Id }).strict(),
  Correlation.extend({ type: z.literal("rule_disable"), id: Id }).strict(),
  Correlation.extend({ type: z.literal("rule_list") }).strict(),
  Correlation.extend({ type: z.literal("rule_move"), id: Id, position: z.number().int().nonnegative() }).strict(),
  Correlation.extend({ type: z.literal("rule_ledger"), ...LedgerFilter.shape }).strict(),
]);
export type Request = z.infer<typeof Request>;

export const Refused = Correlation.extend({
  type: z.enum([
    "rule_add_refused",
    "rule_remove_refused",
    "rule_enable_refused",
    "rule_disable_refused",
    "rule_list_refused",
    "rule_move_refused",
    "rule_ledger_refused",
  ]),
  reason: RefusalReason,
  detail: z.string(),
  id: Id.optional(),
  issues: z.array(z.object({
    path: z.array(z.union([z.string(), z.number()])),
    message: z.string(),
    code: z.string(),
  }).strict()).optional(),
}).strict();
export type Refused = z.infer<typeof Refused>;

export const Response = z.discriminatedUnion("type", [
  Correlation.extend({ type: z.literal("rule_added"), record: Rule }).strict(),
  Correlation.extend({ type: z.literal("rule_removed"), id: Id }).strict(),
  Correlation.extend({ type: z.literal("rule_enabled"), record: Rule }).strict(),
  Correlation.extend({ type: z.literal("rule_disabled"), record: Rule }).strict(),
  Correlation.extend({ type: z.literal("rule_listed"), records: z.array(Rule) }).strict(),
  Correlation.extend({ type: z.literal("rule_moved"), record: Rule }).strict(),
  Correlation.extend({ type: z.literal("rule_ledger_read"), rows: z.array(Events.RoutingDecision.schema) }).strict(),
  Refused,
]);
export type Response = z.infer<typeof Response>;
