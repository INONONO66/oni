import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Effect, Semaphore } from "effect";
import { decodeLlmFailure } from "../error";
import { ModelCatalogError, type LlmError } from "../errors";
import { Catalog, RemoteCatalog } from "./schema";

const DEFAULT_CACHE_PATH = join(homedir(), ".openomni", "models.json");
const REMOTE_TIMEOUT_MS = 10_000;

/** The package's one environment owner: the credential file location is resolved here and injected into `auth/storage`. */
export function resolveAuthFilePath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const override = env.OPENOMNI_AUTH_FILE;
  return override ? resolve(override) : join(homedir(), ".openomni", "auth.json");
}
async function snapshot(): Promise<Catalog> {
  return Catalog.parse((await import("./models-snapshot.json")).default);
}
function catalogError(source: "cache" | "remote" | "cache_write", path: string) {
  return <E>(cause: E) => ModelCatalogError.fromThrown(source, path, cause);
}
/** A missing cache file is `undefined`; a present file that cannot be read or decoded is a typed `cache` refusal. */
function readCache(path: string): Effect.Effect<Catalog | undefined, LlmError> {
  return Effect.gen(function* () {
    const file = Bun.file(path);
    if (!(yield* Effect.promise(() => file.exists()))) return undefined;
    const raw = yield* Effect.tryPromise({ try: () => file.json(), catch: catalogError("cache", path) });
    return yield* Effect.try({ try: () => RemoteCatalog.parse(raw), catch: catalogError("cache", path) });
  });
}
/** Every remote failure — unreachable, timeout, non-OK status, bad body, bad decode — is a typed `remote` refusal. */
function fetchRemote(): Effect.Effect<Catalog, LlmError> {
  const url = `${process.env.OPENOMNI_MODELS_URL || "https://models.dev"}/api.json`;
  return Effect.tryPromise({
    try: (signal) => fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(REMOTE_TIMEOUT_MS)]) }),
    catch: catalogError("remote", url),
  }).pipe(
    Effect.flatMap((response) => response.ok
      ? Effect.tryPromise({ try: () => response.json(), catch: catalogError("remote", url) })
      : Effect.fail(catalogError("remote", url)(`catalog endpoint answered ${response.status}`))),
    Effect.flatMap((raw) => Effect.try({ try: () => RemoteCatalog.parse(raw), catch: catalogError("remote", url) })),
  );
}
/** A failed cache write is a typed `cache_write` refusal, never dropped. */
function writeCache(path: string, catalog: Catalog): Effect.Effect<void, LlmError> {
  return Effect.tryPromise({ try: () => mkdir(dirname(path), { recursive: true }), catch: catalogError("cache_write", path) }).pipe(
    Effect.andThen(Effect.tryPromise({ try: () => Bun.write(path, JSON.stringify(catalog)), catch: catalogError("cache_write", path) })),
    Effect.asVoid,
  );
}
function loadCatalog(loadSnapshot: () => Promise<Catalog>): Effect.Effect<Catalog, LlmError> {
  return Effect.gen(function* () {
    const path = process.env.OPENOMNI_MODELS_PATH ?? DEFAULT_CACHE_PATH;
    const cached = yield* readCache(path);
    if (cached !== undefined && Object.keys(cached).length > 0) return cached;
    if (!process.env.OPENOMNI_DISABLE_MODELS_FETCH) {
      // A typed `remote` refusal continues to the bundled snapshot; `cache` and
      // `cache_write` refusals propagate untouched.
      const remote = yield* fetchRemote().pipe(
        Effect.map((catalog): Catalog | undefined => catalog),
        Effect.catchIf(
          (error): error is ModelCatalogError =>
            error instanceof ModelCatalogError && error.source === "remote",
          () => Effect.succeed(undefined),
        ),
      );
      if (remote !== undefined) {
        yield* writeCache(path, remote);
        return remote;
      }
    }
    return yield* Effect.tryPromise({ try: loadSnapshot, catch: decodeLlmFailure("catalog.snapshot") });
  });
}
/** Each owner lazily loads one catalog, including concurrent requests. */
export function createCatalogLoader(loadSnapshot: () => Promise<Catalog> = snapshot): () => Effect.Effect<Catalog, LlmError> {
  let loaded: Catalog | undefined;
  const lock = Semaphore.makeUnsafe(1);
  return () => lock.withPermits(1)(Effect.suspend(() => loaded === undefined
    ? loadCatalog(loadSnapshot).pipe(Effect.tap((catalog) => Effect.sync(() => { loaded = catalog; })))
    : Effect.succeed(loaded)));
}
