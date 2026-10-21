import type { Database } from "bun:sqlite";
import type { Storage as ProtocolStorage } from "@oni/protocol";
import type { AutomationAdapter } from "../automation/index.js";
import { applyChannelStoreSchema } from "./schema.js";
import { createSqliteActorRegistryAdapter } from "./sqlite-actor-registry-adapter.js";
import { createSqliteAutomationAdapter } from "./sqlite-automation-adapter.js";
import { createSqliteBlacklistAdapter } from "./sqlite-blacklist-adapter.js";
import { createSqliteChannelGrantAdapter } from "./sqlite-channel-grant-adapter.js";
import { createSqliteEgressBudgetAdapter } from "./sqlite-egress-budget-adapter.js";
import { createSqliteProvisioningAdapter } from "./sqlite-provisioning-adapter.js";
import { createSqliteSurfaceKeyAdapter } from "./sqlite-surface-key-adapter.js";

export interface ChannelStore {
  readonly actorRegistry: ProtocolStorage.ActorRegistrySubAdapter;
  readonly automation: AutomationAdapter;
  readonly blacklist: ProtocolStorage.BlacklistSubAdapter;
  readonly channelGrant: ProtocolStorage.ChannelGrantSubAdapter;
  readonly egressBudget: ProtocolStorage.EgressBudgetSubAdapter;
  readonly surfaceKey: ProtocolStorage.SurfaceKeySubAdapter;
  readonly provisioning: ProtocolStorage.ProvisioningSubAdapter;
  readonly now: () => number;
  transaction<T>(operation: () => T): T;
}

export function openChannelStore(db: Database, now: () => number): ChannelStore {
  applyChannelStoreSchema(db);
  return {
    actorRegistry: createSqliteActorRegistryAdapter(db, now),
    automation: createSqliteAutomationAdapter(db, now),
    blacklist: createSqliteBlacklistAdapter(db, now),
    channelGrant: createSqliteChannelGrantAdapter(db, now),
    egressBudget: createSqliteEgressBudgetAdapter(db, now),
    surfaceKey: createSqliteSurfaceKeyAdapter(db, now),
    provisioning: createSqliteProvisioningAdapter(db, now),
    now,
    transaction: <T>(operation: () => T): T => db.transaction(operation).immediate(),
  };
}
