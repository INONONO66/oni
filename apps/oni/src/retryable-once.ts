/**
 * One shared in-flight run (#1256 r2 C-1): concurrent callers join the same
 * promise, a rejection clears the memo so the NEXT call retries, and a
 * success is permanent — a stopped app never stops twice. Internal module,
 * NOT part of the app barrel (#1256 r4 L-1): index.ts and its test are the
 * only consumers.
 */
export function retryableOnce(run: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | undefined;
  return () => {
    inFlight ??= run().catch((error: Error) => {
      inFlight = undefined;
      throw error;
    });
    return inFlight;
  };
}
