import { Database } from "bun:sqlite";

/** The catalog's read-only lifetime; attached package readers cannot run DDL or mutate rows. */
export function readCatalog<A>(path: string, read: (database: Database) => A): A {
  const database = new Database(path, { readonly: true });
  try {
    database.run("PRAGMA query_only = 1");
    return read(database);
  } finally {
    database.close();
  }
}
