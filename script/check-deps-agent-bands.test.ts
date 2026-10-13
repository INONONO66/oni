/**
 * #1276 five-band agent table: the three new edge checks and the TIGHT
 * ratchet (review r3 F1: every pin equals the file's HEAD actual count; slack
 * fails closed; the historical reconciliation against 66d56edb lives in the
 * #1276 receipt, not in a test). These cases fail against the pre-#1276
 * seven-band table: `core/` was not a band (its files escaped every rule),
 * plugins could import any core path, siblings were legal inside one
 * `plugins` band, and no rule covered `apps/`.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_PLUGINS,
  agentBandViolations,
  appsAgentInternalViolations,
  appsAgentTokenCount,
  appsSessionWriteSites,
  validateAgentBands,
  validateAppsAgentTokens,
  validateAppsSessionWrites,
} from "./check-deps";

// ─── check (a): core -> plugins/model/inspect/testing banned ───

test("#1276 check a: a core file importing plugins/ fails", () => {
  const found = agentBandViolations(
    "packages/agent/src/core/evil.ts",
    'import { restore } from "../plugins/compaction/restore";',
  );
  expect(found).toHaveLength(1);
  expect(found[0]).toContain("core/ may not import plugins/");
});

test("#1276 check a: a core file importing model/, inspect/ or testing/ fails", () => {
  const found = agentBandViolations(
    "packages/agent/src/core/evil.ts",
    [
      'import { m } from "../model/errors";',
      'import { h } from "../inspect/history";',
      'import { t } from "../testing/registry";',
    ].join("\n"),
  );
  expect(found).toHaveLength(3);
});

test("#1276 check a legal edge: core-internal imports stay legal (one core)", () => {
  expect(
    agentBandViolations(
      "packages/agent/src/core/gate/decide.ts",
      'import { x } from "../turn";\nimport { y } from "../store/fence";\nimport { z } from "./match";',
    ),
  ).toEqual([]);
});

// ─── check (b): plugin -> sibling plugin or non-api core banned ───

test("#1276 check b: a plugin importing a sibling plugin fails", () => {
  const found = agentBandViolations(
    "packages/agent/src/plugins/alarm/index.ts",
    'import { cut } from "../compaction/cut";',
  );
  expect(found).toHaveLength(1);
  expect(found[0]).toContain("plugins/alarm/ may not import its sibling plugins/compaction/");
});

test("#1276 check b: a plugin importing any core path other than core/api.ts fails", () => {
  const found = agentBandViolations(
    "packages/agent/src/plugins/compaction/evil.ts",
    'import { fence } from "../../core/store/fence";\nimport { run } from "../../core/run";',
  );
  expect(found).toHaveLength(2);
  expect(found[0]).toContain("may import only core/api.ts from the core");
});

test("#1276 check b: a plugin importing model/, inspect/ or testing/ fails", () => {
  const found = agentBandViolations(
    "packages/agent/src/plugins/compaction/successor.ts",
    'import { fold } from "../../inspect/history";\nimport { m } from "../../model/errors";\nimport { t } from "../../testing/fixtures";',
  );
  expect(found).toHaveLength(3);
  expect(found[0]).toContain("plugins/compaction/ may not import inspect/");
  expect(found[2]).toBe(
    "VIOLATION: packages/agent/src/plugins/compaction/successor.ts:3 imports ../../testing/fixtures — #1247 bands: plugins/compaction/ may not import testing/",
  );
});

test("a plugin cannot import the root bundle assembly with or without extension", () => {
  for (const spec of ["../../bundle", "../../bundle.ts"]) {
    expect(
      agentBandViolations(
        "packages/agent/src/plugins/alarm/index.ts",
        `import { compose } from "${spec}";`,
      ),
    ).toEqual([
      `VIOLATION: packages/agent/src/plugins/alarm/index.ts:1 imports ${spec} — #1247 bands: plugins/alarm/ may import only its own plugin and core/api.ts (got ${spec === "../../bundle" ? "bundle" : "bundle.ts"})`,
    ]);
  }
});

test("#1276 check b: a plugin importing the package root barrel fails (review r2 probe)", () => {
  const found = agentBandViolations(
    "packages/agent/src/plugins/alarm/review-probe.ts",
    'import { Core } from "../../index";',
  );
  expect(found).toHaveLength(1);
  expect(found[0]).toContain(
    "plugins/alarm/ may not import the package root barrel (it re-exports every band)",
  );
});

test("#1276 check b: a plugin importing a band root barrel fails", () => {
  const found = agentBandViolations(
    "packages/agent/src/plugins/alarm/review-probe.ts",
    'import { M } from "../../model";\nimport { barrel } from "../..";',
  );
  expect(found).toHaveLength(2);
  expect(found[0]).toContain("plugins/alarm/ may not import model/");
  expect(found[1]).toContain("may not import the package root barrel");
});

test("#1276 (r2): a core file importing a band root barrel fails (review r2 probe)", () => {
  const found = agentBandViolations(
    "packages/agent/src/core/review-probe.ts",
    'import { Model } from "../model";',
  );
  expect(found).toHaveLength(1);
  expect(found[0]).toBe(
    "VIOLATION: packages/agent/src/core/review-probe.ts:1 imports ../model — #1247 bands: core/ may not import model/",
  );
});

test("#1276: a core file importing the package root barrel fails; testing/ may", () => {
  const found = agentBandViolations(
    "packages/agent/src/core/review-probe.ts",
    'import { Model } from "../index";',
  );
  expect(found).toHaveLength(1);
  expect(found[0]).toContain("core/ may not import the package root barrel");
  expect(
    agentBandViolations(
      "packages/agent/src/testing/registry.ts",
      'import { Core } from "../index";',
    ),
  ).toEqual([]);
});

test("#1276: a file in a plugin directory outside the five-plugin table fails", () => {
  const found = agentBandViolations(
    "packages/agent/src/plugins/rogue/index.ts",
    'export const name = "rogue";',
  );
  expect(found).toHaveLength(1);
  expect(found[0]).toContain(`plugins/ holds exactly {${AGENT_PLUGINS.join(", ")}}`);
  expect(AGENT_PLUGINS).toEqual(["action", "alarm", "compaction", "hook", "tool"]);
});

test("#1276 check b legal edges: core/api.ts, protocol and plugin-internal imports pass", () => {
  expect(
    agentBandViolations(
      "packages/agent/src/plugins/compaction/restore.ts",
      [
        'import { Entropy } from "../../core/api";',
        'import { canonicalDigest } from "@openomni/protocol";',
        'import { geometry } from "./geometry";',
      ].join("\n"),
    ),
  ).toEqual([]);
});

// ─── check (c): apps -> agent internals banned ───

test("#1276 check c: an app file deep-importing @openomni/agent fails", () => {
  const found = appsAgentInternalViolations(
    "apps/openomni/src/runtime.ts",
    'import { runAgent } from "@openomni/agent/core/turn";',
  );
  expect(found).toHaveLength(1);
  expect(found[0]).toContain("apps import only the @openomni/agent barrel");
});

test("#1276 check c: an app file relative-importing into packages/agent/src fails", () => {
  const found = appsAgentInternalViolations(
    "apps/openomni/src/composition/model-selection.ts",
    'import { x } from "../../../../packages/agent/src/core/entity";',
  );
  expect(found).toHaveLength(1);
});

test("#1276 check c legal edges: the barrel and app-internal imports pass; non-apps files are out of scope", () => {
  expect(
    appsAgentInternalViolations(
      "apps/openomni/src/runtime.ts",
      'import { Core } from "@openomni/agent";\nimport { parentReply } from "./composition/parent-reply";',
    ),
  ).toEqual([]);
  expect(
    appsAgentInternalViolations(
      "packages/channels/src/router/index.ts",
      'import { x } from "@openomni/agent/core/turn";',
    ),
  ).toEqual([]);
});

// ─── the real scanner: regrowth in a clean file and slack both fail ───

function scratchAgentTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "bands-"));
  for (const [file, source] of Object.entries(files)) {
    const path = join(root, "packages/agent/src", file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, source);
  }
  return root;
}

test("#1276 (r3): a forbidden import in a formerly-pinned, now-clean file fails the scan", async () => {
  const root = scratchAgentTree({
    "core/store/errors.ts": 'import { name } from "../../plugins/alarm";\nexport const e = name;\n',
  });
  try {
    const violations = await validateAgentBands(root);
    expect(violations).toContain(
      "VIOLATION: packages/agent/src/core/store/errors.ts:1 imports ../../plugins/alarm — #1247 bands: core/ may not import plugins/",
    );
    expect(violations).toContain(
      "VIOLATION: packages/agent/src/core/store/errors.ts has 1 band violations over the #1276 ratchet of 0 — shrink only, never grow",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1276 (r3): a pin above the actual count fails closed", async () => {
  // core/retry.ts is pinned at 1; a scratch tree where it is clean must fail.
  const root = scratchAgentTree({
    "core/retry.ts": "export const clean = true;\n",
  });
  try {
    const violations = await validateAgentBands(root);
    expect(violations).toContain(
      "VIOLATION: packages/agent/src/core/retry.ts pin exceeds actual (1 > 0): lower the pin",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── #1343: apps-to-agent direct responsibility token ratchet ───

function scratchAppsTree(
  files: Record<string, string>,
  checkout: "none" | "dir" | "file" = "none",
): string {
  const root = mkdtempSync(join(tmpdir(), "tokens-"));
  if (checkout === "dir") mkdirSync(join(root, ".git"));
  if (checkout === "file") writeFileSync(join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
  for (const [file, source] of Object.entries(files)) {
    const path = join(root, "apps/openomni/src", file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, source);
  }
  return root;
}

test("#1343: a core token in a comment, string, or template text is prose, not a reference", () => {
  expect(
    appsAgentTokenCount(
      [
        "// kernel.commit in a comment",
        "/* createSessionEntityLayer in a block */",
        'const s = "SqliteClient.layer in a string";',
        `const t = \`SingleRunner.layer in template text \${1}\`;`,
      ].join("\n"),
      "apps/openomni/src/prose.ts",
    ),
  ).toBe(0);
  expect(
    appsAgentTokenCount(
      `const run = Core.createSessionEntityRunTurn;
await kernel.commit({ body: \`\${kernel.materialize(id)}\` });
`,
      "apps/openomni/src/code.ts",
    ),
  ).toBe(3);
});

test("#1343: a member-chain receiver counts the same as the bare identifier", () => {
  expect(
    appsAgentTokenCount(
      [
        "runtime.kernel.commit(x);",
        "this.kernel.materialize(x);",
        "opened(id).kernel.indexSession(x);",
        "Sql.SqliteClient.layer({});",
        "cluster.SingleRunner.layer({});",
        "input.kernel.row(x);",
      ].join("\n"),
      "apps/openomni/src/chain.ts",
    ),
  ).toBe(5);
});

test("#1343: regex literals never desync the counter — references after them still count", () => {
  expect(
    appsAgentTokenCount("const r = /'/; kernel.commit(x);\n", "apps/openomni/src/regex.ts"),
  ).toBe(1);
  expect(
    appsAgentTokenCount(
      "const r = /`/;\nkernel.commit(x);\nconst q = 1;\n",
      "apps/openomni/src/regex-backtick.ts",
    ),
  ).toBe(1);
});

test("#1343: JSX text with an apostrophe is prose in a .tsx file; the reference after it counts", () => {
  expect(
    appsAgentTokenCount(
      "export const v = <p>don't kernel.commit here</p>;\nkernel.commit(x);\n",
      "apps/openomni/src/view.tsx",
    ),
  ).toBe(1);
});

test("#1343: a line-wrapped member access is one reference (the regex-era miss)", () => {
  expect(
    appsAgentTokenCount("const c = kernel\n  .commit({ sessionId: id });\n", "apps/openomni/src/wrap.ts"),
  ).toBe(1);
});

test("#1343: a new app file starts at zero — one direct token fails the ratchet", async () => {
  const root = scratchAppsTree({
    "composition/evil.ts": 'import { Core } from "@openomni/agent";\nexport const go = () => kernel.indexSession(1);\n',
  });
  try {
    const violations = await validateAppsAgentTokens(root);
    expect(violations).toEqual([
      "VIOLATION: apps/openomni/src/composition/evil.ts references 1 direct agent-core tokens over the #1343 ratchet of 0 — shrink only, never grow",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1343: a retired call site without lowering its pin fails closed (slack)", async () => {
  // index.ts is pinned at 1 (#1346: the last pinned file); a checkout where
  // it is clean must fail, and so must a pinned file deleted from the checkout.
  const cases: readonly Record<string, string>[] = [
    { "index.ts": "export const clean = true;\n" },
    { "process-entry.ts": "export const clean = true;\n" },
  ];
  for (const files of cases) {
    const root = scratchAppsTree(files, "dir");
    try {
      const violations = await validateAppsAgentTokens(root);
      expect(violations).toContain(
        "VIOLATION: apps/openomni/src/index.ts token pin exceeds actual (1 > 0): lower the pin",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("#1343: a formerly pinned file that retired every token is unpinned, not slack (#1346)", async () => {
  const root = scratchAppsTree({ "composition/ingress-executor.ts": "export const clean = true;\n", "index.ts": "kernel.commit(a);\n" }, "dir");
  try {
    expect(await validateAppsAgentTokens(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1343: outside a checkout a stubbed pinned path passes, and the skip is one loud notice", async () => {
  // The gate-discovery fixture stubs every workspace entry, index.ts included,
  // in a plain directory: growth still fails there, slack is not judged.
  const root = scratchAppsTree({
    "index.ts": "export {};\n",
    "view.tsx": 'import "@openomni/protocol";\n',
  });
  const notices: string[] = [];
  try {
    expect(await validateAppsAgentTokens(root, (notice) => notices.push(notice))).toEqual([]);
    expect(notices).toEqual([
      `NOTICE [check-deps] token pin slack not judged: ${root} is not a git checkout`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1343: a worktree-style .git FILE scopes slack judging exactly like a .git directory", async () => {
  const root = scratchAppsTree({ "index.ts": "export {};\n" }, "file");
  const notices: string[] = [];
  try {
    const violations = await validateAppsAgentTokens(root, (notice) => notices.push(notice));
    expect(notices).toEqual([]);
    expect(violations).toContain(
      "VIOLATION: apps/openomni/src/index.ts token pin exceeds actual (1 > 0): lower the pin",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1343: an already-pinned file growing above its pin fails with the file and both numbers", async () => {
  // index.ts is pinned at 1 (#1346); a second direct token is growth, not slack.
  const root = scratchAppsTree(
    {
      "index.ts": [
        "const run = createSessionEntityRunTurn;",
        "kernel.commit(a);",
        "SingleRunner.layer;",
      ].join("\n"),
    },
    "file",
  );
  try {
    const violations = await validateAppsAgentTokens(root);
    expect(violations).toContain(
      "VIOLATION: apps/openomni/src/index.ts references 3 direct agent-core tokens over the #1343 ratchet of 1 — shrink only, never grow",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** The #1346 gate's notice sink when a case asserts violations only. */
const silent = (notice: string): void => {
  if (notice.length === 0) throw new Error("empty notice");
};

test("#1346: session-store write calls are found by AST, wrapped or chained, never in prose", () => {
  const sites = appsSessionWriteSites(
    [
      "const a = kernel.commit(x);",
      "await plane.catalog.indexSession(row);",
      "const b = source",
      "  .commit(",
      "    y,",
      "  );",
      "kernel.materialize(seed); kernel.adoptFence(owner);",
      "// kernel.commit( in a comment",
      "const s = 'kernel.commit(' + `wrapped .materialize( text`;",
      "const read = kernel.row(id); const other = commit(z);",
    ].join("\n"),
    "apps/openomni/src/x.ts",
  );
  expect(sites.map((site) => [site.line, site.receiver, site.member])).toEqual([
    [1, "kernel", "commit"],
    [2, "catalog", "indexSession"],
    [4, "source", "commit"],
    [7, "kernel", "materialize"],
    [7, "kernel", "adoptFence"],
  ]);
});

test("#1346 r1 M2: every spelling of a write door counts — element access, destructuring, aliasing, bare and renamed calls, sessionStore create", () => {
  const sites = appsSessionWriteSites(
    [
      'kernel["commit"]({});',
      "const { commit } = kernel; commit({});",
      "const { materialize: seed } = source;",
      "const adopt = Core.adoptedExecutionLedger; adopt(kernel, id, owner, clock);",
      "Core.fencedExecutionLedger(kernel, id, owner, fence);",
      "plane.sessionStore(id).create({});",
      "ports.create(x); provider.create(y); NamedError.create(z);",
      "const read = kernel.row(id); const { row } = kernel;",
      "const key = input.commit.id; const { commit: payload, deliver } = frame; send({ payload, deliver });",
      "const local = commitDeliverPayload(deps); local(input, payload);",
    ].join("\n"),
    "apps/openomni/src/x.ts",
  );
  // Line 9-10: `commit` as a payload field read, an uncalled destructure and
  // an unrelated local never count; line 2 counts because the destructured
  // `commit` is then called bare.
  expect(sites.map((site) => [site.line, site.receiver, site.member])).toEqual([
    [1, "kernel", "commit"],
    [2, "<destructure>", "commit"],
    [2, "<bare>", "commit"],
    [3, "<destructure>", "materialize"],
    [4, "<alias>", "adoptedExecutionLedger"],
    [5, "Core", "fencedExecutionLedger"],
    [6, "sessionStore", "create"],
  ]);
  expect(
    appsSessionWriteSites("const c = kernel.commit; c(x); const { commit: m } = store; m(y);", "apps/openomni/src/y.ts").map(
      (site) => [site.receiver, site.member],
    ),
  ).toEqual([
    ["<alias>", "commit"],
    ["<bare>", "commit"],
    ["<destructure>", "commit"],
    ["<bare>", "commit"],
  ]);
});

test("#1346: a session write outside the exact allow-list line fails; the contacts materialize port is excluded", async () => {
  const root = scratchAppsTree(
    {
      "composition/x.ts": "export const run = () => kernel.commit(action);\n",
      "provisioning/contacts.ts": "export const persons = () => port.materialize();\n",
    },
    "dir",
  );
  try {
    const violations = await validateAppsSessionWrites(root, silent);
    expect(violations.filter((line) => line.includes("composition/x.ts:1 names kernel.commit"))).toHaveLength(1);
    expect(violations.some((line) => line.includes("contacts.ts"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1346: the allow-listed tools.add configure commit must still sit on its pinned line in a git checkout", async () => {
  const root = scratchAppsTree({ "index.ts": "export const noWrites = 1;\n" }, "file");
  try {
    const violations = await validateAppsSessionWrites(root, silent);
    expect(violations).toEqual([
      expect.stringContaining("apps/openomni/src/index.ts:1231 no longer names kernel.commit"),
      expect.stringContaining("apps/openomni/src/composition/ingress-executor.ts:58 no longer names Core.adoptedExecutionLedger"),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const notices: string[] = [];
  const bare = scratchAppsTree({ "index.ts": "export const noWrites = 1;\n" });
  try {
    expect(await validateAppsSessionWrites(bare, (notice) => notices.push(notice))).toEqual([]);
    expect(notices).toHaveLength(1);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});
