/** Subscribe before triggering work; timeout is a failure bound, never synchronization. */
export function eventSignal<T>(name: string, timeoutMs = 5000) {
  const signal = Promise.withResolvers<T>();
  const timer = setTimeout(() => signal.reject(new Error(`${name} signal missing`)), timeoutMs);
  return {
    resolve: signal.resolve,
    reject: signal.reject,
    promise: signal.promise.finally(() => clearTimeout(timer)),
  };
}
