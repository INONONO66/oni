import { describe, expect, it } from "bun:test";
import { CORE_POINT_RECORDS } from "@oni/protocol";
import { compileGateRows } from "../src/core/gate/compose";
import {
  composePointTable,
  GateComposeError,
  KERNEL_CAPABILITY_POINTS,
} from "../src/core/gate/points";
import { fullPointTable, gateRow } from "./helpers/gate-rows";

function rejectionCode(run: () => void): string {
  try {
    run();
  } catch (error) {
    if (GateComposeError.isInstance(error)) return error.data.code;
    throw error;
  }
  throw new Error("expected a compose rejection");
}

describe("point registration table (#1251)", () => {
  it("merges eight core points with the composed capabilities' points", () => {
    const table = fullPointTable();
    expect(table.size).toBe(14);
    expect(table.get("tool.pre")?.owner).toBe("tool");
    expect(table.get("turn.post")?.end).toBe(true);
  });

  it("rejects a duplicate capability point registration with `duplicate`", () => {
    expect(
      rejectionCode(() =>
        composePointTable({
          capabilities: [
            { bundle: "tool", points: ["tool.pre"] },
            { bundle: "shadow-tool", points: ["tool.pre"] },
          ],
        }),
      ),
    ).toBe("duplicate");
  });

  it("rejects a repeated core point registration with `duplicate` (#1251 r1)", () => {
    expect(
      rejectionCode(() =>
        composePointTable({
          core: [...CORE_POINT_RECORDS, ...CORE_POINT_RECORDS.slice(0, 1)],
          capabilities: [],
        }),
      ),
    ).toBe("duplicate");
  });

  it("rejects a registration without a point record with `unknown_point`", () => {
    expect(
      rejectionCode(() =>
        composePointTable({
          capabilities: [{ bundle: "tool", points: ["ingress.pre"] }],
        }),
      ),
    ).toBe("unknown_point");
  });
});

describe("gate-row compose rejections (#1251)", () => {
  const table = fullPointTable();
  const compile = (rows: readonly ReturnType<typeof gateRow>[], handlers: readonly string[] = []) =>
    compileGateRows({ table, rows, handlers, generation: 1 });

  it("rejects a row on an off or absent capability's point with `unknown_point`, never a silent no-op", () => {
    const withoutAction = composePointTable({
      capabilities: KERNEL_CAPABILITY_POINTS.filter((capability) => capability.bundle !== "action"),
    });
    expect(withoutAction.has("action.pre")).toBe(false);
    expect(
      rejectionCode(() =>
        compileGateRows({
          table: withoutAction,
          rows: [gateRow("action.pre")],
          handlers: [],
          generation: 1,
        }),
      ),
    ).toBe("unknown_point");
  });

  it("rejects an unregistered `how.ref` with `unknown_handler`", () => {
    expect(
      rejectionCode(() => compile([gateRow("tool.pre", { how: { ref: "guard/absent" } })])),
    ).toBe("unknown_handler");
    expect(
      compile([gateRow("tool.pre", { how: { ref: "guard/present" } })], ["guard/present"]),
    ).toMatchObject({ generation: 1 });
  });

  it("rejects a duplicate row id with `duplicate`", () => {
    const row = gateRow("tool.pre");
    expect(rejectionCode(() => compile([row, { ...row, order: row.order + 1 }]))).toBe("duplicate");
  });

  it("rejects an action outside the point record with `bad_action`", () => {
    expect(rejectionCode(() => compile([gateRow("compaction.post")]))).toBe("bad_action");
    expect(rejectionCode(() => compile([gateRow("alarm.fired")]))).toBe("bad_action");
  });

  it("rejects condition and rewrite fields outside the point record with `bad_field`", () => {
    expect(rejectionCode(() => compile([gateRow("tool.pre", { when: { model: "x" } })]))).toBe(
      "bad_field",
    );
    expect(
      rejectionCode(() =>
        compile(
          [gateRow("compaction.pre", { do: "rewrite", how: { ref: "guard/rewrite", fields: ["output"] } })],
          ["guard/rewrite"],
        ),
      ),
    ).toBe("bad_field");
  });

  it("rejects an observe row carrying a verdict, obligation, or rewrite fields with `bad_action` (#1251 r2)", () => {
    expect(
      rejectionCode(() =>
        compile([gateRow("tool.pre", { do: "observe", how: { ref: "audit/log", verdict: "deny" } })], ["audit/log"]),
      ),
    ).toBe("bad_action");
    expect(
      rejectionCode(() =>
        compile(
          [gateRow("tool.pre", { do: "observe", how: { ref: "audit/log", metric: "calls", limit: 1 } })],
          ["audit/log"],
        ),
      ),
    ).toBe("bad_action");
    expect(
      rejectionCode(() =>
        compile(
          [gateRow("tool.pre", { do: "observe", how: { ref: "audit/log", fields: ["input"] } })],
          ["audit/log"],
        ),
      ),
    ).toBe("bad_action");
  });

  it("rejects a consulted gate carrying a constant verdict with `bad_action`: the constant would silently bypass the declared guard (#1251 r5)", () => {
    for (const verdict of ["allow", "deny", "require_approval"] as const) {
      expect(
        rejectionCode(() =>
          compile([gateRow("tool.pre", { how: { ref: "guard/check", verdict } })], ["guard/check"]),
        ),
      ).toBe("bad_action");
    }
  });

  it("admits exactly the three gate execution modes: constant, consulted, obligation (#1251 r5)", () => {
    const denied = gateRow("tool.pre", { how: { verdict: "deny" } });
    expect(compile([denied]).rowsAt("tool.pre")).toEqual([denied]);
    expect(
      compile([gateRow("tool.pre", { how: { ref: "guard/check" } })], ["guard/check"]),
    ).toMatchObject({ generation: 1 });
    // The historical obligation projection: metric/limit under the projection-fixed
    // allow, with an optional obligation-handler ref - never a consulted gate.
    expect(
      compile(
        [
          gateRow("turn.post", {
            how: { verdict: "allow", ref: "kernel/budget-clamp", metric: "fanout", limit: 8 },
          }),
        ],
        ["kernel/budget-clamp"],
      ),
    ).toMatchObject({ generation: 1 });
    expect(
      compile([gateRow("turn.post", { how: { verdict: "allow", metric: "fanout", limit: 8 } })]),
    ).toMatchObject({ generation: 1 });
    expect(
      rejectionCode(() =>
        compile([gateRow("turn.post", { how: { verdict: "deny", metric: "fanout", limit: 8 } })]),
      ),
    ).toBe("bad_action");
    expect(rejectionCode(() => compile([gateRow("tool.pre", { how: {} })]))).toBe("bad_action");
  });

  it("rejects a rewrite or emit row carrying a foreign execution mode with `bad_action` (#1251 r5)", () => {
    expect(
      rejectionCode(() =>
        compile(
          [
            gateRow("llm.pre", {
              do: "rewrite",
              how: { ref: "rewrite/model", fields: ["model"], verdict: "allow" },
            }),
          ],
          ["rewrite/model"],
        ),
      ),
    ).toBe("bad_action");
    expect(
      rejectionCode(() =>
        compile(
          [gateRow("tool.post", { do: "emit", how: { emit: "message", verdict: "deny" } })],
        ),
      ),
    ).toBe("bad_action");
    expect(
      rejectionCode(() =>
        compile(
          [gateRow("tool.post", { do: "emit", how: { emit: "message", ref: "guard/check" } })],
          ["guard/check"],
        ),
      ),
    ).toBe("bad_action");
  });

  it("rejects a declared requires entry without a registered handler with `unknown_handler`", () => {
    expect(
      rejectionCode(() =>
        compile(
          [gateRow("tool.pre", { how: { ref: "guard/main", requires: ["guard/helper"] } })],
          ["guard/main"],
        ),
      ),
    ).toBe("unknown_handler");
  });

  it("rejects a post-end emit with `post_end_emit`", () => {
    expect(
      rejectionCode(() => compile([gateRow("turn.post", { do: "emit", how: { emit: "message" } })])),
    ).toBe("post_end_emit");
  });

  it("rejects prompt and signal emissions: the emit set is message | alarm | compaction only", () => {
    for (const emit of ["prompt", "signal"]) {
      expect(
        rejectionCode(() => compile([gateRow("tool.post", { do: "emit", how: { emit } })])),
      ).toBe("bad_action");
    }
    for (const emit of ["message", "alarm", "compaction"]) {
      const row = gateRow("tool.post", { do: "emit", how: { emit, intent: { body: "x" } } });
      expect(compile([row]).rowsAt("tool.post")).toEqual([row]);
    }
  });
});
