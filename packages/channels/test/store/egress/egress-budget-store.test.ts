import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEgressBudgetStore } from "../../../src/index.js";
import { openTestChannelStore, useMemoryChannelStore } from "../helpers/sqlite";
import type { Gateway } from "@oni/protocol";

/** #219 active-egress debit ledger: atomic, idempotent counted-window claims. */
describe("EgressBudgetStore", () => {
  const NOW = 5_000_000_000_000;
  const WINDOW = 60_000;

  const row = (
    id: string,
    overrides: Partial<Gateway.EgressDebitRow> = {},
  ): Gateway.EgressDebitRow => ({
    id,
    senderId: "s",
    targetActorId: "t",
    class: "notify" as const,
    at: NOW,
    ...overrides,
  });

  const stores = useMemoryChannelStore();
  const budget = () => createEgressBudgetStore(stores.store);

  test("an empty ledger presents a zero state to the first claim", () => {
    let observed: Gateway.EgressDebitState | undefined;
    const result = budget().claim(row("first"), NOW - WINDOW, (state) => {
      observed = state;
      return "allow";
    });
    expect(result).toEqual({ kind: "claimed" });
    expect(observed).toEqual({ countInWindow: 0, notifyInWindow: 0, converseInWindow: 0 });
  });

  test("claims fold per-class window counts and a window-independent lastSendAt", () => {
    budget().claim(row("d1", { at: NOW - 90_000 }), NOW - WINDOW, () => "allow");
    budget().claim(row("d2", { at: NOW - 10_000 }), NOW - WINDOW, () => "allow");
    budget().claim(row("d3", { class: "converse", at: NOW - 5_000 }), NOW - WINDOW, () => "allow");

    let observed: Gateway.EgressDebitState | undefined;
    const probe = budget().claim(row("probe"), NOW - WINDOW, (state) => {
      observed = state;
      return "inspect" as const;
    });
    expect(probe).toEqual({ kind: "refused", reason: "inspect" });
    expect(observed).toEqual({
      countInWindow: 2,
      notifyInWindow: 1,
      converseInWindow: 1,
      lastSendAt: NOW - 5_000,
    });
  });

  test("claims are isolated per (sender, target) pair", () => {
    budget().claim(row("a", { targetActorId: "t1" }), NOW - WINDOW, () => "allow");
    budget().claim(row("b", { targetActorId: "t2" }), NOW - WINDOW, () => "allow");

    let observed: Gateway.EgressDebitState | undefined;
    budget().claim(row("probe", { targetActorId: "other" }), NOW - WINDOW, (state) => {
      observed = state;
      return "inspect" as const;
    });
    expect(observed).toEqual({ countInWindow: 0, notifyInWindow: 0, converseInWindow: 0 });
  });

  test("read-only applicability sees committed window counts without charging ingress", () => {
    expect(budget().read("s", "t", NOW - WINDOW)).toEqual({
      countInWindow: 0,
      notifyInWindow: 0,
      converseInWindow: 0,
    });
    budget().claim(row("notify"), NOW - WINDOW, () => "allow");
    budget().claim(
      row("converse", { class: "converse", at: NOW + 1 }),
      NOW - WINDOW,
      () => "allow",
    );
    const expected = {
      countInWindow: 2,
      notifyInWindow: 1,
      converseInWindow: 1,
      lastSendAt: NOW + 1,
    };
    expect(budget().read("s", "t", NOW - WINDOW)).toEqual(expected);
    expect(budget().read("s", "t", NOW - WINDOW)).toEqual(expected);
    expect(budget().read("s", "other", NOW - WINDOW)).toEqual({
      countInWindow: 0,
      notifyInWindow: 0,
      converseInWindow: 0,
    });
    expect(budget().read("s", "t", NOW + 2)).toEqual({
      countInWindow: 0,
      notifyInWindow: 0,
      converseInWindow: 0,
      lastSendAt: NOW + 1,
    });
  });

  test("two contenders for the last SQLite window slot produce exactly one claim", () => {
    const adapter = stores.store.egressBudget;

    const results = [row("race-a"), row("race-b")].map((candidate) =>
      adapter.claim(candidate, NOW - WINDOW, (state) => state.countInWindow < 1),
    );

    expect(results).toEqual(["claimed", "refused"]);
  });

  test("retrying a recorded claim is idempotent and never charges the window twice", () => {
    const adapter = stores.store.egressBudget;

    const first = row("retry-a");
    expect(adapter.claim(first, NOW - WINDOW, (state) => state.countInWindow < 1)).toBe("claimed");
    expect(adapter.claim(row("retry-b"), NOW - WINDOW, (state) => state.countInWindow < 1)).toBe(
      "refused",
    );
    // The retry short-circuits on the recorded id even under a now-full window.
    expect(adapter.claim(first, NOW - WINDOW, () => false)).toBe("claimed");
  });

  test("retrying an id with different fields is refused as a conflicting claim", () => {
    const adapter = stores.store.egressBudget;

    expect(adapter.claim(row("conflict-a"), NOW - WINDOW, () => true)).toBe("claimed");
    const conflicting = { ...row("conflict-a"), targetActorId: "act_someone_else" };
    expect(() => adapter.claim(conflicting, NOW - WINDOW, () => true)).toThrow(
      "already identifies a different claim",
    );
  });

  test("the claim holds one write transaction across read and append", () => {
    // Discriminating atomicity proof: canClaim runs between the projection
    // read and the append. While it runs, a second connection with zero busy
    // timeout must be unable to write — that is only true when the claim
    // opened BEGIN IMMEDIATE before reading. A no-op transaction wrapper
    // would leave the probe insert free to succeed and fail this test.
    const dir = mkdtempSync(join(tmpdir(), "egress-claim-"));
    const dbPath = join(dir, "claim.sqlite");
    const opened = openTestChannelStore(dbPath);
    try {
      const adapter = opened.store.egressBudget;
      const probe = new Database(dbPath);
      probe.exec("PRAGMA busy_timeout = 0");
      const insertProbeRow = () => {
        probe.exec(
          `INSERT INTO egress_debit (id, sender_id, target_actor_id, class, at, time_created)
           VALUES ('probe', 's', 't', 'notify', ${NOW}, ${NOW})`,
        );
      };

      let probedInsideClaim = false;
      const result = adapter.claim(row("lock-holder"), NOW - WINDOW, () => {
        probedInsideClaim = true;
        expect(insertProbeRow).toThrow(/SQLITE_BUSY|database is locked/);
        return true;
      });

      expect(probedInsideClaim).toBe(true);
      expect(result).toBe("claimed");
      // Once the claim committed, the same probe write is free to proceed.
      insertProbeRow();
      probe.close();
    } finally {
      opened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails closed when the sub-adapter is absent", () => {
    expect(() => createEgressBudgetStore({}).claim(row("missing"), 0, () => "allow")).toThrow(
      "does not implement egressBudget",
    );
  });
});
