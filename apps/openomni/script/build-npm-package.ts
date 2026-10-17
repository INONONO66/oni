import type { BunPlugin } from "bun";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
 * - the generated package.json carries no workspace dependency: workspace
 *   packages are folded into the bundles and never exist on the npm registry.
 *   Its only dependencies are the native addons below, pinned to the version
 *   the bundler resolved.
 */
const appDir = fileURLToPath(new URL("..", import.meta.url));
const staging = process.argv[2] ?? join(appDir, "dist-npm");

/**
 * A native addon cannot be folded into a bundle: its loader opens the prebuilt
 * binary relative to the module's own directory, which the bundle freezes as
 * the build host's absolute path. These stay external and ship as registry
 * dependencies; the resolver records the version the bundler would have
 * inlined so the pin and the bundle can never drift apart.
 */
const NATIVE_ADDONS = ["classic-level"];
const nativeAddonVersions = new Map<string, string>();
const externalNativeAddons: BunPlugin = {
  name: "external-native-addons",
  setup(build) {
    build.onResolve({ filter: new RegExp(`^(${NATIVE_ADDONS.join("|")})$`) }, (args) => {
      const manifest = Bun.resolveSync(`${args.path}/package.json`, dirname(args.importer));
      const { version } = JSON.parse(readFileSync(manifest, "utf-8")) as { readonly version: string };
      nativeAddonVersions.set(args.path, version);
      return { path: args.path, external: true };
    });
  },
};

rmSync(staging, { recursive: true, force: true });
mkdirSync(join(staging, "bin"), { recursive: true });

for (const entrypoint of ["src/cli/main.ts", "src/process-entry.ts"]) {
  const result = await Bun.build({
    entrypoints: [join(appDir, entrypoint)],
    outdir: join(staging, "dist", "app"),
    target: "bun",
    plugins: [externalNativeAddons],
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
  dependencies: Object.fromEntries([...nativeAddonVersions].sort(([a], [b]) => a.localeCompare(b))),
  repository: { type: "git", url: "git+https://github.com/INONONO66/openomni.git" },
  engines: { node: ">=20" },
  publishConfig: { access: "public" },
};
writeFileSync(join(staging, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`npm package staged at ${staging}`);
console.log("publish with: npm publish apps/openomni/dist-npm");
