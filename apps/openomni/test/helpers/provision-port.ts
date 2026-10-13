import { createAutomationStore, Vault } from "@openomni/channels";
import type { AppLedgerPlane } from "../../src/composition/cluster-runtime";
import type { ProvisionPort } from "../../src/provisioning/channels";
import { testPlane } from "./ledger";

/** Real durable stores under a quiet supervisor: enough for address-book authority tests. */
export function provisionPort(plane: AppLedgerPlane = testPlane()): ProvisionPort {
  return {
    automations: { store: createAutomationStore(plane.channel), id: () => crypto.randomUUID() },
    persons: plane.stores.persons,
    instances: plane.stores.instances,
    secrets: plane.stores.secrets,
    actors: plane.stores.actors,
    transaction: plane.catalog.transaction,
    kek: { kind: "ok", kek: Vault.kekOf(new Uint8Array(32).fill(7)) },
    supervisor: {
      reconcile: async () => [],
      resume: () => true,
      status: () => [],
      source: () => "declared",
    },
    materialize: () => undefined,
    removeIdentity: () => true,
    bundles: { names: () => [], off: () => [], set: async () => undefined },
  };
}
