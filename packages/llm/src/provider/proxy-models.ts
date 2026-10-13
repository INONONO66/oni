import { createHash } from "node:crypto";
import { z } from "zod";
import { Effect } from "effect";
import { decodeLlmFailure } from "../error";
import { ProxyModelsError, type LlmError } from "../errors";
import type { Provider } from ".";

/**
 * A proxy that cannot list its models must fail loudly: swallowing the
 * failure into an empty list made proxy model resolution fall through to the
 * full models.dev catalog, presenting every model as "available on this proxy".
 */
type CacheEntry = {
  readonly expiresAt: number;
  readonly ids: string[];
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const modelCache = new Map<string, CacheEntry>();

function normalizeModelsURL(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/u, "");
  const root = trimmed.replace(/\/v1$/u, "");
  return `${root}/v1/models`;
}

function credentialFingerprint(apiKey: string | undefined): string {
  return createHash("sha256")
    .update(apiKey === undefined ? "no-api-key" : `api-key:${apiKey}`)
    .digest("hex");
}

const ModelEntry = z.object({ id: z.string().min(1) }).loose();
const ModelListing = z.object({ data: z.array(z.json()) });

export function fetchProxyModels(baseURL: string, now: () => number, apiKey?: string): Effect.Effect<string[], LlmError> {
  return Effect.gen(function* () {
  const url = normalizeModelsURL(baseURL);
  const cacheKey = `${url}:${credentialFingerprint(apiKey)}`;
  const cached = modelCache.get(cacheKey);
  if (cached && cached.expiresAt > now()) return cached.ids;

  const headers: Record<string, string> = {};
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = yield* Effect.tryPromise({
    try: (signal) => fetch(url, { headers, signal }),
    catch: decodeLlmFailure("proxy.models.fetch"),
  }).pipe(Effect.mapError((error) => new ProxyModelsError({
    message: `proxy model listing unreachable: ${error.message}`, url, cause: error,
  })));
  if (!response.ok) {
    return yield* new ProxyModelsError({
      message: `proxy model listing returned HTTP ${response.status}`,
      url,
      status: response.status,
    });
  }

  const body = yield* Effect.tryPromise({
    try: () => response.json().then(ModelListing.parse), catch: decodeLlmFailure("proxy.models.json"),
  }).pipe(Effect.mapError((error) => new ProxyModelsError({
    message: "proxy model listing returned invalid JSON", url, cause: error,
  })));

  const ids = body.data.flatMap((entry) => {
    const parsed = ModelEntry.safeParse(entry);
    return parsed.success ? [parsed.data.id] : [];
  });
  modelCache.set(cacheKey, { ids, expiresAt: now() + CACHE_TTL_MS });
  return ids;
  });
}

export function enrichWithCatalog(
  proxyModelIds: string[],
  catalogModels: Record<string, Provider.Model>,
  providerID: string,
): Provider.Model[] {
  return proxyModelIds.map((id) =>
    catalogModels[id]
      ? catalogModels[id]
      : {
          id,
          providerID,
          name: id,
        },
  );
}
