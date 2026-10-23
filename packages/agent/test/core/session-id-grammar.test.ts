// A session id is one filename component: create/fork refuse unsafe ids typed,
// and the path builder refuses any file outside the sessions dir before open.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { Effect, Result } from "effect";
import { createSession, CreateRefused } from "../../src/core/session/create";
import { forkSession, ForkRefused } from "../../src/core/session/fork";
import { type LedgerPlane, OpenRefused, openLedgerPlane, sessionFilePath } from "../../src/core/session/host";
import { SESSION_FILE_SCHEMA_VERSION } from "../../src/core/store/session-file";
import { boundaryTerminal } from "../helpers/fork-seed";
import { runLedgerSync } from "../store/helpers/effect";
import { adoptWriter } from "../store/helpers/session";

const root = mkdtempSync(join(tmpdir(), "session-id-grammar-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const UNSAFE_IDS = ["../escape-child", "../../../escape-child-up3", "x/y/z/nested-child", ".", "..", "", "nul\0child"];

const genesis = {
  tools: [],
  bundles: [],
  system: { preset: "", blocks: [] },
  policyGeneration: 0,
  actionId: "parent:genesis",
  at: 1,
};

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

function forkWorld(name: string) {
  const caseRoot = join(root, name);
  const data = join(caseRoot, "run", "data");
  const sessionsDir = join(data, "sessions");
  mkdirSync(data, { recursive: true });
  const plane = openLedgerPlane({
    now: () => 1,
    catalog: { path: join(data, "catalog.sqlite") },
    sessions: { dir: sessionsDir },
  });
  runLedgerSync(createSession(plane, { id: "parent", parentId: null, role: "resident", genesis }));
  const kernel = plane.openKernel("parent");
  const authority = adoptWriter(kernel, "parent");
  const terminal = boundaryTerminal("parent", "parent:genesis");
  runLedgerSync(
    kernel.commit({
      ...authority,
      now: 2,
      expectedRevision: kernel.row("parent").revision,
      actions: [terminal],
      state: "idle",
    }),
  );
  const anchor = kernel.latestAction("parent")?.id;
  if (anchor === undefined) throw new Error("parent anchor missing");
  return { caseRoot, sessionsDir, plane, kernel, anchor };
}

function fork(world: ReturnType<typeof forkWorld>, childId: string) {
  return Result.match(
    runLedgerSync(
      Effect.result(
        forkSession(
          {
            parent: world.kernel,
            parentSchemaVersion: SESSION_FILE_SCHEMA_VERSION,
            openChild: () => world.plane.sessionStore(childId),
            catalog: world.plane.catalog,
          },
          { from: "parent", at: world.anchor, childId, genesisActionId: `${childId}:genesis`, now: 3 },
        ),
      ),
    ),
    {
      onSuccess: (receipt) => `forked:${receipt.childId}`,
      onFailure: (error) => (error instanceof ForkRefused ? `refused:${error.reason}` : `error:${error._tag}`),
    },
  );
}

test("fork refuses every unsafe child id typed and creates no file anywhere", () => {
  const world = forkWorld("fork");
  const before = filesUnder(world.caseRoot);
  const outcomes = UNSAFE_IDS.map((childId) => fork(world, childId));
  const created = filesUnder(world.caseRoot).filter((path) => !before.includes(path));
  const outside = created.filter((path) => !resolve(world.caseRoot, path).startsWith(`${world.sessionsDir}/`));
  console.log(
    `fork unsafe ids: refused ${outcomes.filter((o) => o === "refused:child_id_invalid").length}/${UNSAFE_IDS.length}, created:${JSON.stringify(created)}, outside:${JSON.stringify(outside)}`,
  );
  expect(outcomes).toEqual(UNSAFE_IDS.map(() => "refused:child_id_invalid"));
  expect(created).toEqual([]);
  expect(outside).toEqual([]);
  expect(world.plane.catalog.sessionIds()).toEqual(["parent"]);

  expect(fork(world, "good-child")).toBe("forked:good-child");
  expect(filesUnder(world.caseRoot).filter((path) => !before.includes(path) && path.endsWith(".sqlite"))).toEqual([
    "run/data/sessions/good-child.sqlite",
  ]);
  expect(world.plane.catalog.sessionIds().sort()).toEqual(["good-child", "parent"]);
  world.plane.close();
});

test("create refuses an unsafe id typed as invalid_id before any write", () => {
  const world = forkWorld("create");
  const before = filesUnder(world.caseRoot);
  const reasons = UNSAFE_IDS.map((id) =>
    Result.match(
      runLedgerSync(
        Effect.result(createSession(world.plane, { id, parentId: null, role: "resident", genesis: { ...genesis, actionId: `${id}:genesis` } })),
      ),
      { onSuccess: () => "created", onFailure: (error) => (error instanceof CreateRefused ? error.reason : error) },
    ),
  );
  expect(reasons).toEqual(UNSAFE_IDS.map(() => "invalid_id"));
  expect(filesUnder(world.caseRoot)).toEqual(before);
  expect(world.plane.catalog.sessionIds()).toEqual(["parent"]);
  world.plane.close();
});

test("sessionFilePath throws OpenRefused before open for any path outside the sessions dir", () => {
  const world = forkWorld("path");
  const before = filesUnder(world.caseRoot);
  const unsafe = [...UNSAFE_IDS, join(world.caseRoot, "absolute-escape"), "a\\b"];
  for (const id of unsafe) {
    expect(() => sessionFilePath(world.sessionsDir, id)).toThrow(OpenRefused);
    expect(() => world.plane.openKernel(id)).toThrow(OpenRefused);
    expect(() => world.plane.handles.openSession(id)).toThrow(OpenRefused);
  }
  expect(filesUnder(world.caseRoot)).toEqual(before);
  expect(sessionFilePath(world.sessionsDir, "fork_01")).toBe(join(world.sessionsDir, "fork_01.sqlite"));
  expect(sessionFilePath(world.sessionsDir, "a..b")).toBe(join(world.sessionsDir, "a..b.sqlite"));
  world.plane.close();
});

test("the catalog-guarded read refuses unknown and traversal ids with no file created", () => {
  const world = forkWorld("read");
  for (const childId of UNSAFE_IDS) fork(world, childId);
  const before = filesUnder(world.caseRoot);
  const reads = ["no-such-session", "../escape-read", "a/b/nested-read", "/tmp/absolute-read", "../../../../tmp/deep-read", "../escape-child", "x/y/z/nested-child"];
  // The guard the gateway read path applies before it opens a kernel.
  const guard = (plane: LedgerPlane, id: string) =>
    plane.catalog.sessionIndex(id) === undefined ? "session_not_found(guard)" : plane.openKernel(id).row(id).id;
  const outcomes = reads.map((id) => guard(world.plane, id));
  console.log(
    `read guard: ${outcomes.filter((o) => o === "session_not_found(guard)").length}/${reads.length} session_not_found(guard), created:${JSON.stringify(filesUnder(world.caseRoot).filter((path) => !before.includes(path)))}`,
  );
  expect(outcomes).toEqual(reads.map(() => "session_not_found(guard)"));
  expect(filesUnder(world.caseRoot)).toEqual(before);
  world.plane.close();
});
