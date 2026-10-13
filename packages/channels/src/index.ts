export { WebSocketHandler } from "./websocket.js";
export type { WsConnection } from "./websocket.js";
export { ChannelsFailure, decodeChannelFailure, SendAdmissionConflict } from "./errors.js";
export type { ChannelError } from "./errors.js";
export type { ChannelProvider, ProviderDeliveryRoute } from "./provider/contract.js";
export type { EffectRunner } from "./types.js";
export { ChannelProviders } from "./provider/registry.js";
export { createWebhookProvider } from "./provider/webhook/provider.js";
export { createGatewayRouter } from "./router/index.js";
export { resolveChannelGrant } from "./router/channel-grant.js";
export type { ChannelDeliveryRoute, GatewayRouter } from "./router/index.js";
export {
  createChannelStores,
  unconfiguredChannelStores,
  type ChannelStoreSource,
  type ChannelStores,
} from "./router/stores.js";
// #1246: the channel-facing ledger stores live here now; the app composes
// them through this barrel instead of the retired ledger package root.
export { createActorRegistry, type ActorRegistry } from "./store/actor/index.js";
export { createAutomationStore, AutomationEnableRefused } from "./store/automation/index.js";
export { createBlacklistStore } from "./store/blacklist/index.js";
export { createChannelGrantStore, type ChannelGrantStore } from "./store/channel-grant/index.js";
export { createReplyGrantStore } from "./store/reply-grant/index.js";
export { createEgressBudgetStore } from "./store/egress/index.js";
export {
  createChannelInstanceStore,
  createPersonStore,
  createSecretStore,
  Vault,
  type ChannelInstanceStore,
  type PersonStore,
  type SecretStore,
} from "./store/provisioning/index.js";
// #1317: the channels package owns the channel-facing SQLite adapters and
// their DDL; the app attaches this store to the catalog's database handle.
export { openChannelStore, type ChannelStore } from "./store/sqlite/index.js";
export { createSurfaceKeyStore } from "./store/surface-key/index.js";
export { StoredEndpoint, StoredIdentity } from "./store/sqlite/actor-schema.js";
