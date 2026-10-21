import { Clock, Data, Effect, Result } from "effect";
import { RateLimited } from "../errors";
import { Operational, parseJson } from "@oni/protocol";
import type { z } from "zod";
import { ThrownError } from "./thrown";
import type { EffectRunner, PublishPort } from "../types";

const MAX_API_RETRIES = 3;

/**
 * One failed step of the retry program. `limited` steps (429 with retries
 * left) are retried by `Effect.retry`; `terminal` steps carry the caller's
 * rejection — a network error or the typed exhaustion `RateLimited` — and
 * re-throw unchanged at the Promise boundary.
 */
class FetchStep extends Data.TaggedError("FetchStep")<{
  readonly kind: "limited" | "terminal";
  readonly error: Error;
}> {}

/**
 * Fetch with bounded 429 retries on the Effect clock: at most
 * `MAX_API_RETRIES` retries, each waiting the platform's retry-after hint
 * (default 5s) via `Effect.sleep` under `Effect.retry`. Non-429 responses
 * return as-is; non-429 rejections re-throw unchanged. The injected
 * `run` port executes the program on the app runtime — channel code never
 * owns an Effect runner.
 */
export function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: {
    /** The logical request's trace (D11): every retry of one request shares this ONE id — never re-minted per attempt. */
    traceId: string;
    /** Executes the retry program on the app runtime (TestClock in tests). */
    run: EffectRunner;
    /** retry-after seconds from 429 body; defaults to 5s */
    retryAfterSchema?: z.ZodType<number>;
    label?: string;
    /** band contract: telemetry goes through the injected observation port */
    publish?: PublishPort;
  },
): Promise<Response> {
  const label = options.label ?? url;
  let attempts = 0;

  const once = Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => fetch(url, init),
      catch: (cause) => new FetchStep({ kind: "terminal", error: ThrownError.parse(cause) }),
    });
    if (response.status !== 429) return response;
    attempts += 1;
    const body = yield* Effect.promise(() => response.text());
    if (attempts > MAX_API_RETRIES) {
      return yield* Effect.fail(
        new FetchStep({
          kind: "terminal",
          error: new RateLimited({
            message: `${label}: rate limited after ${MAX_API_RETRIES} retries`,
            status: response.status,
            attempts,
            responseHeaders: Object.fromEntries(response.headers),
            responseBody: body,
          }),
        }),
      );
    }
    const hinted = options.retryAfterSchema
      ? parseJson(options.retryAfterSchema, body)
      : undefined;
    const retryAfter = hinted ?? 5;
    const time = yield* Clock.currentTimeMillis;
    options.publish?.(Operational.Events.Warn, {
      traceId: options.traceId,
      time,
      component: "server",
      msg: "rate limited, retrying",
      context: { label, retryAfter, attempt: attempts, max: MAX_API_RETRIES },
    });
    yield* Effect.sleep(retryAfter * 1000);
    return yield* Effect.fail(new FetchStep({ kind: "limited", error: new Error(label) }));
  });

  const program = once.pipe(
    Effect.retry({ while: (step) => step.kind === "limited", times: MAX_API_RETRIES }),
  );

  return options.run(Effect.result(program)).then((outcome) => {
    if (Result.isFailure(outcome)) throw outcome.failure.error;
    return outcome.success;
  });
}
