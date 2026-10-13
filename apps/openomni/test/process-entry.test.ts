import { expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { clusterMessages } from "../../../packages/agent/test/helpers/cluster-runtime";
import { gatewayRuntime } from "../src/gateway";
import { runProcessEntry } from "../src/process-entry";
import type { AppRuntimeOptions } from "../src/runtime";
import { composedHolder } from "./helpers/bundle-fixture";
import { Bus } from "./helpers/bus";
import { appRuntime } from "./helpers/effect";
import { planeOf } from "./helpers/ledger";
import { messageFixture } from "./helpers/message-fixture";
import { bounded } from "./helpers/protected-dispatch";

/** The runner's tables in a catalog file, by name; the parent's host creates them, the child never may. */
function runnerTables(catalogPath: string): string[] {
  const db = new Database(catalogPath, { readonly: true });
  try {
    return db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cluster_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

/**
 * A process child shares the parent's ledger catalog but never its runner
 * tables: the child's host pins `cluster.storagePath` to `:memory:`, so its
 * activation rotates the shared session fence while the parent's
 * `cluster_messages` sees no child message.
 */
test("the process child isolates its runner tables in :memory: while the ledger catalog stays shared", async () => {
  const fixture = messageFixture("resident");
  const catalogPath = join(fixture.directory, "catalog.sqlite");
  const sessionsDir = join(fixture.directory, "sessions");
  const parent = appRuntime({ composed: composedHolder(), observations: Bus, catalogPath, sessionsDir });
  const stdin = new PassThrough();
  const requested: AppRuntimeOptions[] = [];
  const log = mock((_line: string): void => undefined);
  const exit = mock((code: number): never => {
    throw new Error(`unexpected process exit: ${code}`);
  });
  try {
    const parentPlane = await planeOf(parent);
    const tables = runnerTables(catalogPath);
    expect(tables).toContain("cluster_messages");
    // The fixture materializes the session file only; the child's activation
    // indexes and fences it in the catalog the parent reads.
    expect(parentPlane.catalog.sessionIndex(fixture.sessionId)).toBeUndefined();

    const running = runProcessEntry({
      stdin,
      log,
      exit,
      gatewayRuntime: (options) => {
        requested.push(options);
        return gatewayRuntime(options);
      },
    });
    const request = {
      sessionId: fixture.sessionId,
      catalogPath,
      sessionsDir,
      entityIdleMs: 50,
      model: { provider: "fake", id: "fixture" },
      apiKey: "fixture-key",
    };
    stdin.write(`${JSON.stringify(request)}\n`);
    await bounded(running);

    expect(requested).toEqual([
      expect.objectContaining({ catalogPath, sessionsDir, clusterStoragePath: ":memory:" }),
    ]);
    expect(exit).not.toHaveBeenCalled();
    // Shared catalog: the parent's own handle sees the child's index row and rotated fence.
    expect(parentPlane.catalog.sessionIndex(fixture.sessionId)?.fence).toBeGreaterThanOrEqual(1);
    // Isolated runner: the child's wake never landed in the parent's tables.
    expect(clusterMessages(catalogPath, "Session")).toEqual([]);
    expect(runnerTables(catalogPath)).toEqual(tables);
  } finally {
    stdin.destroy();
    await parent.dispose();
    Bus.reset();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
