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
  appAgentResponsibilityCount,
  validateAppAgentResponsibilities,
  validateAgentBands,
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

test("#1343: a code reference after a template substitution remains visible", () => {
  expect(appAgentResponsibilityCount(`const message = \`value \${identifier}\`;\nkernel.commit({});\n`)).toBe(1);
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
    'import { fold } from "../../inspect/history";\nimport { m } from "../../model/errors";',
  );
  expect(found).toHaveLength(2);
  expect(found[0]).toContain("plugins/compaction/ may not import inspect/");
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

test("#1343: code references count; comment, string and template prose do not", () => {
  expect(appAgentResponsibilityCount(`// kernel.commit and SingleRunner.layer
    const prose = "createSessionEntityLayer kernel.materialize";
    const more = \`SqliteClient.layer\`;
    kernel.commit({}); createSessionEntityLayer(config);`)).toBe(2);
});

test("#1343: new app file starts at zero; pinned call site removal is stale", async () => {
  const root = mkdtempSync(join(tmpdir(), "app-responsibility-"));
  try {
    const path = join(root, "apps/openomni/src/composition/cluster-runtime.ts");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "export const clean = true;\n");
    const added = join(root, "apps/openomni/src/added.ts");
    writeFileSync(added, "kernel.indexSession();\n");
    const found = await validateAppAgentResponsibilities(root);
    expect(found).toContain("VIOLATION: apps/openomni/src/added.ts direct agent responsibility actual 1, pin 0 (growth)");
    expect(found).toContain("VIOLATION: apps/openomni/src/composition/cluster-runtime.ts direct agent responsibility actual 0, pin 5 (stale pin)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
    "core/store/errors.ts":
      'import { name } from "../../plugins/alarm";\nexport const e = name;\n',
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
