import { createAnthropic, type AnthropicProvider } from "@ai-sdk/anthropic";
import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { secretFingerprint } from "../fingerprint";
import type { Auth } from "../auth/storage";
import { clientIdentity } from "./identity";
import { ModelResolutionError } from "../errors";
import type { Provider } from ".";

type SdkOptions = {
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  name?: string;
};
/** The package stays env-free: the host resolves these and hands them down like `Auth.Info`. */
export interface Transport {
  /** Proxy auth still outranks it: a credential minted for a proxy is never redirected. */
  readonly baseUrl?: string;
  /** An operator value wins over the client identity default. */
  readonly headers?: Record<string, string>;
}

type BundledProviderSDK = AnthropicProvider | OpenAIProvider;
type ProviderSDK = BundledProviderSDK;

// A Map keeps the lookup free of Object.prototype keys ("toString", ...)
// that an object literal would resolve and invoke as SDK factories.
const BUNDLED_PROVIDERS = new Map<string, (options: SdkOptions) => BundledProviderSDK>([
  ["@ai-sdk/anthropic", (options) => createAnthropic(options)],
  ["@ai-sdk/openai", (options) => createOpenAI(options)],
]);

/**
 * `LanguageModel` also admits a bare gateway id string nothing here returns; leaving it in the
 * signature only pushed casts onto callers.
 */
type ResolvedLanguageModel = Exclude<LanguageModel, string>;

const SDK_CACHE = new Map<string, ProviderSDK>();
const LANGUAGE_CACHE = new Map<string, ResolvedLanguageModel>();
const PROVIDER_SDK_CACHE_MAX_ENTRIES = 64;
const PROVIDER_LANGUAGE_CACHE_MAX_ENTRIES = 256;

function authFingerprint(auth: Auth.Info): string {
  return secretFingerprint(JSON.stringify(auth));
}

/** Two callers whose only difference is a tenant header must not share one SDK instance. */
function transportFingerprint(transport: Transport | undefined): string {
  if (transport === undefined) return "";
  const headers = transport.headers;
  const canonicalHeaders =
    headers === undefined
      ? ""
      : JSON.stringify(Object.entries(headers).sort(([a], [b]) => (a < b ? -1 : 1)));
  return `${transport.baseUrl ?? ""}|${secretFingerprint(canonicalHeaders)}`;
}

function sdkCacheKey(
  model: Provider.Model,
  auth: Auth.Info,
  transport: Transport | undefined,
): string {
  const row = transportFingerprint(model.api?.headers === undefined ? undefined : { headers: model.api.headers });
  return `${model.providerID}:${model.api?.npm ?? ""}:${model.api?.url ?? ""}:${model.api?.style ?? ""}:${row}:${authFingerprint(auth)}:${transportFingerprint(transport)}`;
}

function providerOptions(
  model: Provider.Model,
  auth: Auth.Info,
  transport: Transport | undefined,
): SdkOptions {
  const options: SdkOptions = {
    headers: {
      "user-agent": clientIdentity(),
      ...model.api?.headers,
      ...transport?.headers,
    },
  };
  if (model.api?.url) {
    options.baseURL = model.api.url;
    options.name = model.providerID;
  }
  if (transport?.baseUrl) {
    options.baseURL = transport.baseUrl;
    options.name = model.providerID;
  }
  if (auth.type === "api") options.apiKey = auth.key;
  if (auth.type === "proxy") {
    options.baseURL = auth.baseURL;
    options.apiKey = auth.apiKey ?? "proxy";
  }
  return options;
}

function createUnbundledSDK(model: Provider.Model, npm: string, options: SdkOptions): ProviderSDK {
  const baseURL = options.baseURL ?? model.api?.url;
  if (!baseURL)
    throw new ModelResolutionError({
      provider: model.providerID,
      model: model.id,
      reason: "provider_not_found",
      message: `No bundled provider for npm package: ${npm} and no API URL available`,
    });
  return createOpenAI({
    name: model.providerID,
    baseURL,
    apiKey: options.apiKey,
    headers: options.headers,
  });
}

export function getSDK(model: Provider.Model, auth: Auth.Info, transport?: Transport): ProviderSDK {
  const cacheKey = sdkCacheKey(model, auth, transport);
  const cached = getCached(SDK_CACHE, cacheKey);
  if (cached) return cached;
  const npm = model.api?.npm ?? "@ai-sdk/openai";
  const options = providerOptions(model, auth, transport);
  const factory = BUNDLED_PROVIDERS.get(npm);
  const sdk = factory ? factory(options) : createUnbundledSDK(model, npm, options);
  setCached(SDK_CACHE, cacheKey, sdk, PROVIDER_SDK_CACHE_MAX_ENTRIES);
  return sdk;
}

export function getLanguage(
  model: Provider.Model,
  auth: Auth.Info,
  transport?: Transport,
): ResolvedLanguageModel {
  const modelID = model.api?.id ?? model.id;
  const cacheKey = `${sdkCacheKey(model, auth, transport)}:${modelID}`;
  const cached = getCached(LANGUAGE_CACHE, cacheKey);
  if (cached) return cached;

  const languageModel = resolveLanguageModel(getSDK(model, auth, transport), model, modelID, auth);
  setCached(LANGUAGE_CACHE, cacheKey, languageModel, PROVIDER_LANGUAGE_CACHE_MAX_ENTRIES);
  return languageModel;
}

function getCached<T>(cache: Map<string, T>, key: string): T | undefined {
  const cached = cache.get(key);
  if (cached === undefined) return undefined;
  cache.delete(key);
  cache.set(key, cached);
  return cached;
}

function setCached<T>(cache: Map<string, T>, key: string, value: T, maxEntries: number): void {
  // Every caller first runs getCached, so only a miss reaches this writer:
  // the key cannot already exist here.
  cache.set(key, value);

  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) return;
    cache.delete(oldestKey);
  }
}

/** Proxy credentials speak Chat; the OpenAI SDK's undeclared surface is Responses. */
export function effectiveStyle(model: Provider.Model, auth: Auth.Info): "chat" | "responses" | undefined {
  if (model.api?.npm !== "@ai-sdk/openai") return undefined;
  return auth.type === "proxy" ? "chat" : model.api.style ?? "responses";
}

function resolveLanguageModel(
  sdk: ProviderSDK,
  model: Provider.Model,
  modelID: string,
  auth: Auth.Info,
): ResolvedLanguageModel {
  const style = effectiveStyle(model, auth);
  if (style === undefined && model.api?.style === undefined) return sdk.languageModel(modelID);
  if (!("responses" in sdk)) {
    throw new ModelResolutionError({
      provider: model.providerID,
      model: modelID,
      reason: "model_not_found",
      message: `The ${model.api?.style} API requires the @ai-sdk/openai package, not ${model.api?.npm}`,
    });
  }
  return style === "chat" ? sdk.chat(modelID) : sdk.responses(modelID);
}
