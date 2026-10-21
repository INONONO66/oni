import { sessionTree } from "../helpers/session-tree";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { LedgerSession } from "@oni/protocol";
import { z } from "zod";
import { SessionSqlRow } from "../../../src/core/store/storage/sqlite-l0-rows";
import { materializeSession } from "../helpers/session";
import { useSqliteStores } from "../helpers/storage";

const stores = useSqliteStores("read-validation");
let raw: Database;
beforeEach(() => {
  raw = new Database(stores.sessionPath);
  // Model damaged persisted bytes, bypassing write-time CHECKs on this fault connection only.
  raw.exec("PRAGMA ignore_check_constraints = ON");
  materializeSession(stores.kernel, "corrupt");
});
afterEach(() => {
  raw.close();
});

describe("canonical SQLite reads fail closed", () => {
  test.each([
    "{",
    "undefined",
    "",
  ])("corrupt action payload %s rejects tree and snapshot reads", (payload) => {
    raw.query("UPDATE action SET effect = ? WHERE id = ?").run(payload, "corrupt:configure");
    const malformed = expect.objectContaining({ _tag: "SchemaRefused", reason: "json" });
    expect(() => sessionTree("corrupt", stores.session.actions)).toThrow(malformed);
    expect(() => stores.kernel.getSnapshot("corrupt")).toThrow(malformed);
  });

  test.each([
    -1,
    "not-a-number",
  ])("invalid canonical session counter %s rejects get and list reads", (value) => {
    raw.query("UPDATE session SET tools_generation = ? WHERE id = ?").run(value, "corrupt");
    expect(() => stores.kernel.row("corrupt")).toThrow(z.ZodError);
    expect(() => stores.kernel.listRows()).toThrow(z.ZodError);
  });

  test("session reads validate the canonical row exactly once per returned record", () => {
    const parse = spyOn(LedgerSession.Row, "parse");
    const sqlParse = spyOn(SessionSqlRow._zod, "run");
    try {
      expect(stores.kernel.row("corrupt").id).toBe("corrupt");
      expect(parse).toHaveBeenCalledTimes(1);
      parse.mockClear();
      expect(stores.kernel.listRows().map((row) => row.id)).toEqual(["corrupt"]);
      expect(parse).toHaveBeenCalledTimes(1);
      expect(sqlParse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
      sqlParse.mockRestore();
    }
  });
});
