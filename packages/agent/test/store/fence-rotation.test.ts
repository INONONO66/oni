// Every entity activation rotates
// the catalog fence (F5 CAS) and adopts it into the session file's fence CAS;
// commits are authorized by owner+fence, so the previous activation's writer
// is refused "stale" the moment a newer activation adopts - across OS
// processes and across restarts. Folds in review R8: SIGKILL between BEGIN
// IMMEDIATE and COMMIT inside commitSession leaves no partial action row.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LedgerAction, LedgerSession } from "@oni/protocol";
import { Effect } from "effect";
import { L0Write } from "../../src/core/store/session-file";
import type { LedgerError } from "../../src/core/store/errors";
import { createSessionKernel, type SessionKernel } from "../../src/core/store/fence";
import type { CatalogStore } from "../../src/core/store/catalog";
import { openCatalogStore } from "../../src/core/store/catalog";
import { openSessionStore } from "../../src/core/store/session-file";
import { runLedgerSync } from "./helpers/effect";
import { TEST_NOW, testNow } from "./helpers/storage";

const PACKAGE_ROOT = resolve(import.meta.dir, "../..");

const refuse: (error: LedgerError) => never = (error) => {
  throw error;
};

function promptAction(id: string, sessionId: string, content: string): LedgerAction.Append {
  return {
    id,
    parentId: null,
    sessionId,
    kind: "prompt",
    intent: { encodingVersion: 1, value: { source: "fence-rotation-test" } },
    effect: { encodingVersion: 1, value: { deliveryKind: "prompt", content } },
    irreversible: true,
    ts: 1,
  };
}

function commitRequest(
  kernel: SessionKernel,
  sessionId: string,
  owner: string,
  fence: number,
  action: LedgerAction.Append,
): LedgerSession.Commit {
  const row = kernel.row(sessionId);
  return {
    sessionId,
    owner,
    fence,
    now: TEST_NOW,
    expectedRevision: row.revision,
    actions: [action],
    state: row.state,
  };
}

/** The activation protocol twin: rotate the catalog fence, then adopt it into the file fence CAS. */
function adoptFence(kernel: SessionKernel, sessionId: string, owner: string, fence: number): void {
  const current = kernel.row(sessionId);
  if (current.fence === fence && current.fenceOwner === owner) return;
  if (current.fence >= fence)
    throw new Error(`stale activation: ${current.fence} >= ${fence}`);
  runLedgerSync(kernel.adoptFence({ sessionId, owner, fence }));
}

function activate(
  catalog: CatalogStore,
  kernel: SessionKernel,
  sessionId: string,
  owner: string,
): number {
  const fence = catalog.rotateFence(sessionId);
  adoptFence(kernel, sessionId, owner, fence);
  return fence;
}

function setup(sessionId: string) {
  const directory = mkdtempSync(join(tmpdir(), "fence-rotation-"));
  const sessionPath = join(directory, `${sessionId}.sqlite`);
  const catalogPath = join(directory, "catalog.sqlite");
  const catalog = openCatalogStore(catalogPath, { now: testNow });
  const session = openSessionStore(sessionPath, { now: testNow });
  const kernel = createSessionKernel(session, catalog);
  runLedgerSync(
    kernel.materialize({
      id: sessionId,
      parentId: null,
      role: "resident",
      tools: [],
      system: { preset: "", blocks: [] },
      policyGeneration: 0,
      actionId: `${sessionId}:configure`,
      at: 1,
    }),
  );
  catalog.indexSession({ id: sessionId, parentId: null, role: "resident", createdAt: 1 });
  const close = () => {
    session.close();
    catalog.close();
    rmSync(directory, { recursive: true });
  };
  return { directory, sessionPath, catalogPath, catalog, session, kernel, close };
}

/** Raw single-connection commit as one writer identity, wrapped like the adapter (one transaction). */
function rawCommit(sessionPath: string, request: LedgerSession.Commit): LedgerSession.CommitResult {
  const db = new Database(sessionPath);
  db.run("PRAGMA busy_timeout = 5000");
  try {
    const result = db
      .transaction(() =>
        L0Write.commitSession(db, request, { rowByteCap: L0Write.DEFAULT_ROW_BYTE_CAP }, refuse),
      )
      .immediate();
    if (result === undefined) throw new Error(`missing session row: ${request.sessionId}`);
    return result;
  } finally {
    db.close();
  }
}

async function collect(child: ReturnType<typeof Bun.spawn>) {
  return {
    exitCode: await child.exited,
    stdout: await new Response(child.stdout as ReadableStream).text(),
    stderr: await new Response(child.stderr as ReadableStream).text(),
  };
}

/** Await the first stdout line without polling; the line is the synchronizer. */
async function readLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const index = buffer.indexOf("\n");
    if (index >= 0) return buffer.slice(0, index);
  }
  return buffer;
}

test("activation rotates and adopts the fence; every superseded writer is refused stale", () => {
  const world = setup("s1");
  try {
    const { catalog, kernel, sessionPath } = world;
    // First activation: fence 0 -> 1 on a never-leased file.
    expect(activate(catalog, kernel, "s1", "runner:a")).toBe(1);
    const first = runLedgerSync(
      kernel.commit(commitRequest(kernel, "s1", "runner:a", 1, promptAction("a1", "s1", "from a"))),
    );
    expect(first.ok).toBe(true);

    // Second activation takes over without any expiry clock: the catalog CAS
    // win IS the takeover authority.
    expect(activate(catalog, kernel, "s1", "runner:b")).toBe(2);
    expect(kernel.row("s1")).toMatchObject({ fenceOwner: "runner:b", fence: 2 });
    expect(
      runLedgerSync(
        kernel.commit(
          commitRequest(kernel, "s1", "runner:b", 2, promptAction("b1", "s1", "from b")),
        ),
      ).ok,
    ).toBe(true);

    // The superseded writer is refused with the raw l0 "stale" token and
    // leaves nothing behind - not the action, not a revision bump.
    const revisionBefore = kernel.row("s1").revision;
    const stale = rawCommit(
      sessionPath,
      commitRequest(kernel, "s1", "runner:a", 1, promptAction("a-stale", "s1", "late")),
    );
    expect(stale).toMatchObject({ ok: false, reason: "stale", currentFence: 2 });
    expect(kernel.actionById("a-stale")).toBeUndefined();
    expect(kernel.row("s1").revision).toBe(revisionBefore);

    // The adapter's typed refusal is the session file's own verdict (the file is
    // the one fence authority; the catalog never enters the
    // commit path): CommitRefused{reason:"fence"} carrying the file's fence.
    const refused = runLedgerSync(
      Effect.flip(
        kernel.commit(
          commitRequest(kernel, "s1", "runner:a", 1, promptAction("a-stale-2", "s1", "late")),
        ),
      ),
    );
    expect(refused).toMatchObject({ _tag: "CommitRefused", reason: "fence", currentFence: 2 });
    expect(kernel.actionById("a-stale-2")).toBeUndefined();

    // Restart rotates again and the previous holder is refused in turn.
    expect(activate(catalog, kernel, "s1", "runner:c")).toBe(3);
    expect(
      rawCommit(
        sessionPath,
        commitRequest(kernel, "s1", "runner:b", 2, promptAction("b-stale", "s1", "late")),
      ),
    ).toMatchObject({ ok: false, reason: "stale", currentFence: 3 });

    // A rotation that lost the adoption race refuses: the file fence already
    // reached a later activation's fence (multi-step adoption walks 3 -> 5).
    const lost = catalog.rotateFence("s1");
    expect(lost).toBe(4);
    expect(activate(catalog, kernel, "s1", "runner:e")).toBe(5);
    expect(() => adoptFence(kernel, "s1", "runner:d", lost)).toThrow("stale activation: 5 >= 4");

    expect(kernel.verifyChain("s1")).toMatchObject({ kind: "intact" });
  } finally {
    world.close();
  }
});

// F5 across OS processes: two concurrent activations on one session file get
// distinct consecutive fences; whatever the interleaving, the higher fence
// ends as the only writer the file accepts.
test("concurrent activations from two processes: one winner, stale loser refused", async () => {
  const world = setup("s2");
  try {
    const childSource = `
      import { Effect } from "effect";
      import { createSessionKernel } from "./src/core/store/fence.ts";
      import { openCatalogStore } from "./src/core/store/catalog.ts";
      import { openSessionStore } from "./src/core/store/session-file/index.ts";
      import { runLedgerSync } from "./test/store/helpers/effect.ts";
      const sessionId = String(process.env.FENCE_SESSION_ID);
      const owner = String(process.env.FENCE_OWNER);
      const catalog = openCatalogStore(String(process.env.FENCE_CATALOG_PATH), { now: () => 1_700_000_000_000 });
      const session = openSessionStore(String(process.env.FENCE_SESSION_PATH), { now: () => 1_700_000_000_000 });
      const kernel = createSessionKernel(session, catalog);
      const fence = catalog.rotateFence(sessionId);
      const adoption = runLedgerSync(Effect.result(kernel.adoptFence({ sessionId, owner, fence })));
      const adopted = adoption._tag === "Success";
      let committed = false;
      let reason = "";
      if (adopted) {
        const row = kernel.row(sessionId);
        const outcome = runLedgerSync(Effect.result(kernel.commit({
          sessionId, owner, fence, now: 1_700_000_000_000, expectedRevision: row.revision,
          actions: [{
            id: String(process.env.FENCE_ACTION_ID), parentId: null, sessionId, kind: "prompt",
            intent: { encodingVersion: 1, value: { source: owner } },
            effect: { encodingVersion: 1, value: { deliveryKind: "prompt", content: owner } },
            irreversible: true, ts: 1_700_000_000_000,
          }],
          state: row.state,
        })));
        committed = outcome._tag === "Success";
        if (!committed) reason = outcome.failure.reason ?? outcome.failure._tag;
      } else {
        reason = "activation_stale";
      }
      catalog.close();
      session.close();
      console.log(JSON.stringify({ owner, fence, committed, reason }));
    `;
    const children = ["runner:p1", "runner:p2"].map((owner, index) =>
      Bun.spawn([process.execPath, "-e", childSource], {
        cwd: PACKAGE_ROOT,
        env: {
          ...process.env,
          FENCE_SESSION_ID: "s2",
          FENCE_CATALOG_PATH: world.catalogPath,
          FENCE_SESSION_PATH: world.sessionPath,
          FENCE_OWNER: owner,
          FENCE_ACTION_ID: `race-${index}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const results = await Promise.all(children.map(collect));
    for (const result of results) {
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    }
    const reports = results
      .map(
        (result) =>
          JSON.parse(result.stdout.trim()) as {
            owner: string;
            fence: number;
            committed: boolean;
            reason: string;
          },
      )
      .sort((left, right) => left.fence - right.fence);
    expect(reports.map((report) => report.fence)).toEqual([1, 2]);
    const [loser, winner] = reports;
    if (loser === undefined || winner === undefined) throw new Error("expected two child reports");

    // The higher fence always adopts and commits; the lower either committed
    // before the takeover or was refused - never anything else. `fence` is the
    // session file's own CAS (the one fence authority);
    // `activation_stale` is an adoption that lost the file CAS outright.
    expect(winner.committed).toBe(true);
    if (!loser.committed) expect(loser.reason).toMatch(/^(fence|activation_stale)$/);

    const { kernel } = world;
    expect(kernel.row("s2")).toMatchObject({ fenceOwner: winner.owner, fence: 2 });
    expect(kernel.actionById("race-1") ?? kernel.actionById("race-0")).toBeDefined();
    expect(kernel.verifyChain("s2")).toMatchObject({ kind: "intact" });

    // Exactly one writer now: the loser's identity is refused stale, the winner's still commits.
    expect(
      rawCommit(
        world.sessionPath,
        commitRequest(
          kernel,
          "s2",
          loser.owner,
          loser.fence,
          promptAction("loser-late", "s2", "late"),
        ),
      ),
    ).toMatchObject({ ok: false, reason: "stale", currentFence: 2 });
    expect(
      rawCommit(
        world.sessionPath,
        commitRequest(
          kernel,
          "s2",
          winner.owner,
          winner.fence,
          promptAction("winner-more", "s2", "more"),
        ),
      ).ok,
    ).toBe(true);
  } finally {
    world.close();
  }
});

// Review R8: SIGKILL between BEGIN IMMEDIATE and COMMIT around commitSession.
// The marker line on stdout is the synchronizer (printed after commitSession
// returned ok inside the still-open transaction); the child's park is only a
// bounded failure guard, never a timing assumption.
test("R8: kill inside the commit transaction leaves no partial action row", async () => {
  const world = setup("s3");
  try {
    const { catalog, kernel, sessionPath } = world;
    const fence = activate(catalog, kernel, "s3", "runner:r8");
    const row = kernel.row("s3");
    const childSource = `
      import { Database } from "bun:sqlite";
      import { L0Write } from "./src/core/store/session-file/index.ts";
      const db = new Database(String(process.env.FENCE_SESSION_PATH));
      db.run("PRAGMA busy_timeout = 5000");
      db.run("BEGIN IMMEDIATE");
      const result = L0Write.commitSession(db, {
        sessionId: "s3", owner: "runner:r8", fence: Number(process.env.FENCE_FENCE),
        now: 1_700_000_000_000, expectedRevision: Number(process.env.FENCE_REVISION),
        actions: [{
          id: "r8-a1", parentId: null, sessionId: "s3", kind: "prompt",
          intent: { encodingVersion: 1, value: { source: "r8" } },
          effect: { encodingVersion: 1, value: { deliveryKind: "prompt", content: "r8" } },
          irreversible: true, ts: 1_700_000_000_000,
        }],
        state: "idle",
      }, { rowByteCap: L0Write.DEFAULT_ROW_BYTE_CAP }, (error) => { throw error; });
      console.log(JSON.stringify({ ok: result?.ok === true }));
      Bun.sleepSync(15_000); // park inside the open transaction until SIGKILL
      db.run("COMMIT");
    `;
    const child = Bun.spawn([process.execPath, "-e", childSource], {
      cwd: PACKAGE_ROOT,
      env: {
        ...process.env,
        FENCE_SESSION_PATH: sessionPath,
        FENCE_FENCE: String(fence),
        FENCE_REVISION: String(row.revision),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const marker = JSON.parse(await readLine(child.stdout as ReadableStream<Uint8Array>)) as {
      ok: boolean;
    };
    expect(marker.ok).toBe(true);
    child.kill("SIGKILL");
    await child.exited;
    expect(child.signalCode).toBe("SIGKILL");

    // Nothing of the killed transaction survives: no action row, no revision bump.
    expect(kernel.actionById("r8-a1")).toBeUndefined();
    expect(kernel.row("s3").revision).toBe(row.revision);
    expect(kernel.verifyChain("s3")).toMatchObject({ kind: "intact" });

    // The write lock died with the process: the holder commits the same action id cleanly.
    const retried = runLedgerSync(
      kernel.commit(
        commitRequest(kernel, "s3", "runner:r8", fence, promptAction("r8-a1", "s3", "retried")),
      ),
    );
    expect(retried.ok).toBe(true);
    expect(kernel.actionById("r8-a1")).toBeDefined();
  } finally {
    world.close();
  }
});
