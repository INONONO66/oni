import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as protocol from "../../packages/protocol/src/index";
import { authorityViolations, scanRequestAuthority } from "../request-authority-census";

const root = join(import.meta.dir, "../..");
const retiredStore = ["Wait", "Store"].join("");
const retiredApproval = ["Approval", "SubAdapter"].join("");
const waitTable = "wait";
const approvalTable = "approval";

describe("original-action authority census", () => {
  test("production, fixtures, and public schema contain no independent legacy authority", async () => {
    const result = await scanRequestAuthority(root);
    for (const band of ["production", "fixtures", "schema"] as const) {
      expect(result.scanned[band], `empty ${band} census`).toBeGreaterThan(0);
    }
    expect(result.violations).toEqual([]);
  }, 15_000);

  test.each([
    "apps/probe/src/authority.ts",
    "packages/probe/test/helpers/authority.ts",
    "packages/probe/src/__tests__/authority.test.ts",
    "script/fixtures/authority.ts",
    "packages/protocol/src/storage/authority.ts",
  ])("rejects an independent authority mutant at %s", (path) => {
    expect(
      authorityViolations(path, `import { ${retiredStore} as store } from "@openomni/agent";`),
    ).toContainEqual(expect.objectContaining({ rule: "legacy-api", path }));
  });

  test("former archival exception paths retain no SQL or API allowance", () => {
    // W5.2 deleted the migration/archive plane; the operation-scoped
    // exceptions left with it, so old writers are refused on any path.
    const path = "packages/agent/test/store/storage/projection.test.ts";
    const source = `db.exec("UPDATE ${waitTable} SET status = 'open'");`;
    expect(authorityViolations(path, source)).toContainEqual(
      expect.objectContaining({ rule: "legacy-sql", path }),
    );
    expect(authorityViolations(path, `export interface ${retiredApproval} {}`)).toContainEqual(
      expect.objectContaining({ rule: "legacy-api" }),
    );
    expect(
      authorityViolations(
        "packages/agent/src/store/storage/preflight.ts",
        `db.exec("DELETE FROM ${waitTable}")`,
      ),
    ).toContainEqual(expect.objectContaining({ rule: "legacy-sql" }));
  });

  test.each([
    `db.exec(\`UPDATE\n"main"."${waitTable}" SET status = 'open'\`)`,
    `db.exec("INSERT INTO [${approvalTable}] (id) VALUES (?)")`,
    `db.exec("DELETE FROM \`${waitTable}\`")`,
    `db.exec("SELECT * FROM ${approvalTable}")`,
  ])("rejects legacy SQL without any archive allowance: %s", (source) => {
    expect(authorityViolations("packages/probe/test/fixture.ts", source)).toContainEqual(
      expect.objectContaining({ rule: "legacy-sql" }),
    );
  });

  test("public snapshots and serialized correlation names cannot retain retired vocabulary", () => {
    expect(
      authorityViolations(
        "script/conformance/schema-snapshot.json",
        JSON.stringify({
          [["Wait", "Record"].join(".")]: [["wait", "Id"].join("")],
        }),
      ),
    ).toContainEqual(expect.objectContaining({ rule: "legacy-api" }));
  });

  test("the actual public barrel has no independent authority or cross-session delivery commit", () => {
    const exports = Object.keys(protocol);
    for (const domain of ["Wait", "Approval"]) expect(exports).not.toContain(domain);
    expect(Object.keys(protocol.LedgerSession.Commit.shape)).not.toContain("deliveries");
    expect(Object.keys(protocol.SessionTransition.Request.shape)).toContain("requestId");
  });

  test("frozen archive identifiers cannot be reintroduced anywhere", () => {
    const frozen = ["Historical", "Wait"].join("");
    const source = `export type Alias = ${frozen};`;
    for (const path of [
      "packages/protocol/src/index.ts",
      "packages/agent/src/store/storage/request-format.ts",
    ]) {
      expect(authorityViolations(path, source)).toContainEqual(
        expect.objectContaining({ rule: "archive-boundary", path, match: frozen }),
      );
    }
  });

  test("the real git census sees untracked fixtures and rejects a reintroduced writer", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "request-census-"));
    try {
      const init = Bun.spawn(["git", "init", "--quiet", fixture], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await init.exited).toBe(0);
      const path = "packages/probe/test/helpers/authority.ts";
      await mkdir(join(fixture, "packages/probe/test/helpers"), { recursive: true });
      await writeFile(join(fixture, path), `export const store = ${retiredStore}.create();`);
      const retiredPath = `packages/protocol/src/${waitTable}/index.ts`;
      await mkdir(join(fixture, "packages/protocol/src", waitTable), { recursive: true });
      await writeFile(join(fixture, retiredPath), "");
      const result = await scanRequestAuthority(fixture);
      expect(result.violations).toContainEqual(
        expect.objectContaining({ path, rule: "legacy-api" }),
      );
      expect(result.violations).toContainEqual(
        expect.objectContaining({ path: retiredPath, rule: "legacy-path" }),
      );
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
