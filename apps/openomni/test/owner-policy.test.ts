import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppInvariantError } from "../src/invariant";
import {
  SHIPPED_OWNER_POLICY,
  compileOwnerPolicy,
  readOwnerPolicy,
} from "../src/composition/policy";

const approval = {
  responders: ["owner"],
  recentOpen: { limit: 8, windowMs: 3_600_000 },
  defaultExpiryMs: 86_400_000,
  defaultBudget: {
    maxTurns: 24,
    maxToolCalls: 40,
    maxWallTimeMs: 300_000,
    maxToolRuntimeMs: 120_000,
  },
};

function policyRow(overrides: Record<string, object | string | number | undefined>) {
  return {
    id: "probe/tool.pre#1",
    point: "tool.pre",
    order: 1,
    when: {},
    verdict: { type: "allow" },
    ...overrides,
  };
}

function refusal(run: () => object): AppInvariantError {
  try {
    run();
  } catch (error) {
    if (error instanceof AppInvariantError) return error;
    throw error;
  }
  throw new Error("expected AppInvariantError");
}

test("the shipped JSON preserves the pre-R3 app-owned policy row id and point set", () => {
  const expected: readonly (readonly [string, string])[] = [
    ["delegation-policy/tool.pre#1", "tool.pre"],
    ["delegation-policy/tool.pre#2", "tool.pre"],
    ["delegation-policy/tool.pre#3", "tool.pre"],
    ["message.child.actor", "message.pre"],
    ["message.child.actor_interrupt", "message.pre"],
    ["message.child.allocate", "message.pre"],
    ["message.child.deadline", "message.pre"],
    ["message.child.depth", "message.pre"],
    ["message.child.fanout", "message.pre"],
    ["message.child.interrupt_parent", "message.pre"],
    ["message.child.parent", "message.pre"],
    ["message.external.egress_budget", "message.pre"],
    ["message.external.event_id_dedupe", "message.pre"],
    ["message.external.grant_tier", "message.pre"],
    ["message.external.identity", "message.pre"],
    ["message.external.reply_correlation", "message.pre"],
    ["message.resident.actor_grant", "message.pre"],
    ["message.resident.actor_interrupt", "message.pre"],
    ["message.resident.deadline", "message.pre"],
    ["message.resident.depth", "message.pre"],
    ["message.resident.fanout", "message.pre"],
    ["message.resident.parent", "message.pre"],
    ["provision-automation-add-consent", "tool.pre"],
    ["provision-automation-enable-consent", "tool.pre"],
    ["provision-bundle-disable-consent", "tool.pre"],
    ["provision-bundle-enable-consent", "tool.pre"],
    ["provision-contact-merge-consent", "tool.pre"],
    ["provision-contact-promote-consent", "tool.pre"],
  ];
  expect([...SHIPPED_OWNER_POLICY.rowSet].sort((left, right) => left.id.localeCompare(right.id))).toEqual(
    expected.map(([id, point]) => ({ id, point })),
  );
});

test("unknown points and handler names refuse with typed codes", () => {
  const point = refusal(() =>
    compileOwnerPolicy(
      { approval, rows: [policyRow({ point: "ghost.pre" })] },
      "unknown-point.json",
    ),
  );
  expect([point.name, point.code, point.message]).toEqual([
    "AppInvariantError",
    "unknown_point",
    expect.stringContaining("ghost.pre"),
  ]);

  const handler = refusal(() =>
    compileOwnerPolicy(
      {
        approval,
        rows: [
          policyRow({
            verdict: undefined,
            handler: "missing/guard",
          }),
        ],
      },
      "unknown-handler.json",
    ),
  );
  expect([handler.name, handler.code, handler.message]).toEqual([
    "AppInvariantError",
    "unknown_handler",
    expect.stringContaining("missing/guard"),
  ]);
});

test("registered guards and transformers compile only their declared shapes", () => {
  const compiled = compileOwnerPolicy(
    {
      approval,
      rows: [
        policyRow({
          id: "probe/prompt.pre#1",
          point: "prompt.pre",
          verdict: undefined,
          handler: "hooks-json/secrets-guard",
          fields: ["body"],
          params: { replacement: "[masked]" },
        }),
        policyRow({
          id: "probe/tool.pre#2",
          verdict: undefined,
          handler: "delegation-policy/spend-cap",
        }),
      ],
    },
    "handlers.json",
  );
  expect(compiled.delegationRows).toEqual([
    {
      id: "probe/prompt.pre#1",
      on: "prompt.pre",
      when: {},
      do: "rewrite",
      how: {
        ref: "hooks-json/secrets-guard",
        fields: ["body"],
        params: { replacement: "[masked]" },
      },
      order: 1,
    },
    {
      id: "probe/tool.pre#2",
      on: "tool.pre",
      when: {},
      do: "gate",
      how: { ref: "delegation-policy/spend-cap" },
      order: 1,
    },
  ]);

  expect(
    refusal(() =>
      compileOwnerPolicy(
        {
          approval,
          rows: [
            policyRow({
              verdict: undefined,
              handler: "hooks-json/secrets-guard",
            }),
          ],
        },
        "missing-fields.json",
      ),
    ).code,
  ).toBe("invalid_policy_file");
  expect(
    refusal(() =>
      compileOwnerPolicy(
        {
          approval,
          rows: [
            policyRow({
              verdict: undefined,
              handler: "delegation-policy/spend-cap",
              fields: ["body"],
            }),
          ],
        },
        "guard-fields.json",
      ),
    ).code,
  ).toBe("invalid_policy_file");
});

test("invalid row semantics refuse rather than partially compiling", () => {
  for (const rows of [
    [
      policyRow({
        id: "probe/message.pre#1",
        point: "message.pre",
        when: {},
      }),
    ],
    [
      policyRow({
        id: "probe/tool.pre#1",
        verdict: undefined,
        handler: "delegation-policy/spawn-depth",
        params: { limit: 2 },
      }),
    ],
    [
      policyRow({ id: "duplicate/tool.pre#1" }),
      policyRow({ id: "duplicate/tool.pre#1" }),
    ],
    [policyRow({ point: "action.pre" })],
  ]) {
    expect(
      refusal(() => compileOwnerPolicy({ approval, rows }, "invalid-semantics.json")).code,
    ).toBe(rows[0]?.point === "action.pre" ? "unknown_point" : "invalid_policy_file");
  }
  expect(
    refusal(() => compileOwnerPolicy({ approval, rows: "not-an-array" }, "shape.json")).code,
  ).toBe("invalid_policy_file");
});

test("unreadable and malformed policy files refuse before compilation", () => {
  const directory = mkdtempSync(join(tmpdir(), "owner-policy-"));
  try {
    expect(refusal(() => readOwnerPolicy(join(directory, "missing.json"))).code).toBe(
      "unreadable_path",
    );
    const malformed = join(directory, "malformed.json");
    writeFileSync(malformed, "{");
    expect(refusal(() => readOwnerPolicy(malformed)).code).toBe("invalid_policy_file");
    const valid = join(directory, "valid.json");
    writeFileSync(valid, JSON.stringify({ approval, rows: [policyRow({})] }));
    expect(readOwnerPolicy(valid).rows).toHaveLength(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
