import { z } from "zod";
import { PlainValueSchema } from "../json.js";
import { Model } from "../model/index.js";
import { Tool } from "../tool/index.js";
import { EpochMs } from "../time.js";

export namespace Actor {
  /**
   * #498 A2 — THE one actor-kind vocabulary. Every ActorContext, identity,
   * and verdict fact speaks these values; "unknown" is the honest member for
   * unresolved provenance (a missing dispatch actor context is a fact, not a
   * default). The retired Command.ActorKind values mapped onto this
   * vocabulary at the write side ("user"→"human", the retired subordinate role→"internal_worker");
   * the dormant command fact schemas were deleted with their runtime — no
   * reader ever shipped.
   */
  export const Kind = z.enum([
    "human",
    "ai_agent",
    "service",
    "resident",
    "internal_worker",
    "system",
    "unknown",
  ]);
  export type Kind = z.infer<typeof Kind>;

  /**
   * #P3 (conversation-and-message-io.md §3.1): how the contact entered the
   * registry. `provisional` rows are minted by the perimeter for unknown
   * senders on trusted channels — they carry NO grants, their inbound is
   * evidence_only, and only an Owner-approved promotion act registers them.
   * Absent reads as `registered` (every pre-P3 row was an explicit act).
   */
  export const Standing = z.enum(["registered", "provisional"]);
  export type Standing = z.infer<typeof Standing>;

  export const TrustTier = z.enum([
    "owner",
    "co_owner",
    "manager",
    "collaborator",
    "observer",
    "assigned_worker",
  ]);
  export type TrustTier = z.infer<typeof TrustTier>;

  const Metadata = z.record(z.string(), PlainValueSchema);

  // #498 A1 — `relationship` retired: zero value-branching readers ever
  // existed. Old persisted identity blobs still carry the key; this
  // non-strict schema strips it on read (migration 0018 drops the column).
  export const Identity = z.object({
    id: z.string().min(1),
    kind: Kind,
    trustTier: TrustTier,
    standing: Standing.optional(),
    displayName: z.string().min(1).optional(),
    metadata: Metadata.optional(),
    createdAt: EpochMs.optional(),
    updatedAt: EpochMs.optional(),
  });
  export type Identity = z.infer<typeof Identity>;

  export const Endpoint = z.object({
    id: z.string().min(1),
    actorId: z.string().min(1),
    channel: z.string().min(1),
    externalId: z.string().min(1),
    workspace: z.string().min(1).optional(),
    displayName: z.string().min(1).optional(),
    metadata: Metadata.optional(),
    verifiedAt: EpochMs.optional(),
    createdAt: EpochMs.optional(),
    updatedAt: EpochMs.optional(),
  });
  export type Endpoint = z.infer<typeof Endpoint>;

  export const ResolvedEndpoint = z.object({
    identity: Identity,
    endpoint: Endpoint,
  });
  export type ResolvedEndpoint = z.infer<typeof ResolvedEndpoint>;

  export const InboundTreatment = z.enum(["full_access", "evidence_only", "drop"]);
  export type InboundTreatment = z.infer<typeof InboundTreatment>;

  const budgetLimit = z
    .number()
    .int()
    .refine((n) => n === -1 || n > 0, {
      message: "must be a positive integer or -1 (unlimited)",
    });

  const budgetThreshold = z.number().gt(0).lt(1);

  const ProfileBudgetThresholdInput = z.object({
    warningThreshold: budgetThreshold.optional(),
    reassuranceThreshold: budgetThreshold.optional(),
  });

  const DEFAULT_REASSURANCE_THRESHOLD = 0.6;
  const DEFAULT_WARNING_THRESHOLD = 0.8;

  const ProfileBudget = z
    .object({
      maxTurns: budgetLimit.optional(),
      maxToolCalls: budgetLimit.optional(),
      maxWallTimeMs: z
        .number()
        .refine((n) => n === -1 || n > 0, {
          message: "must be a positive number or -1 (unlimited)",
        })
        .optional(),
      maxToolRuntimeMs: z
        .number()
        .refine((n) => n === -1 || n > 0, {
          message: "must be a positive number or -1 (unlimited)",
        })
        .optional(),
      warningThreshold: budgetThreshold.optional(),
      reassuranceThreshold: budgetThreshold.optional(),
    })
    .refine(
      (budget) =>
        (budget.reassuranceThreshold ?? DEFAULT_REASSURANCE_THRESHOLD) <
        (budget.warningThreshold ?? DEFAULT_WARNING_THRESHOLD),
      {
        path: ["reassuranceThreshold"],
        message: "must be less than warningThreshold",
      },
    );

  /**
   * #498 A3 — THE canonical actor profile, replacing the retired
   * `AgentProfile` namespace. Two halves of one actor:
   *
   *   - authority: the declared trust tier;
   *   - executable: what the actor runs with (prompt, tools, model, budget).
   *
   * `budget` speaks this vocabulary (`Actor.Profile.Budget`, the former
   * AgentBudget).
   */
  export const Profile = Object.assign(
    z.object({
      trustTier: TrustTier,
      systemPrompt: z.string().optional(),
      tools: z.array(Tool.Spec).optional(),
      model: Model.Ref.optional(),
      budget: ProfileBudget,
    }),
    {
      Budget: ProfileBudget,
      BudgetThresholdInput: ProfileBudgetThresholdInput,
      DEFAULT_REASSURANCE_THRESHOLD,
      DEFAULT_WARNING_THRESHOLD,
    },
  );
  // Uninstantiated namespace: type-side companions of the merged consts above.
  export namespace Profile {
    export type Budget = z.infer<typeof ProfileBudget>;
    export type BudgetThresholdInput = z.infer<typeof ProfileBudgetThresholdInput>;
  }
  export type Profile = z.infer<typeof Profile>;
}
