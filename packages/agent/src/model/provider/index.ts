import { z } from "zod";
import { Effect } from "effect";
import { ModelResolutionError as ResolutionError, type LlmError } from "../errors";
import { ModelsDev } from "../model";
import { Auth } from "../auth/storage";
import { enrichWithCatalog, fetchProxyModels } from "./proxy-models";

export namespace Provider {
  /**
   * Only consumed catalog metadata lives here. `status` and `release_date`
   * were stored by the mapping below and read by nothing (#PR-2 slop pass) —
   * a field with no reader is a claim the code cannot keep, so it is gone
   * from the schema too: a re-add without a reader fails the mapping test.
   */
  export const Model = z.object({
    id: z.string(),
    providerID: z.string(),
    api: z
      .object({
        id: z.string().optional(),
        url: z.string().optional(),
        npm: z.string(),
      })
      .optional(),
    name: z.string(),
    family: z.string().optional(),
    limit: z
      .object({
        context: z.number(),
      })
      .optional(),
  });
  export type Model = z.infer<typeof Model>;

  export function fromModelsDevModel(provider: ModelsDev.Provider, model: ModelsDev.Model): Model {
    return {
      id: model.id,
      providerID: provider.id,
      name: model.name,
      family: model.family,
      api: {
        id: model.id,
        url: provider.api,
        npm: model.provider?.npm ?? provider.npm ?? "@ai-sdk/openai",
      },
      limit: {
        context: model.limit?.context ?? 0,
      },
    };
  }

  function catalogModels(provider: ModelsDev.Provider): Record<string, Model> {
    const models: Record<string, Model> = {};

    for (const [id, model] of Object.entries(provider.models)) {
      models[id] = fromModelsDevModel(provider, model);
    }

    return models;
  }

  /** Resolve only catalog-trusted or positively proxy-discovered models. */
  export function resolveModel(input: {
    readonly provider: string;
    readonly id: string;
    /** Wall-clock source for proxy-listing cache expiry (#1245). */
    readonly now: () => number;
    /** Credential file location, resolved once by the composition root (#1245). */
    readonly authFilePath: string;
  }): Effect.Effect<Model, LlmError> {
    return Effect.gen(function* () {
    const data = yield* ModelsDev.get();
    const provider = data[input.provider];
    if (provider === undefined) {
      return yield* new ResolutionError({
        message: `Unknown provider: ${input.provider}`,
        provider: input.provider,
        model: input.id,
        reason: "provider_not_found",
      });
    }
    const catalog = catalogModels(provider);
    const exact = catalog[input.id];
    if (exact !== undefined) return exact;
    const auth = yield* Auth.get(input.provider, input.authFilePath);
    if (auth?.type === "proxy") {
      const ids = yield* fetchProxyModels(auth.baseURL, input.now, auth.apiKey).pipe(Effect.mapError((error) =>
        new ResolutionError({
          message: `Proxy model listing failed for provider: ${input.provider}`,
          provider: input.provider, model: input.id, reason: "proxy_listing_failed", cause: error,
        }),
      ));
      const discovered = enrichWithCatalog(ids, catalog, input.provider).find(
        (model) => model.id === input.id,
      );
      if (discovered !== undefined) return discovered;
    }
    return yield* new ResolutionError({
      message: `Model not found: ${input.provider}/${input.id}`,
      provider: input.provider,
      model: input.id,
      reason: "model_not_found",
    });
    });
  }
}

export { ModelsDev } from "../model";
