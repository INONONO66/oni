export { WebSocketHandler } from "./websocket.js";
export type { WsConnection } from "./websocket.js";
export { AttachmentRefused, RuleConfigurationError, ChannelsFailure, decodeChannelFailure, MediaTooLarge, SendAdmissionConflict, VoiceJoinRefused } from "./errors.js";
export type { ChannelError } from "./errors.js";
export type { AccountIdentity, ChannelProvider, AccountArm, AccountWithdrawal, ProviderDeliveryRoute, ProviderTypingRoute } from "./provider/contract.js";

export type { PcmVoiceHandle, ProviderVoiceRoute, VoiceEvent } from "./provider/voice.js";
export { AccountLogins, type AccountLogin } from "./provider/account-login.js";
export type { AccountLoginWithTelegram } from "./provider/account-login.js";
export type { ProviderHistoryResult, ProviderHistoryRoute } from "./provider/history.js";
export { TelegramAccountCredentials } from "./provider/telegram/account-contract.js";
export type { TelegramAccountProviderFactory, TelegramAccountSurface } from "./provider/telegram/account-contract.js";
export type { TelegramAccountLogin, TelegramAccountLoginInput, TelegramAccountSdk } from "./provider/telegram/account-sdk.js";
export { inboundOnce } from "./support/inbound-once.js";

export { typingPulse } from "./support/typing-pulse.js";
export type { AttachmentBounds, AttachmentFetch, EffectRunner, MediaBytes, MediaResolver } from "./types.js";
export type { AttachmentFetchResult, AttachmentFetchWithStream, MediaStream } from "./types.js";
export { ChannelProviders } from "./provider/registry.js";
export { createWebhookProvider } from "./provider/webhook/provider.js";
export { createWebhookSender, signWebhookBody, type WebhookFetch, type WebhookSender } from "./provider/webhook/outbound.js";
export { WebhookCredentials } from "./provider/webhook/types.js";
export { A2AClient, type A2AAnswer, type A2ACardRead, type A2AFetch } from "./provider/a2a/client.js";
export { A2ACredentials, textOf as textOfA2A } from "./provider/a2a/types.js";
export { createA2AProvider, type A2ACardFacts, type PeerResolver } from "./provider/a2a/provider.js";


// #1569: the reply door's binding is folded by the composing app from the
// prompt's recorded origin and verified here; the shape is the contract.

export {
  createChannelStores,
  type ChannelStoreSource,
  type ChannelStores,
} from "./router/stores.js";
// #1246: the channel-facing ledger stores live here now; the app composes
// them through this barrel instead of the retired ledger package root.
export { createActorRegistry, type ActorRegistry } from "./store/actor/index.js";
export { createRuleStore, RuleEnableRefused } from "./store/rule/index.js";
export { scheduleTickChannel } from "./automation/matcher.js";

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
export { createMachineEnrollmentStore } from "./store/provisioning/machine-enrollment.js";
export { StoredEndpoint, StoredIdentity } from "./store/sqlite/actor-schema.js";

export { Route, type PendingGroup } from "./automation/matcher.js";

export type { StoredGroup } from "./store/rule/group.js";

export { DeliveryNotSent, IngressRoutingError } from "./errors.js";

export { match } from "./router/automation/match.js";

export { newTraceId } from "./support/trace.js";

export type { KernelDeliveryReceipt } from "./support/deliver.js";

export { findRequestCandidates } from "./router/request/correlation.js";
