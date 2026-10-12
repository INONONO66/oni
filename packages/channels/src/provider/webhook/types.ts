import { z } from "zod";

export const WebhookCredentials = z
  .object({
    id: z.string().min(1),
    secretRef: z.string().min(1),
  })
  .strict();
export type WebhookCredentials = z.infer<typeof WebhookCredentials>;

export type SecretRefPort = (ref: string) => Promise<string | undefined>;
export type WebhookRefusal = {
  readonly refused: {
    readonly reason: "signature_mismatch" | "missing_signature" | "unknown_secret";
  };
};
