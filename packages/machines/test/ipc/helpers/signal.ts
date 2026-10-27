import { z } from "zod";

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

export function within<T>(promise: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // A deadline only fails the test; completion always comes from the subscribed signal.
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
    promise.finally(() => clearTimeout(timer)).then(resolve, reject);
  });
}

/** Subscribe before triggering failure; assertions run after the action, not inside Bun's matcher. */
export function captureError<T>(promise: Promise<T>): Promise<Error> {
  return promise.then(
    () => { throw new Error("expected promise to reject"); },
    z.instanceof(Error).parse,
  );
}
