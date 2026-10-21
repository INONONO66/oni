import { Actor, type Storage as ProtocolStorage } from "@oni/protocol";
import { requireSubAdapter, withStoreTimestamps } from "@oni/agent";

/** Raw blacklist fact storage over one catalog handle. Active-pattern matching belongs to channels. */
export function createBlacklistStore(source: {
  readonly blacklist?: ProtocolStorage.BlacklistSubAdapter;
  /** Injected wall clock (#1245): the catalog handle carries it. */
  readonly now: () => number;
}) {
  function requireAdapter(): ProtocolStorage.BlacklistSubAdapter {
    return requireSubAdapter(source.blacklist, "Storage adapter does not implement blacklist");
  }

  return {
    put(input: Actor.BlacklistEntry): Actor.BlacklistEntry {
      const store = requireAdapter();
      const entry = Actor.BlacklistEntry.parse(withStoreTimestamps(input, store.get(input.id), source.now()));
      store.set(entry);
      return entry;
    },

    get(id: string): Actor.BlacklistEntry | undefined {
      return requireAdapter().get(id);
    },

    list(): Actor.BlacklistEntry[] {
      return requireAdapter().list();
    },

    remove(id: string): boolean {
      return requireAdapter().remove(id);
    },
  };
}
