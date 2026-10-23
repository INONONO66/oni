import { z } from "zod";
import { EpochMs } from "../time.js";
import { PlainObjectSchema } from "../json.js";

export namespace DecisionFact {
  export const Record = z
    .object({
      key: z.string().min(1),
      type: z.string().min(1),
      data: PlainObjectSchema,
      timeCreated: EpochMs,
    })
    .strict();
  export type Record = z.infer<typeof Record>;

  export const Recorded = Record;
  export type Recorded = z.infer<typeof Recorded>;

  export const Outcome = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("recorded"), fact: Recorded }).strict(),
    z.object({ kind: z.literal("exists"), fact: Recorded }).strict(),
  ]);
  export type Outcome = z.infer<typeof Outcome>;
}
