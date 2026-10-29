import { z } from "zod";

/** `epoch` is optional for discovery and required by window actions. */
export const WindowTarget = z
  .object({ pid: z.number().int().min(1), windowId: z.number().int().nonnegative(), epoch: z.number().int().nonnegative().optional() })
  .strict();
export type WindowTarget = z.infer<typeof WindowTarget>;
