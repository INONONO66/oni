import { z } from "zod";
import { Deferred, Effect, Exit } from "effect";
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
const MAX_ENTRIES = 64;
const modelCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Deferred.Deferred<string[], LlmError>>();

function normalizeModelsURL(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/u, "");
  const root = trimmed.replace(/\/v1$/u, "");
  return `${root}/v1/models`;
}

const ModelEntry = z.object({ id: z.string().min(1) }).loose();
const ModelListing = z.object({ data: z.array(z.json()) });

/**
 * Cached lists are served until their TTL; a miss joins the one fetch already
 * in flight for that key, and the cache keeps only the `MAX_ENTRIES` most
 * recently used keys.
 */
export function fetchProxyModels(baseURL: string, now: () => number, apiKey?: string): Effect.Effect<string[], LlmError> {
  return Effect.suspend(() => {
    const url = normalizeModelsURL(baseURL);
    // The raw key is already resident in memory as the Authorization header, so keying by it adds no exposure.
    const cacheKey = JSON.stringify([url, apiKey ?? null]);
    const cached = modelCache.get(cacheKey);
    if (cached !== undefined) {
      modelCache.delete(cacheKey);
      if (cached.expiresAt > now()) {
        modelCache.set(cacheKey, cached);
        return Effect.succeed(cached.ids);
      }
    }
    const pending = inFlight.get(cacheKey);
    if (pending !== undefined) return Deferred.await(pending);
    const leader = Deferred.makeUnsafe<string[], LlmError>();
    inFlight.set(cacheKey, leader);
    return loadProxyModels(url, apiKey).pipe(Effect.onExit((exit) => Effect.suspend(() => {
      inFlight.delete(cacheKey);
      if (Exit.isSuccess(exit)) remember(cacheKey, { ids: exit.value, expiresAt: now() + CACHE_TTL_MS });
      return Deferred.done(leader, exit);
    })));
  });
}

function remember(cacheKey: string, entry: CacheEntry): void {
  modelCache.set(cacheKey, entry);
  // Each call adds at most one key, so evicting the least recently used one keeps the bound.
  const [oldest] = modelCache.keys();
  if (modelCache.size > MAX_ENTRIES && oldest !== undefined) modelCache.delete(oldest);
}

function loadProxyModels(url: string, apiKey: string | undefined): Effect.Effect<string[], LlmError> {
  return Effect.gen(function* () {
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

  return body.data.flatMap((entry) => {
    const parsed = ModelEntry.safeParse(entry);
    return parsed.success ? [parsed.data.id] : [];
  });
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
