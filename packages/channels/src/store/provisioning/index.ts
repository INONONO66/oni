import { Provisioning } from "@oni/protocol";
import type { Storage as ProtocolStorage } from "@oni/protocol";

export { Vault } from "./vault";

/** The catalog-handle slice provisioning stores write through (W5.2 F1). */
export interface ProvisioningSource {
  readonly provisioning?: ProtocolStorage.ProvisioningSubAdapter;
  transaction<T>(operation: () => T): T;
}

export type PersonStore = ReturnType<typeof createPersonStore>;
export type ChannelInstanceStore = ReturnType<typeof createChannelInstanceStore>;
export type SecretStore = ReturnType<typeof createSecretStore>;

function requireAdapter(source: ProvisioningSource): ProtocolStorage.ProvisioningSubAdapter {
  const sub = source.provisioning;
  if (sub === undefined || sub === null) {
    throw new Provisioning.StoreError({
      message: "Storage adapter does not implement provisioning",
      code: "adapter_absent",
    });
  }
  return sub;
}

/** Durable person records; product constraints are enforced by composition. */
export function createPersonStore(source: ProvisioningSource) {
  return {
    put(input: Provisioning.Person): Provisioning.Person {
      const person = Provisioning.Person.parse(input);
      const adapter = requireAdapter(source);
      return source.transaction(() => {
        adapter.setPerson(person);
        return person;
      });
    },

    get(id: string): Provisioning.Person | undefined {
      return requireAdapter(source).getPerson(id);
    },

    list(): Provisioning.Person[] {
      return requireAdapter(source).listPersons();
    },

    remove(id: string): boolean {
      return requireAdapter(source).removePerson(id);
    },
  };
}

/** Durable ChannelInstance declarations (§3.2). Reconciliation meaning belongs to the app. */
export function createChannelInstanceStore(source: ProvisioningSource) {
  return {
    put(input: Provisioning.ChannelInstance): Provisioning.ChannelInstance {
      const instance = Provisioning.ChannelInstance.parse(input);
      requireAdapter(source).setChannelInstance(instance);
      return instance;
    },

    get(id: string): Provisioning.ChannelInstance | undefined {
      return requireAdapter(source).getChannelInstance(id);
    },

    list(): Provisioning.ChannelInstance[] {
      return requireAdapter(source).listChannelInstances();
    },

    remove(id: string): boolean {
      return requireAdapter(source).removeChannelInstance(id);
    },
  };
}

/** Durable vault rows (§3.3): ciphertext in, ciphertext out. Crypto lives in `Vault`. */
export function createSecretStore(source: ProvisioningSource) {
  return {
    put(input: Provisioning.Secret): Provisioning.Secret {
      const secret = Provisioning.Secret.parse(input);
      requireAdapter(source).setSecret(secret);
      return secret;
    },

    get(id: string): Provisioning.Secret | undefined {
      return requireAdapter(source).getSecret(id);
    },

    list(): Provisioning.Secret[] {
      return requireAdapter(source).listSecrets();
    },

    remove(id: string): boolean {
      return requireAdapter(source).removeSecret(id);
    },
  };
}
