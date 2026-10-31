/**
 * Version of the machine wire contract exported as JSON Schema under
 * `packages/protocol/schema/machine/`. Bump it when a change to a machine
 * schema would make a peer generated from the previous export misread a frame.
 */
export const contractVersion = 4 as const;

/** Peer contract versions a host admits at `machine.attach`. */
export const supportedContractVersions = [3, 4] as const;
