import { APICallError } from "ai";
import z from "zod";
import { APIError, AuthInvalidFileError, AuthResolutionError, InvalidProviderData, LlmOperationFailure, LlmRunFailure, ModelCatalogError, ModelResolutionError, ProxyModelsError, TransportFailure, type LlmError } from "./errors";

export { APIError } from "./errors";
const ErrorFacts = z.object({
  aborted: z.boolean().optional().catch(undefined),
  contextOverflow: z.boolean().optional().catch(undefined),
  contentFiltered: z.boolean().optional().catch(undefined),
});
type ErrorFacts = z.infer<typeof ErrorFacts>;
export function errorFacts<E>(error: E): ErrorFacts {
  return ErrorFacts.catch({}).parse(error);
}
/** The typed failure's own verdict, read structurally: the core's identically-tagged failure declares it the same way (#1352). */
export function declaredContextOverflow<E>(error: E): boolean | undefined {
  return TaggedRunFailure.safeParse(error).success ? errorFacts(error).contextOverflow : undefined;
}
const TaggedRunFailure = z.object({ _tag: z.literal("LlmRunFailure") });
export type ApiFailure = APICallError;
/** Detection is SDK identity (`APICallError.isInstance`), never structural field copying. */
export function coerceApiError<E>(error: E): ApiFailure | undefined {
  if (APICallError.isInstance(error)) return error;
  return error instanceof APIError ? error.cause : undefined;
}

const KnownFailure = z.union([
  z.instanceof(APIError), z.instanceof(AuthInvalidFileError), z.instanceof(AuthResolutionError),
  z.instanceof(LlmOperationFailure), z.instanceof(InvalidProviderData), z.instanceof(LlmRunFailure),
  z.instanceof(ModelCatalogError), z.instanceof(ModelResolutionError), z.instanceof(ProxyModelsError), z.instanceof(TransportFailure),
]);
export function decodeLlmFailure(operation: string) {
  return z.union([
    KnownFailure,
    z.custom<APICallError>((value) => APICallError.isInstance(value)).transform((cause) => new APIError({ cause })),
    z.instanceof(Error).transform((error) => new TransportFailure({ operation, message: error.message, providerErrorName: error.name, aborted: error.name === "AbortError", cause: error })),
    z.preprocess(String, z.string()).transform((cause) => new LlmOperationFailure({ operation, cause })),
  ]).transform((failure): LlmError => failure).parse;
}

/** Observation text for a stream-boundary failure: a string cause verbatim, else the message. */
export function failureText(error: { readonly message: string; readonly cause?: string | Error }): string {
  return typeof error.cause === "string" ? error.cause : error.message;
}
