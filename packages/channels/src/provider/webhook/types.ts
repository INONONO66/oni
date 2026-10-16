import { z } from "zod";

/**
 * The shared secret is the declaration's own, sealed with it (`secret`), or
 * a separately sealed vault row's (`secretRef`); the inbound side verifies
 * with it and the outbound side signs with it. `url` is where a letter to
 * this target is POSTed (http or https); absent leaves the declaration
 * ingress-only.
 */
export const WebhookCredentials = z
  .object({
    id: z.string().min(1),
    secretRef: z.string().min(1).optional(),
    secret: z.string().min(1).optional(),
    url: z
      .string()
      .url()
      .refine((url) => /^https?:\/\//.test(url), "a webhook target url is http or https")
      .optional(),
  })
  .strict()
  .refine((credentials) => credentials.secret !== undefined || credentials.secretRef !== undefined, {
    message: "a webhook declares its shared secret, inline or by secretRef",
  });
export type WebhookCredentials = z.infer<typeof WebhookCredentials>;

export type SecretRefPort = (ref: string) => Promise<string | undefined>;
export type WebhookRefusal = {
  readonly refused: {
    readonly reason: "signature_mismatch" | "missing_signature" | "unknown_secret";
  };
};
