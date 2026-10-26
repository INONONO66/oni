import type { BunPlugin } from "bun";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Builds the publishable npm artifact at `apps/oni/dist-npm`.
 *
 * The staging layout is a contract, not a convenience:
 * - `dist/app/main.js`  — the CLI bundle. The ledger schema is embedded in
 *   the bundle (W5.2: no migration plane, fresh per-session files), so the
 *   package root carries only `bin/`, `dist/` and the README. The pack smoke
 *   test boots the bundle against a real database to keep this honest.
 * - `dist/app/process-entry.js` — the process-transport child, resolved by
 *   the app as a sibling of the running bundle.
 * - `bin/oni.js` — node-runnable stub that re-executes under bun.
 * - The package does not carry mclient; the service installs it beside
 *   `dist/app/` or sets `ONI_MCLIENT_BIN`.
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
const nativeAddonVersions = new Map<string, string>();
const sdkDir = dirname(Bun.resolveSync("agent-messenger/package.json", join(appDir, "..", "..", "packages", "channels")));
for (const name of ["opusscript", "@discordjs/opus", "@snazzah/davey", "koffi", "prebuilt-tdlib"]) {
  const manifest = Bun.resolveSync(`${name}/package.json`, sdkDir);
  const { version } = JSON.parse(readFileSync(manifest, "utf-8")) as { readonly version: string };
  nativeAddonVersions.set(name, version);
}
const externalNativeAddons: BunPlugin = {
  name: "external-native-addons",
  setup(build) {
    build.onResolve({ filter: /^(classic-level|@discordjs\/voice|prism-media|koffi|prebuilt-tdlib)$/ }, (args) => {
      const manifest = Bun.resolveSync(`${args.path}/package.json`, dirname(args.importer));
      const { version } = JSON.parse(readFileSync(manifest, "utf-8")) as { readonly version: string };
      nativeAddonVersions.set(args.path, version);
      return { path: args.path, external: true };
    });
  },
};

rmSync(staging, { recursive: true, force: true });
mkdirSync(join(staging, "bin"), { recursive: true });

for (const entrypoint of [
  join(appDir, "src/cli/main.ts"),
  join(appDir, "src/process-entry.ts"),
  join(dirname(Bun.resolveSync("agent-messenger/slack", sdkDir)), "huddle-host.js"),
]) {
  const result = await Bun.build({
    entrypoints: [entrypoint],
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
cpSync(join(appDir, "npm", "oni-bin.js"), join(staging, "bin", "oni.js"));

const appManifest = JSON.parse(readFileSync(join(appDir, "package.json"), "utf-8")) as {
  readonly version: string;
};
const manifest = {
  name: "oni",
  version: appManifest.version,
  description: "Single-Owner Agent OS — one Resident, running 24/7 on your machine",
  type: "module",
  bin: { oni: "bin/oni.js" },
  files: ["bin", "dist", "README.md"],
  dependencies: Object.fromEntries([...nativeAddonVersions].filter(([name]) => name !== "@discordjs/opus").sort(([a], [b]) => a.localeCompare(b))),
  optionalDependencies: { "@discordjs/opus": nativeAddonVersions.get("@discordjs/opus") },
  repository: { type: "git", url: "git+https://github.com/INONONO66/oni.git" },
  engines: { node: ">=20" },
  publishConfig: { access: "public" },
};
writeFileSync(join(staging, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`npm package staged at ${staging}`);
console.log("publish with: npm publish apps/oni/dist-npm");
