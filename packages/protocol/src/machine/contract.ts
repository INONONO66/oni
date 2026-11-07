/**
 * Version of the machine wire contract exported as JSON Schema under
 * `packages/protocol/schema/machine/`. Bump it when a change to a machine
 * schema would make a peer generated from the previous export misread a frame.
 */
export const contractVersion = 6 as const;

/**
 * Peer contract versions a host admits at `machine.attach`. Since #1832 every
 * attach follows a signed `machine.handshake`, which only `handshakeContractVersion`
 * peers speak, so older peers get the typed `unsupported_contract` refusal.
 */
export const supportedContractVersions = [6] as const;

/** First peer contract that decodes `AttachResult.consentRequired`. */
export const consentContractVersion = 5 as const;

/** First peer contract that opens every connection with `machine.handshake` (#1832). */
export const handshakeContractVersion = 6 as const;

/**
 * Git tag prefix of a client release: a release of `Release.version` is
 * published under `${releaseTagPrefix}${version}`, the tag `GET
 * /machine/release` reports for the record the host was built with.
 */
export const releaseTagPrefix = "mclient-v" as const;
