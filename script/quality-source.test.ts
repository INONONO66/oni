import { expect, test } from "bun:test";
import { qualitySource } from "./quality-source";

test("campaign measurement keeps handwritten declarations but excludes generated artifacts and unowned tooling", () => {
  for (const path of ["packages/a/src/main.ts", "packages/a/test/main.test.ts", "apps/a/src/main.tsx", "apps/a/test/main.py", "script/nested/gate.ts", "script/quality-mutation/python-engine.py", "packages/a/src/types.d.ts", "clients/machine-client/src/code/driver.py"])
    expect(qualitySource(path)).toBe(true);
  for (const path of ["packages/a/dist/main.ts", "packages/a/src/generated/main.ts", "packages/a/src/__generated__/main.ts", "packages/a/src/node_modules/nested/main.ts", "packages/ui/showcase/probe.ts", "apps/desktop/scripts/shoot-chat.ts", "apps/desktop/electron.vite.config.ts", "script/coverage/result.ts", "script/worker.mjs", "docs/example.ts", "packages/a/bench/main.ts", "clients/machine-client/src/code/other.py"])
    expect(qualitySource(path)).toBe(false);
});
