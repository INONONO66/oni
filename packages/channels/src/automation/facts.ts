import { Gateway, Ingress } from "@openomni/protocol";
import type { z } from "zod";

/** Driver facts also carry the unified webhook/github/schedule event vocabulary. */
export const IngressFacts = Gateway.IngressFacts.extend({
  event: Ingress.Input.shape.event.optional(),
});
export type IngressFacts = z.infer<typeof IngressFacts>;
