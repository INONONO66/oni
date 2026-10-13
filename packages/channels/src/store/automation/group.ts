import { Gateway } from "@openomni/protocol";
import { z } from "zod";
import { PendingGroup } from "../../automation/matcher.js";
import { IngressFacts } from "../../automation/facts.js";

/** The authenticated ingress evidence is retained, never reconstructed from an author label. */
export const StoredGroup = z.object({
  id: z.string(),
  target: z.string(),
  pending: PendingGroup,
  sender: Gateway.IngestSender.options[0],
  facts: IngressFacts,
});
export type StoredGroup = z.infer<typeof StoredGroup>;
