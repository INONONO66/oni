import { createDecisionFactPort } from "@openomni/agent";
import { createSurfaceKeyStore } from "../store/surface-key/index.js";
import { createActorRegistry } from "../store/actor/index.js";
import { createAutomationStore, type AutomationAdapter } from "../store/automation/index.js";
import { createBlacklistStore } from "../store/blacklist/index.js";
import { createChannelGrantStore } from "../store/channel-grant/index.js";
import { createEgressBudgetStore } from "../store/egress/index.js";
import { createReplyGrantStore } from "../store/reply-grant/index.js";
import type { Storage as ProtocolStorage } from "@openomni/protocol";

export interface ChannelStoreSource {
  readonly actorRegistry?: ProtocolStorage.ActorRegistrySubAdapter;
  readonly automation?: AutomationAdapter;
  readonly blacklist?: ProtocolStorage.BlacklistSubAdapter;
  readonly channelGrant?: ProtocolStorage.ChannelGrantSubAdapter;
  readonly replyGrant?: ProtocolStorage.ReplyGrantSubAdapter;
  readonly egressBudget?: ProtocolStorage.EgressBudgetSubAdapter;
  readonly surfaceKey?: ProtocolStorage.SurfaceKeySubAdapter;
  readonly decisionFacts?: ProtocolStorage.DecisionFactSubAdapter;
  readonly now: () => number;
  transaction<T>(operation: () => T): T;
}

export function createChannelStores(source: ChannelStoreSource) {
  return {
    actors: createActorRegistry(source),
    automations: createAutomationStore(source),
    blacklist: createBlacklistStore(source),
    channelGrants: createChannelGrantStore(source),
    replyGrants: createReplyGrantStore(source),
    egressBudgets: createEgressBudgetStore(source),
    surfaceKeys: createSurfaceKeyStore(source),
    decisionFacts: createDecisionFactPort(source),
    transaction: <T>(operation: () => T): T => source.transaction(operation),
  };
}

export type ChannelStores = ReturnType<typeof createChannelStores>;

export function unconfiguredChannelStores(now: () => number): ChannelStores {
  return createChannelStores({ now, transaction: (operation) => operation() });
}
