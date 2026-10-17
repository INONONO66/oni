import * as Schema from "./schema.js";
import * as Wire from "./wire.js";

/**
 * Provisioning namespace (docs/provisioning-and-providers.md §3): Person /
 * ChannelInstance / Secret declaration schemas and the typed store + vault
 * errors. Envelope crypto and durable persistence live in
 * the channels store plane's provisioning band (`packages/channels/src/store/`).
 */
export namespace Provisioning {
  export const Person = Schema.Person;
  export type Person = Schema.Person;

  export const ChannelInstance = Schema.ChannelInstance;
  export type ChannelInstance = Schema.ChannelInstance;

  export const Secret = Schema.Secret;
  export type Secret = Schema.Secret;

  // #1600: the grant block a channel declaration writes (tier, allowlist, mention-only).
  export const ChannelGrantDeclaration = Schema.ChannelGrantDeclaration;
  export type ChannelGrantDeclaration = Schema.ChannelGrantDeclaration;

  export const StoreError = Schema.StoreError;
  export type StoreError = InstanceType<typeof Schema.StoreError>;

  export const VaultError = Schema.VaultError;
  export type VaultError = InstanceType<typeof Schema.VaultError>;

  // #1569 lane 5b: the Owner's channel declaration over the ws wire.
  export const ChannelDeclareRequest = Wire.ChannelDeclareRequest;
  export type ChannelDeclareRequest = Wire.ChannelDeclareRequest;
  export const ChannelDeclareRefused = Wire.ChannelDeclareRefused;
  export type ChannelDeclareRefused = Wire.ChannelDeclareRefused;
  export const ChannelDeclareResponse = Wire.ChannelDeclareResponse;
  export type ChannelDeclareResponse = Wire.ChannelDeclareResponse;
}
