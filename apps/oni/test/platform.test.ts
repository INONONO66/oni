import { expect, test } from "bun:test";
import { platformEntropy } from "../src/composition/platform";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The composition root's only ambient entropy (#1245): CSPRNG ids and uniform randoms.
test("platform entropy mints UUID-shaped ids and uniform randoms in [0,1)", () => {
  const entropy = platformEntropy();
  expect(entropy.id()).toMatch(UUID);
  expect(entropy.id()).not.toBe(entropy.id());
  for (let draw = 0; draw < 64; draw += 1) {
    const value = entropy.random();
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(1);
  }
});
