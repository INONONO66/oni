import { Gateway } from "@oni/protocol";
import { z } from "zod";
import { PendingGroup } from "../../automation/matcher.js";

/** The authenticated ingress evidence is retained, never reconstructed from an author label. */
export const StoredGroup = z.object({
  id: z.string(),
  target: z.string(),
  pending: PendingGroup,
  sender: Gateway.IngestSender.options[0],
  facts: Gateway.IngressFacts,
});
export type StoredGroup = z.infer<typeof StoredGroup>;
