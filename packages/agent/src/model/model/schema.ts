import { z } from "zod";

export const CatalogModel = z.object({
  id: z.string(),
  name: z.string(),
  family: z.string().optional(),
  limit: z.object({ context: z.number() }).optional(),
  provider: z.object({ npm: z.string() }).optional(),
});

const PrototypeKey = new Set(["__proto__", "constructor", "prototype"]);
const RemoteModel = CatalogModel.omit({ provider: true });
const SupportedSdk = new Set<string>(["@ai-sdk/anthropic", "@ai-sdk/openai"]);
const RemoteProvider = z.object({
  id: z.string().optional(),
  name: z.string(),
  env: z.array(z.string()),
  npm: z.enum(["@ai-sdk/anthropic", "@ai-sdk/openai"]),
  models: z.record(z.string(), RemoteModel),
});
/** The SDK gate: an entry without a bundled SDK is an explicit policy skip, never a parse failure. */
const SdkCandidate = z.looseObject({ npm: z.string().optional() });

export const CatalogProvider = z.object({
  api: z.string().optional(),
  name: z.string(),
  env: z.array(z.string()),
  id: z.string(),
  npm: z.string().optional(),
  models: z.record(z.string(), CatalogModel),
});
export const Catalog = z.record(z.string(), CatalogProvider);
export type Catalog = z.infer<typeof Catalog>;

/** A malformed entry under a supported SDK is a parse failure the caller sees, never a silently dropped record. */
export const RemoteCatalog = z
  .record(z.string(), SdkCandidate)
  .transform((providers, ctx): Catalog => {
    const result: Catalog = {};
    for (const [id, candidate] of Object.entries(providers)) {
      if (PrototypeKey.has(id)) continue;
      if (candidate.npm === undefined || !SupportedSdk.has(candidate.npm)) continue;
      const provider = RemoteProvider.safeParse(candidate);
      if (!provider.success) {
        ctx.addIssue({ code: "custom", message: `provider ${id}: ${z.prettifyError(provider.error)}`, path: [id] });
        return z.NEVER;
      }
      const models = Object.fromEntries(
        Object.entries(provider.data.models).filter(([key]) => !PrototypeKey.has(key)),
      );
      result[id] = CatalogProvider.parse({ ...provider.data, models, id: provider.data.id ?? id });
    }
    return result;
  });
