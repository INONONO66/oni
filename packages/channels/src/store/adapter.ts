/**
 * Channels-owned sub-adapter helpers (#1847): a missing storage sub-adapter is
 * a broken wiring invariant on a synchronous store path, so it fails closed
 * with the store band's own error; timestamps come from the injected clock.
 */

import { ChannelStoreInvariant } from "./sqlite/errors.js";

export function requireSubAdapter<T>(adapter: T | null | undefined, message: string): T {
  if (!adapter) throw new ChannelStoreInvariant({ operation: "storage.subAdapter", message });
  return adapter;
}

export function withStoreTimestamps<
  T extends { readonly createdAt?: number; readonly updatedAt?: number },
>(record: T, existing: T | undefined, now: number): T {
  return {
    ...record,
    createdAt: record.createdAt ?? existing?.createdAt ?? now,
    updatedAt: existing === undefined ? (record.updatedAt ?? now) : now,
  };
}
