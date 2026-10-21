import { Actor, type Storage as ProtocolStorage } from "@oni/protocol";
import { requireSubAdapter, withStoreTimestamps } from "@oni/agent";

export type ChannelGrantStore = ReturnType<typeof createChannelGrantStore>;

/** Raw channel-grant fact storage over one catalog handle. Resolution and treatment belong to channels. */
export function createChannelGrantStore(source: {
  readonly channelGrant?: ProtocolStorage.ChannelGrantSubAdapter;
  /** Injected wall clock (#1245): the catalog handle carries it. */
  readonly now: () => number;
}) {
  function requireAdapter(): ProtocolStorage.ChannelGrantSubAdapter {
    return requireSubAdapter(
      source.channelGrant,
      "Storage adapter does not implement channel grants",
    );
  }

  return {
    put(input: Actor.ChannelGrant): Actor.ChannelGrant {
      const store = requireAdapter();
      const grant = Actor.ChannelGrant.parse(withStoreTimestamps(input, store.get(input.id), source.now()));
      store.set(grant);
      return grant;
    },

    get(id: string): Actor.ChannelGrant | undefined {
      return requireAdapter().get(id);
    },

    list(): Actor.ChannelGrant[] {
      return requireAdapter().list();
    },

    remove(id: string): boolean {
      return requireAdapter().remove(id);
    },
  };
}
