import { z } from "zod";

// A zod-only leaf: the ledger's delivery input imports it, and the gateway
// message contract already imports the ledger, so it cannot live there.
export const MediaPart = z
  .object({
    kind: z.enum(["image", "audio", "video", "file"]),
    ref: z.string().min(1),
    name: z.string().min(1).optional(),
    mime: z.string().min(1).optional(),
    bytes: z.number().int().nonnegative().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    voice: z.boolean().optional(),
  })
  .strict();
