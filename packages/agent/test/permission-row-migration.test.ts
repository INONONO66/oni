import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertPointGenerationRows,
  pointOfRow,
  POINT_GENERATION_ROW,
  translateLegacyPolicyRow,
} from "../src/core/gate/migrate";
import { compilePolicySnapshot, KERNEL_POLICY_REGISTRY } from "../src/core/gate/compile";
import { GateComposeError } from "../src/core/gate/points";
import { openCatalogStore } from "../src/core/store/catalog";
import { atGeneration, compaction, draft } from "./kernel/gate/row-fixtures";
import { fullPointTable } from "./helpers/gate-rows";

const table = fullPointTable();

const LEGACY_ROWS = [
  draft("compaction-arm", "compaction", "pre", { type: "allow", reasonCodes: [] }),
  draft("compaction-close", "compaction", "post", { type: "allow", reasonCodes: [] }),
  draft("ingress-screen", "ingress", "pre", { type: "deny", reasonCodes: ["screen"] }),
  draft("alarm-route", "alarm.fired", "post", { type: "allow", reasonCodes: [] }),
  draft("tool-budget", "tool", "pre", { type: "require_approval", reasonCodes: ["budget"] }),
];

function withCatalog<A>(run: (open: () => ReturnType<typeof openCatalogStore>) => A): A {
  const directory = mkdtempSync(join(tmpdir(), "point-migration-"));
  const path = join(directory, "catalog.sqlite");
  const opened: ReturnType<typeof openCatalogStore>[] = [];
  try {
    return run(() => {
      const catalog = openCatalogStore(path, { now: () => 1_700_000_000_000 });
      opened.push(catalog);
      return catalog;
    });
  } finally {
    for (const catalog of opened) catalog.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The generation-1 kernel snapshot over `rows` with compaction mandatory, as a pinned restore compiles it. */
const pinnedSnapshot = (...rows: Parameters<typeof atGeneration>[0][]) =>
  compilePolicySnapshot({
    registry: KERNEL_POLICY_REGISTRY,
    generation: 1,
    rows: rows.map((row) => atGeneration(row, 1)),
    mandatory: ["compaction"],
  });

describe("permission-row migration (#1251)", () => {
  it("maps every historical kind/phase pair the kernel ever wrote to a registered point", () => {
    expect(() => assertPointGenerationRows(LEGACY_ROWS, table)).not.toThrow();
    expect(pointOfRow("compaction", "post")).toBe("compaction.post");
    expect(pointOfRow("ingress", "pre")).toBe("ingress.pre");
    expect(pointOfRow("alarm.fired", "post")).toBe("alarm.fired");
  });

  it("rejects an unmappable historical row with `unknown_point`", () => {
    const row = draft("checkpoint", "fold.checkpoint", "pre", { type: "allow", reasonCodes: [] });
    try {
      assertPointGenerationRows([row], table);
      throw new Error("expected unknown_point");
    } catch (error) {
      if (!GateComposeError.isInstance(error)) throw error;
      expect(error.data).toEqual({ code: "unknown_point", point: "fold.checkpoint.pre" });
    }
  });

  it("a base-era turn/post compaction deny keeps refusing summarization after conversion (#1251 r1)", () => {
    const deny = draft(
      "no-summaries",
      "turn",
      "post",
      { type: "deny", reason: "no summaries" },
      { match: { op: "compaction" }, priority: 2_000 },
    );
    const converted = translateLegacyPolicyRow(deny);
    expect(converted).toMatchObject({ kind: "compaction", phase: "pre" });
    expect(converted.match.value).toEqual({ op: "compact" });

    // Even an untouched historical generation translates at compile: the
    // pinned snapshot keeps the base-era refusal on the compaction point.
    const snapshot = pinnedSnapshot(compaction, deny);
    expect(snapshot.evaluate({ kind: "compaction", phase: "pre", op: "compact", value: {} }).verdict).toBe("deny");
    // The turn envelope itself is no longer governed by the converted row.
    expect(snapshot.evaluate({ kind: "turn", phase: "post", op: "finish", value: {} }).verdict).toBe("allow");
  });

  it("a base-era turn/post restore deny keeps refusing restores with its real operation (#1251 r2)", () => {
    const deny = draft(
      "no-restore",
      "turn",
      "post",
      { type: "deny", reason: "pinned_projection" },
      { match: { op: "restore_context_projection" }, priority: 500 },
    );
    const converted = translateLegacyPolicyRow(deny);
    expect(converted).toMatchObject({ kind: "compaction", phase: "pre" });
    expect(converted.match.value).toEqual({ op: "restore_context_projection" });

    const snapshot = pinnedSnapshot(compaction, deny);
    expect(
      snapshot.evaluate({ kind: "compaction", phase: "pre", op: "restore_context_projection", value: {} }),
    ).toMatchObject({ verdict: "deny", reason: "pinned_projection" });
    // The restore-specific restriction never spills onto ordinary summarization.
    expect(snapshot.evaluate({ kind: "compaction", phase: "pre", op: "compact", value: {} }).verdict).toBe("allow");
  });

  it("a wildcard turn/post row still governs compaction operations as the old mapping consulted it (#1251 r2)", () => {
    const freeze = draft("frozen", "turn", "post", { type: "deny", reason: "frozen" }, { priority: 2_000 });
    expect(translateLegacyPolicyRow(freeze)).toEqual(freeze);

    const snapshot = pinnedSnapshot(compaction, freeze);
    for (const op of ["compact", "restore_context_projection"]) {
      expect(snapshot.evaluate({ kind: "compaction", phase: "pre", op, value: {} })).toMatchObject({
        verdict: "deny",
        reason: "frozen",
      });
    }
    expect(snapshot.evaluate({ kind: "turn", phase: "post", op: "finish", value: {} }).verdict).toBe("deny");
  });

  it("converts the latest generation once, preserving historical generations byte-for-byte", () => {
    withCatalog((open) => {
      const catalog = open();
      for (const row of LEGACY_ROWS) catalog.policies.append({ ...row, generation: 1 });
      const historical = JSON.stringify(catalog.policies.rows(1));

      const generation = catalog.policies.appendGeneration((current) => {
        const drafts = current.map(({ generation: _generation, ...rest }) => rest);
        assertPointGenerationRows(drafts, table);
        return [...drafts, POINT_GENERATION_ROW];
      });
      expect(generation).toBe(2);
      catalog.close();

      const reopened = open();
      expect(JSON.stringify(reopened.policies.rows(1))).toBe(historical);
      const converted = reopened.policies.rows(2);
      expect(converted).toHaveLength(LEGACY_ROWS.length + 1);
      expect(converted.some((row) => row.name === POINT_GENERATION_ROW.name)).toBe(true);
    });
  });

  it("rejects the whole conversion when the latest generation has an unmappable row", () => {
    withCatalog((open) => {
      const catalog = open();
      catalog.policies.append({
        ...draft("checkpoint", "fold.checkpoint", "pre", { type: "allow", reasonCodes: [] }),
        generation: 1,
      });
      const before = JSON.stringify(catalog.policies.rows());
      expect(() =>
        catalog.policies.appendGeneration((current) => {
          const drafts = current.map(({ generation: _generation, ...rest }) => rest);
          assertPointGenerationRows(drafts, table);
          return [...drafts, POINT_GENERATION_ROW];
        }),
      ).toThrow(GateComposeError);
      catalog.close();

      const reopened = open();
      expect(JSON.stringify(reopened.policies.rows())).toBe(before);
    });
  });
});
