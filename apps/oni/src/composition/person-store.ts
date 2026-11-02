import { createPersonStore as createRecords } from "@oni/channels";
import { Provisioning } from "@oni/protocol";

/** The app admits one Owner; the record store knows no distinguished tier. */
export function createPersonStore(source: Parameters<typeof createRecords>[0]) {
  const records = createRecords(source);
  return {
    ...records,
    put(input: Provisioning.Person): Provisioning.Person {
      return source.transaction(() => {
        if (input.trustTier === "owner") {
          const owner = records.list().find((person) => person.trustTier === "owner");
          if (owner !== undefined && owner.id !== input.id)
            throw new Provisioning.StoreError({
              message: `Sole-owner invariant: ${owner.id} already holds trustTier "owner"`,
              code: "owner_exists",
              id: owner.id,
            });
        }
        return records.put(input);
      });
    },
  };
}
