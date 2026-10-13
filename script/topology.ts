import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export type DependencyBand = "none" | "any-except-self" | readonly string[];

/** Cross-directory core value edges; type-only references do not participate. */
export const AGENT_CORE_EDGES: Readonly<Record<string, readonly string[]>> = {
  session: ["composition", "loop", "journal", "ports", "observation", "gate", "store"],
  composition: ["ports", "gate"],
  loop: ["gate", "journal", "observation", "ports", "store"],
  journal: ["ports", "store"],
  gate: ["ports", "store"],
  store: ["ports"],
  observation: ["ports"],
  ports: [],
};

export interface WorkspaceTopology {
  readonly key: string;
  readonly displayName: string;
  readonly dir: string;
  readonly packageName: string;
  readonly allowedDeps: DependencyBand;
  readonly srcAllowedDeps?: readonly string[];
  /** Runs as an explicit CI test lane. */
  readonly testLane: true;
  /** Emits LCOV and must have a ratchet baseline. False is an explicit skip. */
  readonly coverageLane: boolean;
  /** Must be represented by an explicit knip workspace. */
  readonly knipWorkspace: true;
  /** Existing src/test roots and project configs are verified. */
  readonly tsconfigVerify: true;
  readonly extraSourceRoots?: readonly string[];
  readonly ciTestCommand?: string;
}

/**
 * The single structural inventory for repository workspaces. Adding a workspace
 * here makes dependency, cycle, CI, coverage, knip, and tsconfig gates account
 * for it. Package-specific source sub-bands remain in their owning gate.
 *
 * #1246 merged ten packages into five: ipc and codemode folded into machines,
 * policy/ledger/llm folded into agent, and the channel-facing stores moved
 * into channels. #1272 extracted code mode back out as the sixth package.
 * #1352 extracted the model-call layer as `@openomni/llm`; the agent core
 * declares the port and only the app binds the package. The import direction
 * (right imports left) is:
 * protocol <- agent, llm, machines, channels, apps/openomni, apps/desktop;
 * agent <- channels, apps/openomni; llm <- apps/openomni;
 * machines <- codemode, apps/openomni; codemode <- apps/openomni;
 * channels <- apps/openomni; ui <- apps/desktop.
 */
export const TOPOLOGY = [
  {
    key: "protocol",
    displayName: "protocol",
    dir: "packages/protocol",
    packageName: "@openomni/protocol",
    allowedDeps: "none",
    testLane: true,
    coverageLane: true,
    knipWorkspace: true,
    tsconfigVerify: true,
  },
  {
    key: "agent",
    displayName: "agent",
    dir: "packages/agent",
    packageName: "@openomni/agent",
    allowedDeps: ["@openomni/protocol"],
    testLane: true,
    coverageLane: true,
    knipWorkspace: true,
    tsconfigVerify: true,
    extraSourceRoots: ["bench"],
    ciTestCommand: "bun run test:ci",
  },
  {
    key: "llm",
    displayName: "llm",
    dir: "packages/llm",
    packageName: "@openomni/llm",
    // The model-call layer (#1352): provider adapters, stream processing and
    // accounting over the ai SDK. It knows protocol only; the agent core
    // declares the port it satisfies and never imports it.
    allowedDeps: ["@openomni/protocol"],
    testLane: true,
    coverageLane: true,
    knipWorkspace: true,
    tsconfigVerify: true,
  },
  {
    key: "machines",
    displayName: "machines",
    dir: "packages/machines",
    packageName: "@openomni/machines",
    allowedDeps: ["@openomni/protocol"],
    testLane: true,
    // #945 adds the first measured, shrink-only coverage floor.
    coverageLane: true,
    knipWorkspace: true,
    tsconfigVerify: true,
  },
  {
    key: "codemode",
    displayName: "codemode",
    dir: "packages/codemode",
    packageName: "@openomni/codemode",
    // The shared Python-backed cell runtime (#1272): it consumes the machines
    // structural host/daemon contracts and protocol schemas, nothing else.
    allowedDeps: ["@openomni/protocol", "@openomni/machines"],
    testLane: true,
    coverageLane: true,
    knipWorkspace: true,
    tsconfigVerify: true,
  },
  {
    key: "channels",
    displayName: "channels",
    dir: "packages/channels",
    packageName: "@openomni/channels",
    // Agent carries the policy gate and persistence seams absorbed in #1246;
    // the channels judgment and store bands consume them through the barrel.
    allowedDeps: ["@openomni/protocol", "@openomni/agent"],
    testLane: true,
    coverageLane: true,
    knipWorkspace: true,
    tsconfigVerify: true,
  },
  {
    key: "openomniApp",
    displayName: "openomni app",
    dir: "apps/openomni",
    packageName: "@openomni/app",
    allowedDeps: [
      "@openomni/protocol",
      "@openomni/channels",
      "@openomni/agent",
      "@openomni/llm",
      "@openomni/machines",
      "@openomni/codemode",
    ],
    testLane: true,
    coverageLane: true,
    knipWorkspace: true,
    tsconfigVerify: true,
  },
  {
    key: "ui",
    displayName: "ui design system",
    dir: "packages/ui",
    packageName: "@openomni/ui",
    // None, and that is the whole rule: the design system may not depend on the
    // app it dresses, nor on any kernel package. It owns tokens, primitives,
    // window chrome, the transcript's presentation, and the one `Console`
    // composition — all of it data-blind.
    allowedDeps: [],
    testLane: true,
    // Visual review remains separate from the measured #945 source floor.
    coverageLane: true,
    knipWorkspace: true,
    tsconfigVerify: true,
  },
  {
    key: "desktopApp",
    displayName: "desktop app",
    dir: "apps/desktop",
    packageName: "@openomni/desktop",
    // `@openomni/ui` is the renderer's design system: it renders `Console` and
    // composes primitives, and names no color of its own.
    allowedDeps: ["@openomni/protocol", "@openomni/ui"],
    testLane: true,
    // #945 adds the first measured source floor for the desktop lane.
    coverageLane: true,
    knipWorkspace: true,
    tsconfigVerify: true,
  },
] as const satisfies readonly WorkspaceTopology[];

interface WorkspaceInventoryDrift {
  readonly unaccounted: readonly string[];
  readonly nonexistent: readonly string[];
}

const REPO_ROOT = join(import.meta.dir, "..");

/** Compare the topology manifest with package.json workspaces found on disk. */
export function topologyInventoryDrift(
  topology: readonly WorkspaceTopology[] = TOPOLOGY,
  root = REPO_ROOT,
): WorkspaceInventoryDrift {
  const rootManifest = z.object({ workspaces: z.array(z.string()) }).safeParse(
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")),
  );
  if (!rootManifest.success) {
    throw new Error("root package.json workspaces must be an array of glob strings");
  }

  const actualDirs = new Set<string>();
  for (const workspaceGlob of rootManifest.data.workspaces) {
    for (const manifestPath of new Bun.Glob(`${workspaceGlob}/package.json`).scanSync({
      cwd: root,
      onlyFiles: true,
    })) {
      actualDirs.add(manifestPath.replace(/\/package\.json$/, ""));
    }
  }

  const topologyDirs = new Set(topology.map((workspace) => workspace.dir));
  return {
    unaccounted: [...actualDirs].filter((dir) => !topologyDirs.has(dir)).sort(),
    nonexistent: [...topologyDirs].filter((dir) => !actualDirs.has(dir)).sort(),
  };
}

/** Fail a direct topology consumer before it can scan a reduced repository. */
export function assertTopologyComplete(
  topology: readonly WorkspaceTopology[] = TOPOLOGY,
  root = REPO_ROOT,
): void {
  const { unaccounted, nonexistent } = topologyInventoryDrift(topology, root);
  if (unaccounted.length > 0) {
    throw new Error(`topology omits on-disk workspace(s): ${unaccounted.join(", ")}`);
  }
  if (nonexistent.length > 0) {
    throw new Error(
      `topology names workspace(s) with no on-disk package: ${nonexistent.join(", ")}`,
    );
  }
}

export const knipWorkspaces = (topology: readonly WorkspaceTopology[] = TOPOLOGY) =>
  topology.filter((workspace) => workspace.knipWorkspace);

export const tsconfigWorkspaces = (topology: readonly WorkspaceTopology[] = TOPOLOGY) =>
  topology.filter((workspace) => workspace.tsconfigVerify);

export function ciTestSteps(topology: readonly WorkspaceTopology[] = TOPOLOGY): string {
  const workspaceSteps = topology
    .filter((workspace) => workspace.testLane)
    .map((workspace) => ({
      command:
        workspace.ciTestCommand ??
        (workspace.coverageLane
          ? "bun test --timeout 15000 --coverage --coverage-reporter=lcov --coverage-dir=coverage"
          : "bun test --timeout 15000"),
      dir: workspace.dir,
      displayName: workspace.displayName,
      key: workspace.key,
    }));
  return workspaceSteps
    .map(
      ({ command, dir, displayName, key }) =>
        `      - name: Test (${displayName})\n        if: matrix.key == '${key}'\n        run: ${command}\n        working-directory: ${dir}`,
    )
    .join("\n");
}
