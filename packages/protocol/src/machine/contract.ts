/**
 * Version of the machine wire contract exported as JSON Schema under
 * `packages/protocol/schema/machine/`. Bump it when a change to a machine
 * schema would make a peer generated from the previous export misread a frame.
 */
export const contractVersion = 5 as const;

/** Peer contract versions a host admits at `machine.attach`. */
export const supportedContractVersions = [3, 4, 5] as const;

/**
 * Git tag prefix of a client release: a release of `Release.version` is
 * published under `${releaseTagPrefix}${version}`, the tag `GET
 * /machine/release` reports for the record the host was built with.
 */
export const releaseTagPrefix = "mclient-v" as const;
