import { turnTerminal } from "../src/core/store/session-reads";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalDigest, FoldCheckpoint, PlainValueSchema } from "@oni/protocol";

import { isolatedRun } from "./helpers/isolated";
import { openCrashStores } from "./helpers/crash-stores";
import { sessionTree } from "./helpers/session-tree";
import { FoldCheckpointIntegrityError, foldHistoryState, hydrateSessionHistory, } from "../src/inspect/history";
import { reconstructionMain, reconstructionProcessMain, reconstructionWitness, } from "./helpers/durable-reconstruction";
import { reconstructionSession } from "./helpers/reconstruction-fixture";
import { bounded } from "./helpers/bounded";
import { z } from "zod";

const helperScript = new URL("./helpers/durable-reconstruction.ts", import.meta.url).pathname;
const witnessSchema = reconstructionWitness;

/**
 * A fresh bun child on a cold CI runner needs far longer than the suite-wide
 * 5000 ms default to boot, replay the fixture, and exit; the wait is still the
 * exact completion signal (child exit plus drained pipes), never a sleep.
 */
const childDeadlineMs = 60_000;

/** The witness travels through a regular file: the child's stdout pipe is non-blocking on Linux. */
const refusalSchema = z.object({
  name: z.literal("FoldCheckpointIntegrityError"),
  data: z.object({
    code: z.literal("fold_checkpoint_integrity"),
    reason: z.string(),
    checkpointId: z.string(),
    sessionId: z.string(),
  }).passthrough(),
});

async function child<S extends z.ZodType>(stage: string, dbPath: string, schema: S) {
  const witnessPath = `${dbPath}.${stage}.witness.json`;
  const process = Bun.spawn([Bun.which("bun") ?? "bun", helperScript, witnessPath, stage, dbPath], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [code, stdout, stderr] = await bounded(
      Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ]),
      `reconstruction ${stage} child exit`,
      childDeadlineMs,
    );
    expect(stderr).toBe("");
    expect(stdout).toBe("");
    return { code, value: schema.parse(JSON.parse(readFileSync(witnessPath, "utf8"))) };
  } finally {
    process.kill();
  }
}

test(
  "fresh-process checkpoint plus bounded suffix equals independent full replay",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "fold-restart-"));
    try {
      const dbPath = join(directory, "kernel.sqlite");
      const written = await child("write", dbPath, witnessSchema);
      expect(written.code).toBe(0);
      const cut = written.value;
      expect(cut.revision).toBeGreaterThan(256);
      const reopened = await child("read", dbPath, witnessSchema);
      expect(reopened.code).toBe(0);
      const wake = reopened.value;
      expect(wake.digest).toBe(wake.oracle);
      expect(wake.stateDigest).toBe(wake.stateOracle);
      const checkpoint = wake.checkpoint;
      if (checkpoint === undefined) throw new Error("missing fold checkpoint");
      expect(FoldCheckpoint.Effect.parse(checkpoint.effect.value).result.foldVersion).toBe(1);
      expect(wake.ids.slice(1)).toEqual(["answer", "tool-message", "suffix"]);
      expect(
        wake.history.find((message) => message.info.id === "tool-message")?.parts,
      ).toContainEqual(
        expect.objectContaining({
          type: "tool",
          state: expect.objectContaining({ status: "completed", output: "settled" }),
        }),
      );
      const seeds = wake.actions
        .filter((action) => action.kind === "fold.checkpoint")
        .map((action) => FoldCheckpoint.Effect.parse(action.effect.value).result.state);
      expect(
        seeds.some((seed) =>
          seed.messages.some((message) =>
            message.parts.some((part) => part.type === "tool" && part.state.status === "pending"),
          ),
        ),
      ).toBe(true);
      expect(wake).toEqual(cut);
      expect(await child("read", dbPath, witnessSchema)).toEqual(reopened);
      const captured = await child("wake", dbPath, witnessSchema);
      expect(captured.code).toBe(0);
      const entry = captured.value;
      expect(entry.capture).toMatchObject({
        toolsGeneration: 1,
        recoveryUnchanged: true,
        context: {
          foldVersion: 1,
          sourceRevision: cut.revision,
          messageIds: cut.ids,
          projectionHash: canonicalDigest({
            foldVersion: 1,
            projection: PlainValueSchema.parse(cut.history),
          }),
        },
      });
      expect(entry.capture?.history).toEqual(cut.history);
      expect(entry.capture?.messages).toEqual(
        foldHistoryState(reconstructionSession, cut.actions).compatibility,
      );
      expect(entry.capture?.messages.map((message) => message.id)).toContain("prior-result");
      expect(entry.capture?.history.map((message) => message.info.id)).not.toContain(
        "prior-result",
      );
      const afterWake = await child("read", dbPath, witnessSchema);
      const after = afterWake.value;
      expect(after.digest).toBe(cut.digest);
      expect(after.stateDigest).toBe(after.stateOracle);
      expect(after.actions.slice(0, cut.actions.length)).toEqual(cut.actions);
      expect(
        after.actions.flatMap((action) => turnTerminal(action) ?? []),
      ).toHaveLength(
        cut.actions.flatMap((action) => turnTerminal(action) ?? []).length,
      );
      expect(await child("read", dbPath, witnessSchema)).toEqual(afterWake);
      const compaction = wake.actions
        .filter(
          (action) =>
            action.kind === "compaction" &&
            action.effect.value !== null &&
            typeof action.effect.value === "object" &&
            !Array.isArray(action.effect.value) &&
            action.effect.value.phase === "result",
        )
        .at(-1);
      expect(compaction).toBeDefined();
      expect(
        wake.actions.find((action) => action.ordinal === (compaction?.ordinal ?? 0) + 1)?.kind,
      ).toBe("fold.checkpoint");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  6 * childDeadlineMs + 30_000,
);

for (const field of ["state", "stateHash", "foldVersion", "revision"] as const) {
  test(
    `fresh-process refuses tampered checkpoint ${field} before writes`,
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "fold-tamper-"));
      try {
        const dbPath = join(directory, "kernel.sqlite");
        const written = await child("write", dbPath, witnessSchema);
        expect(written.code).toBe(0);
        const cut = written.value;
        if (cut.checkpoint === undefined) throw new Error("missing checkpoint");
        const db = new Database(dbPath);
        try {
          const value = {
            state: "invalid-seed",
            stateHash: "sha256:tampered",
            foldVersion: 2,
            revision: -1,
          }[field];
          db.query(
            `UPDATE action SET effect = json_set(effect, '$.result.${field}', ?) WHERE id = ?`,
          ).run(value, cut.checkpoint.id);
        } finally {
          db.close();
        }
        const refused = await child("wake", dbPath, refusalSchema);
        expect(refused.code).toBe(1);
        expect(refused.value).toMatchObject({
          name: "FoldCheckpointIntegrityError",
          data: {
            code: "fold_checkpoint_integrity",
            reason: {
              state: "seed",
              stateHash: "stateHash",
              foldVersion: "version",
              revision: "revision",
            }[field],
            checkpointId: cut.checkpoint.id,
            sessionId: reconstructionSession,
          },
        });
        await isolatedRun(
          (ledger) => {
            expect(ledger.kernel.row(reconstructionSession).revision).toBe(cut.revision);
          },
          () => openCrashStores(dbPath),
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    2 * childDeadlineMs + 30_000,
  );
}

test("in-process reconstruction uses capped suffix reads and rejects a stale seed hash on a committed row", () => {
  const directory = mkdtempSync(join(tmpdir(), "fold-in-process-"));
  const dbPath = join(directory, "kernel.sqlite");
  // One outer isolation over the file-backed stores; the in-process mains
  // reuse it via activeIsolation() so isolations never nest.
  return isolatedRun(
    async (isolation) => {
      {
        const written = await reconstructionMain("write", dbPath);
        expect(written.digest).toBe(written.oracle);
        expect(await reconstructionMain("read", dbPath)).toEqual(written);
        type Emitted = Parameters<Parameters<typeof reconstructionProcessMain>[1]>[0];
        const emitted: Emitted[] = [];
        const exited: number[] = [];
        const emit = (value: Emitted) => {
          emitted.push(value);
        };
        const exit = (code: number) => {
          exited.push(code);
        };
        await reconstructionProcessMain(["read", dbPath], emit, exit);
        expect(witnessSchema.parse(emitted.pop()).digest).toBe(written.digest);
        await reconstructionProcessMain(["wake", dbPath], emit, exit);
        expect(witnessSchema.parse(emitted.pop()).capture).toMatchObject({
          toolsGeneration: 1,
          recoveryUnchanged: true,
        });
        expect(exited).toEqual([0, 0]);
        await expect(reconstructionProcessMain([], emit, exit)).rejects.toThrow(z.ZodError);
        await expect(
          reconstructionProcessMain(["read", `${dbPath}.other`], emit, exit),
        ).rejects.toThrow("reconstruction main dbPath mismatch");
        const adapter = isolation.session.actions;
        const range = adapter.range.bind(adapter);
        const limits: number[] = [];
        adapter.range = (id, cursor, limit) => {
          limits.push(limit);
          return range(id, cursor, limit);
        };
        const hydrated = hydrateSessionHistory(isolation.kernel, reconstructionSession);
        const oracle = foldHistoryState(
          reconstructionSession,
          sessionTree(isolation.kernel, reconstructionSession),
        );
        expect(canonicalDigest(PlainValueSchema.parse(hydrated.state))).toBe(
          canonicalDigest(PlainValueSchema.parse(oracle)),
        );
        expect(limits.length).toBeGreaterThan(0);
        expect(limits.every((limit) => limit > 0 && limit <= 256)).toBe(true);
        const checkpoint = written.checkpoint;
        if (checkpoint === undefined) throw new Error("missing checkpoint");
        const revision = isolation.kernel.row(reconstructionSession).revision;
        const effect = FoldCheckpoint.Effect.parse(checkpoint.effect.value);
        const corrupted = adapter.append(
          {
            id: "valid-chain-stale-seed",
            parentId: checkpoint.id,
            sessionId: reconstructionSession,
            kind: "fold.checkpoint",
            ts: 100,
            irreversible: true,
            intent: {
              encodingVersion: 1,
              value: { phase: "checkpoint", revision, foldVersion: 1, reason: "interval" },
            },
            effect: {
              encodingVersion: 1,
              value: PlainValueSchema.parse({
                ...effect,
                result: {
                  ...effect.result,
                  revision,
                  state: {
                    ...effect.result.state,
                    canonicalTurn: !effect.result.state.canonicalTurn,
                  },
                },
              }),
            },
          },
          revision,
        );
        expect(corrupted).toBeDefined();
        const before = sessionTree(isolation.kernel, reconstructionSession);
        expect(() => hydrateSessionHistory(isolation.kernel, reconstructionSession)).toThrow(FoldCheckpointIntegrityError);
        expect(sessionTree(isolation.kernel, reconstructionSession)).toEqual(before);
        await reconstructionProcessMain(["wake", dbPath], emit, exit);
        expect(emitted.pop()).toMatchObject({
          name: "FoldCheckpointIntegrityError",
          data: { reason: "stateHash" },
        });
        expect(exited).toEqual([0, 0, 1]);
      }
    },
    () => openCrashStores(dbPath),
  ).finally(() => rmSync(directory, { recursive: true, force: true }));
});
