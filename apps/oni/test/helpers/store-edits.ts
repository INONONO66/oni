import { PlainObjectSchema } from "@oni/protocol";
import { z } from "zod";
import type { TestLedgerPlane } from "./ledger";
import { testIds } from "./test-entropy";

const Row = z.object({ data: z.string() });

export function storeEditFixture(plane: TestLedgerPlane) {
  return {
    port: {
      transaction: plane.transaction, record: plane.stores.recordStoreEdit,
      now: () => 1000, id: testIds("store-edit"),
    },
    rows: () => Row.array().parse(plane.catalogDatabase.query("SELECT data FROM store_edit ORDER BY rowid").all())
      .map((row) => PlainObjectSchema.parse(JSON.parse(row.data))),
  };
}
