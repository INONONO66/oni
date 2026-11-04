import type { Database } from "bun:sqlite";
import { type BusEvent, Machine } from "@oni/protocol";

type EventData<D> = D extends BusEvent.Descriptor<infer T> ? T : never;

export type PeerLeaseReceipt =
  | ({ readonly kind: "issued" } & EventData<typeof Machine.Events.PeerLeaseIssued>)
  | ({ readonly kind: "used" } & EventData<typeof Machine.Events.PeerLeaseUsed>)
  | ({ readonly kind: "ended" } & EventData<typeof Machine.Events.PeerLeaseEnded>);

export function createPeerLeaseReceiptWriter(database: Database) {
  database.run(`CREATE TABLE IF NOT EXISTS peer_lease_receipt (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    lease_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('issued', 'used', 'ended')),
    data TEXT NOT NULL CHECK (json_valid(data))
  )`);
  return (receipt: PeerLeaseReceipt): void => {
    const leaseId = receipt.kind === "issued" ? receipt.lease.id : receipt.leaseId;
    database
      .query("INSERT INTO peer_lease_receipt (lease_id, kind, data) VALUES (?, ?, ?)")
      .run(leaseId, receipt.kind, JSON.stringify(receipt));
  };
}

/**
 * The receipt is written before the event is published: a refused write
 * throws out of the host's lease operation, so no lease is issued or used
 * that the catalog does not hold. Observations confer nothing (#1841 r1 H2).
 */
export function withPeerLeaseReceipts<S extends BusEvent.Sink>(
  sink: S,
  record: (receipt: PeerLeaseReceipt) => void,
): S {
  return {
    ...sink,
    publish<T>(event: BusEvent.Descriptor<T>, data: T) {
      switch (event.name) {
        case Machine.Events.PeerLeaseIssued.name:
          record({ kind: "issued", ...Machine.Events.PeerLeaseIssued.schema.parse(data) });
          break;
        case Machine.Events.PeerLeaseUsed.name:
          record({ kind: "used", ...Machine.Events.PeerLeaseUsed.schema.parse(data) });
          break;
        case Machine.Events.PeerLeaseEnded.name:
          record({ kind: "ended", ...Machine.Events.PeerLeaseEnded.schema.parse(data) });
          break;
      }
      sink.publish(event, data);
    },
  };
}
