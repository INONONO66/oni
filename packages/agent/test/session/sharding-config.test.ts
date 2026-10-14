// Review R2 as a package test (plan §4, D9): explicit ShardingConfig values
// always beat ambient SHARDING env variables. `SingleRunner.layer` composes
// `ShardingConfig.layerFromEnv(options.shardingConfig)`, and `layerFromEnv`
// snapshots `process.env` at effect-module load — so the probe runs in a child
// process whose environment carries the conflicting variable from the start,
// exactly the shape of the production hazard. The probe writes a plain string:
// console.log colors a number whenever the inherited environment enables color.
import { expect, test } from "bun:test";
import { join } from "node:path";

const ENV_KEY = "ENTITY_MAX_IDLE_TIME";

// A string, not repo code: the child's runner call is not a repo runner site.
const PROBE = `
const { ShardingConfig } = await import("effect/cluster");
const { Context, Duration, Effect, Layer } = await import("effect");
const mode = process.argv[1];
const layer =
  mode === "env-only"
    ? ShardingConfig.layerFromEnv()
    : mode === "override"
      ? ShardingConfig.layerFromEnv({ entityMaxIdleTime: Duration.millis(250) })
      : ShardingConfig.layer({ entityMaxIdleTime: Duration.millis(250) });
const config = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(layer);
      return Context.get(context, ShardingConfig.ShardingConfig);
    }),
  ),
);
process.stdout.write(String(Duration.toMillis(config.entityMaxIdleTime)));
`;

async function probe(mode: "env-only" | "override" | "explicit"): Promise<number> {
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", PROBE, mode],
    cwd: join(import.meta.dir, "..", ".."),
    env: { ...process.env, [ENV_KEY]: mode === "env-only" ? "1234 millis" : "3600 seconds" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit !== 0) throw new Error(`probe ${mode} failed (exit ${exit}):\n${err}`);
  return Number(out.trim());
}

test("the env var alone drives layerFromEnv (the ambient hazard is real and the key is right)", async () => {
  expect(await probe("env-only")).toBe(1234);
});

test("an explicit override beats a conflicting env var at the SingleRunner seam (R2)", async () => {
  expect(await probe("override")).toBe(250);
});

test("a fully explicit ShardingConfig.layer ignores the environment entirely (prod pin, D9)", async () => {
  expect(await probe("explicit")).toBe(250);
});
