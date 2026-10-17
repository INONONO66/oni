import z from "zod";
import { dirname } from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, rmSync, statSync } from "node:fs";
import { Effect, Schedule } from "effect";
import { secretFingerprint } from "../fingerprint";
import { parseJson } from "@openomni/protocol";
import { AuthInvalidFileError, AuthResolutionError, type LlmError } from "../errors";
import { decodeLlmFailure } from "../error";

const Info = z.discriminatedUnion("type", [
  z.object({ type: z.literal("api"), key: z.string() }),
  z.object({ type: z.literal("proxy"), baseURL: z.string(), apiKey: z.string().optional() }),
]);
const AuthFile = z.record(z.string(), z.json());
// Storage reads no environment and resolves no paths; the location is injected.

function readAuthFile(filepath: string): Record<string, Auth.Info> {
  if (!existsSync(filepath)) return {};
  const text = readFileSync(filepath, "utf8");
  const json = z.string().transform((input, ctx) => {
    const decoded = parseJson(z.json(), input);
    if (decoded === undefined) { ctx.addIssue({ code: "custom", message: "invalid auth JSON" }); return z.NEVER; }
    return decoded;
  }).safeParse(text);
  if (!json.success) throw new AuthInvalidFileError({
    message: `auth file is not valid JSON: ${filepath}`, path: filepath, cause: json.error.message,
  });
  const document = AuthFile.safeParse(json.data);
  if (!document.success) throw new AuthInvalidFileError({ message: `auth file is not a JSON object: ${filepath}`, path: filepath, cause: document.error.message });
  return Object.fromEntries(Object.entries(document.data).flatMap(([key, value]) => {
    const parsed = Info.safeParse(value);
    return parsed.success ? [[key, parsed.data] as const] : [];
  }));
}

export namespace Auth {
  export type Info = z.infer<typeof Info>;
  export const InvalidFileError = AuthInvalidFileError;
  export const ResolutionError = AuthResolutionError;

  export function resolve(provider: string, authFilePath: string, explicit?: Info, boundProvider = provider, allowFallback = true): Effect.Effect<Info, LlmError> {
    return Effect.gen(function* () {
      const auth = boundProvider === provider && explicit !== undefined
        ? explicit : allowFallback ? yield* Auth.get(provider, authFilePath) : undefined;
      if (auth === undefined) return yield* new AuthResolutionError({
        message: `No authentication found for provider: ${provider}`, provider, reason: "missing_auth",
      });
      const parsed = Info.safeParse(auth);
      if (parsed.success && (parsed.data.type === "api" ? parsed.data.key.length > 0 : URL.canParse(parsed.data.baseURL))) return parsed.data;
      return yield* new AuthResolutionError({ message: `Invalid authentication for provider: ${provider}`, provider, reason: "invalid_auth" });
    });
  }

  export function reference(info: Info): { readonly type: Info["type"]; readonly fingerprint: string } {
    const digest = secretFingerprint(JSON.stringify(info));
    return { type: info.type, fingerprint: digest.slice(0, 16) };
  }

  export function get(providerID: string, authFilePath: string): Effect.Effect<Info | undefined, LlmError> {
    return Effect.map(all(authFilePath), (auth) => auth[providerID]);
  }
  export function all(authFilePath: string): Effect.Effect<Record<string, Info>, LlmError> {
    return Effect.try({ try: () => readAuthFile(authFilePath), catch: decodeLlmFailure("auth.read") });
  }
  /**
   * The read and the atomic rename run while this process owns `<file>.lock`
   * (an exclusive `mkdir`), so concurrent writers in other processes merge
   * instead of overwriting each other; the temp suffix comes from the injected
   * `id`, never ambient entropy.
   */
  export function set(
    key: string,
    info: Info,
    options: { readonly id: () => string; readonly authFilePath: string },
  ): Effect.Effect<void, LlmError> {
    const filepath = options.authFilePath;
    const lockPath = `${filepath}.lock`;
    const write = Effect.try({
      try: () => {
        const data = readAuthFile(filepath);
        const tmpPath = `${filepath}.${options.id()}.tmp`;
        writeFileSync(tmpPath, JSON.stringify({ ...data, [key]: info }, null, 2), { mode: 0o600 });
        let swapped = false;
        try { renameSync(tmpPath, filepath); swapped = true; }
        finally { if (!swapped) rmSync(tmpPath, { force: true }); }
      },
      catch: decodeLlmFailure("auth.write"),
    });
    return Effect.acquireUseRelease(
      Effect.try({ try: () => acquireLock(filepath, lockPath), catch: (error) => error }).pipe(
        Effect.retry({ while: (error) => error === LOCK_BUSY, times: LOCK_ATTEMPTS, schedule: Schedule.spaced("5 millis") }),
        Effect.mapError(decodeLlmFailure("auth.write")),
      ),
      () => write,
      () => Effect.sync(() => rmSync(lockPath, { recursive: true, force: true })),
    );
  }
}

/** About ten seconds of 5 ms polls; a writer holds the lock for one read and one rename. */
const LOCK_ATTEMPTS = 2000;
/** A lock this old belongs to a writer that died between mkdir and release. */
const LOCK_STALE_MS = 30_000;
const LOCK_BUSY = new Error("auth file lock is held by another writer");

function acquireLock(filepath: string, lockPath: string): void {
  mkdirSync(dirname(filepath), { recursive: true });
  try {
    mkdirSync(lockPath, { mode: 0o700 });
    return;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const lock = statSync(lockPath, { throwIfNoEntry: false });
  if (lock !== undefined && Date.now() - lock.mtimeMs > LOCK_STALE_MS) rmSync(lockPath, { recursive: true, force: true });
  throw LOCK_BUSY;
}
