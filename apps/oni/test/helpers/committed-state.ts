import { L0Observation } from "@oni/protocol";
import { Bus } from "./bus";

/** Subscribe before checking the current committed state so either ordering settles. */
export async function untilCommitted(check: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  if (check()) return;
  const settled = Promise.withResolvers<void>();
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, () => {
    if (check()) settled.resolve();
  });
  const timer = setTimeout(() => settled.reject(new Error(label)), timeoutMs);
  try {
    if (check()) return;
    await settled.promise;
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}
