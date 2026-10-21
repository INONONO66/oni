import { beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObservationSink } from "@oni/protocol";
import { openCatalogStore } from "../../../src/core/store/catalog";
import { openSessionStore } from "../../../src/core/store/session-file";
import * as SessionHandleStore from "../../../src/core/store/fence";

/** Fixed injected clock: ledger tests assert exact timestamps. */
export const TEST_NOW = 1_700_000_000_000;
export const testNow = (): number => TEST_NOW;

type SessionStore = ReturnType<typeof openSessionStore>;
type CatalogStore = ReturnType<typeof openCatalogStore>;

export interface LedgerStores {
  readonly session: SessionStore;
  readonly catalog: CatalogStore;
  readonly kernel: SessionHandleStore.SessionKernel;
}

function open(paths: { session: string; catalog: string }, sink?: ObservationSink): LedgerStores {
  const session = openSessionStore(paths.session, { now: testNow, observationSink: sink });
  const catalog = openCatalogStore(paths.catalog, { now: testNow, observationSink: sink });
  return { session, catalog, kernel: SessionHandleStore.createSessionKernel(session, catalog) };
}

function accessors(current: () => LedgerStores): LedgerStores {
  return {
    get session() {
      return current().session;
    },
    get catalog() {
      return current().catalog;
    },
    get kernel() {
      return current().kernel;
    },
  };
}

/**
 * One real on-disk `<sessionFile>` + `catalog.sqlite` pair in a fresh temp
 * directory for the duration of `body`; the handles close and the directory
 * is removed on every exit. Session store options ride `options.session`.
 */
type SessionStoreOptions = Parameters<typeof openSessionStore>[1];

export function withDiskStores<A>(
  label: string,
  body: (stores: LedgerStores & { readonly directory: string; readonly path: string }) => A,
  options: { readonly sessionFile?: string; readonly session?: Partial<SessionStoreOptions> } = {},
): A {
  const directory = mkdtempSync(join(tmpdir(), `${label}-`));
  const path = join(directory, options.sessionFile ?? "s1.sqlite");
  const session = openSessionStore(path, { now: testNow, ...options.session });
  const catalog = openCatalogStore(join(directory, "catalog.sqlite"), { now: testNow });
  try {
    return body({ session, catalog, kernel: SessionHandleStore.createSessionKernel(session, catalog), directory, path });
  } finally {
    session.close();
    catalog.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Fresh in-memory session + catalog stores and a kernel over them, per test. */
export function useMemoryStores(sink?: ObservationSink): LedgerStores {
  let stores: LedgerStores | undefined;
  beforeEach(() => {
    stores = open({ session: ":memory:", catalog: ":memory:" }, sink);
  });
  afterEach(() => {
    stores?.session.close();
    stores?.catalog.close();
    stores = undefined;
  });
  const current = (): LedgerStores => {
    if (stores === undefined) throw new Error("stores are only open inside a test");
    return stores;
  };
  return accessors(current);
}

/** Own one real on-disk session+catalog pair per test; `reopen` survives restarts. */
export function useSqliteStores(label: string): LedgerStores & {
  readonly sessionPath: string;
  readonly catalogPath: string;
  reopen(): void;
} {
  let directory = "";
  let stores: LedgerStores | undefined;
  const paths = { session: "", catalog: "" };
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), `${label}-`));
    paths.session = join(directory, "session.sqlite");
    paths.catalog = join(directory, "catalog.sqlite");
    stores = open(paths);
  });
  afterEach(() => {
    stores?.session.close();
    stores?.catalog.close();
    stores = undefined;
    rmSync(directory, { recursive: true });
  });
  const current = (): LedgerStores => {
    if (stores === undefined) throw new Error("stores are only open inside a test");
    return stores;
  };
  const live = accessors(current);
  return {
    get session() {
      return live.session;
    },
    get catalog() {
      return live.catalog;
    },
    get kernel() {
      return live.kernel;
    },
    get sessionPath() {
      return paths.session;
    },
    get catalogPath() {
      return paths.catalog;
    },
    reopen() {
      current().session.close();
      current().catalog.close();
      stores = open(paths);
    },
  };
}
