import { APICallError } from "ai";
import z from "zod";
import { APIError, AuthInvalidFileError, AuthResolutionError, InvalidProviderData, AgentFailure, LlmRunFailure, ModelCatalogError, ModelResolutionError, ProxyModelsError, TransportFailure, type LlmError } from "./errors";

export { APIError } from "./errors";
const ErrorFacts = z.object({
  aborted: z.boolean().optional().catch(undefined),
  contextOverflow: z.boolean().optional().catch(undefined),
});
type ErrorFacts = z.infer<typeof ErrorFacts>;
export function errorFacts<E>(error: E): ErrorFacts {
  return ErrorFacts.catch({}).parse(error);
}
export function declaredContextOverflow<E>(error: E): boolean | undefined {
  return error instanceof LlmRunFailure ? error.contextOverflow : undefined;
}
export type ApiFailure = APICallError;
/** Detection is SDK identity (`APICallError.isInstance`), never structural field copying. */
export function coerceApiError<E>(error: E): ApiFailure | undefined {
  if (APICallError.isInstance(error)) return error;
  return error instanceof APIError ? error.cause : undefined;
}

const KnownFailure = z.union([
  z.instanceof(APIError), z.instanceof(AuthInvalidFileError), z.instanceof(AuthResolutionError),
  z.instanceof(AgentFailure), z.instanceof(InvalidProviderData), z.instanceof(LlmRunFailure),
  z.instanceof(ModelCatalogError), z.instanceof(ModelResolutionError), z.instanceof(ProxyModelsError), z.instanceof(TransportFailure),
]);
export function decodeLlmFailure(operation: string) {
  return z.union([
    KnownFailure,
    z.custom<APICallError>((value) => APICallError.isInstance(value)).transform((cause) => new APIError({ cause })),
    z.instanceof(Error).transform((error) => new TransportFailure({ operation, message: error.message, providerErrorName: error.name, aborted: error.name === "AbortError", cause: error })),
    z.preprocess(String, z.string()).transform((cause) => new AgentFailure({ operation, cause })),
  ]).transform((failure): LlmError => failure).parse;
}

/** Observation text for a stream-boundary failure: a string cause verbatim, else the typed message. */
export function failureText(error: { readonly message: string; readonly cause?: string | Error }): string {
  return typeof error.cause === "string" ? error.cause : error.message;
}
