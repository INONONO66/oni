import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Builds the publishable npm artifact at `apps/openomni/dist-npm`.
 *
 * The staging layout is a contract, not a convenience:
 * - `dist/app/main.js`  — the CLI bundle. The ledger schema is embedded in
 *   the bundle (W5.2: no migration plane, fresh per-session files), so the
 *   package root carries only `bin/`, `dist/` and the README. The pack smoke
 *   test boots the bundle against a real database to keep this honest.
 * - `dist/app/process-entry.js` — the process-transport child, resolved by
 *   the app as a sibling of the running bundle.
 * - `bin/openomni.js` — node-runnable stub that re-executes under bun.
 * - the generated package.json carries NO dependencies: workspace packages
 *   are folded into the bundles and never exist on the npm registry.
 */
const appDir = fileURLToPath(new URL("..", import.meta.url));
const staging = process.argv[2] ?? join(appDir, "dist-npm");

rmSync(staging, { recursive: true, force: true });
mkdirSync(join(staging, "bin"), { recursive: true });

for (const entrypoint of ["src/cli/main.ts", "src/process-entry.ts"]) {
  const result = await Bun.build({
    entrypoints: [join(appDir, entrypoint)],
    outdir: join(staging, "dist", "app"),
    target: "bun",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(String(log));
    process.exit(1);
  }
}

cpSync(join(appDir, "npm", "README.md"), join(staging, "README.md"));
cpSync(join(appDir, "npm", "openomni-bin.js"), join(staging, "bin", "openomni.js"));

const appManifest = JSON.parse(readFileSync(join(appDir, "package.json"), "utf-8")) as {
  readonly version: string;
};
const manifest = {
  name: "openomni",
  version: appManifest.version,
  description: "Single-Owner Agent OS — one Resident, running 24/7 on your machine",
  type: "module",
  bin: { openomni: "bin/openomni.js" },
  files: ["bin", "dist", "README.md"],
  repository: { type: "git", url: "git+https://github.com/INONONO66/openomni.git" },
  engines: { node: ">=20" },
  publishConfig: { access: "public" },
};
writeFileSync(join(staging, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`npm package staged at ${staging}`);
console.log("publish with: npm publish apps/openomni/dist-npm");
