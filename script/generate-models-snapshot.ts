#!/usr/bin/env bun
// Fetch the models.dev catalog and retain only metadata consumed by the agent model plane.
import { RemoteModel } from "../packages/llm/src/model/schema.js";
import { PlainValueSchema, type PlainObject } from "../packages/protocol/src/json.js";
import { z } from "zod";

const BUNDLED_PROVIDERS = ["anthropic", "openai"] as const;
const SNAPSHOT_PATH = "packages/llm/src/model/models-snapshot.json";
const SourceModel = RemoteModel.and(z.object({
  release_date: z.string().optional(),
  status: z.string().optional(),
  provider: z.object({ npm: z.string() }).optional(),
}));
type SourceModel = z.infer<typeof SourceModel>;
const SourceProvider = z.object({
  id: z.string(),
  name: z.string(),
  env: z.array(z.string()),
  npm: z.string(),
  api: z.string().optional(),
  models: z.record(z.string(), SourceModel),
});
const SourceCatalog = z.record(z.string(), PlainValueSchema);

export async function main(): Promise<number> {
  const modelsUrl = process.env.MODELS_DEV_URL ?? "https://models.dev/api.json";
  const response = await fetch(modelsUrl, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    console.error(`[generate-models-snapshot] ${modelsUrl} → ${response.status}`);
    return 1;
  }

  const catalog = SourceCatalog.parse(await response.json());
  const subset: Record<string, PlainObject> = {};
  for (const providerID of BUNDLED_PROVIDERS) {
    const parsedProvider = SourceProvider.safeParse(catalog[providerID]);
    if (!parsedProvider.success) {
      console.error(
        `[generate-models-snapshot] provider missing or has no models in catalog: ${providerID}`,
      );
      return 1;
    }
    const provider = parsedProvider.data;
    const models: Record<string, PlainObject> = {};
    for (const [modelID, rawModel] of Object.entries(provider.models)) {
      models[modelID] = projectModel(rawModel);
    }
    subset[providerID] = {
      id: provider.id,
      name: provider.name,
      env: provider.env,
      npm: provider.npm,
      ...(provider.api === undefined ? {} : { api: provider.api }),
      models,
    };
  }

  await Bun.write(SNAPSHOT_PATH, `${JSON.stringify(subset, null, 2)}\n`);
  console.log(
    `[generate-models-snapshot] wrote ${SNAPSHOT_PATH} (${BUNDLED_PROVIDERS.length} providers)`,
  );
  return 0;
}

function projectModel(model: SourceModel): PlainObject {
  return {
    id: model.id,
    name: model.name,
    ...(model.family === undefined ? {} : { family: model.family }),
    ...(model.input === undefined ? {} : { input: model.input }),
    ...(model.release_date === undefined ? {} : { release_date: model.release_date }),
    ...(model.status === undefined ? {} : { status: model.status }),
    ...(model.limit?.context === undefined ? {} : { limit: { context: model.limit.context } }),
    ...(model.provider?.npm === undefined ? {} : { provider: { npm: model.provider.npm } }),
  };
}

if (import.meta.main) process.exitCode = await main();
