import { expect } from "bun:test";
import { Database } from "bun:sqlite";

export function assertNoLegacyRequestStores(dbPath: string): void {
  using db = new Database(dbPath, { readonly: true });
  expect(
    db
      .query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('wait','approval')")
      .all(),
  ).toEqual([]);
}
