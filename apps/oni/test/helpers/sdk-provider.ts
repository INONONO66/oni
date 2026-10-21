import { APICallError } from "ai";
import { Effect } from "effect";
import { Auth } from "@oni/llm";
import type { FixtureLlm } from "./app-fixture";
import type { Model } from "@oni/protocol";
import { assistantMessage } from "./assistant-message";
import { providerFailure } from "./provider-failure";
import { fakeProviderModel } from "./resident-suite";

/** Real SDK error, with retry facts on the error rather than under data. */
export function providerError(fields: {
  readonly message: string;
  readonly isRetryable: boolean;
  readonly statusCode?: number;
  readonly responseBody?: string;
}): APICallError {
  return new APICallError({
    message: fields.message,
    url: "https://provider.test/v1/messages",
    requestBodyValues: {},
    isRetryable: fields.isRetryable,
    ...(fields.statusCode === undefined ? {} : { statusCode: fields.statusCode }),
    ...(fields.responseBody === undefined ? {} : { responseBody: fields.responseBody }),
  });
}

export const FIXTURE_AUTH_FILE = "/nonexistent/oni-test/auth.json";

export function transientProvider(
  resolved: Model.Ref[],
  auths?: Auth.Info[],
): Partial<FixtureLlm> {
  let calls = 0;
  return {
    resolveModel: (model) =>
      Effect.suspend(() => {
        // Record the model ref only: the resolve input also carries the injected clock (#1245).
        resolved.push({ provider: model.provider, id: model.id });
        return fakeProviderModel(model);
      }),
    run: (input, sink) =>
      Effect.gen(function* () {
        if (auths !== undefined)
          auths.push(yield* Auth.resolve(input.model.providerID, FIXTURE_AUTH_FILE, input.auth, input.authProvider));
        calls += 1;
        if (calls === 1) return { type: "error" as const, error: providerFailure("transient blip") };
        sink.onMessage(assistantMessage(input, { call: calls, text: "recovered" }));
        return { type: "stop" as const };
      }),
  };
}
