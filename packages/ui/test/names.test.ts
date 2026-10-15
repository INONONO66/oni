import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Glob } from "bun";
import { UI_NAMES } from "../src/names";

/**
 * Every address in `names.ts` is stamped somewhere: a name nobody writes to
 * the DOM is a review vocabulary for an element that does not exist, and a
 * name written from a literal instead of `UI_NAMES` is one a rename misses.
 */
const SRC = join(import.meta.dir, "..", "src");

async function sources(): Promise<string> {
  const parts: string[] = [];
  for await (const path of new Glob("**/*.{ts,tsx}").scan({ cwd: SRC, absolute: true })) {
    if (path.endsWith("/names.ts")) continue;
    parts.push(await Bun.file(path).text());
  }
  return parts.join("\n");
}

function references(src: string, key: string): boolean {
  return new RegExp(`(?<![\\w$])UI_NAMES\\.${key}(?![\\w$])`).test(src);
}

describe("the address book", () => {
  test("a part reference does not satisfy its parent token", () => {
    const src = '<span data-ui={UI_NAMES.TabIcon} />';
    expect(references(src, "TabIcon")).toBe(true);
    expect(references(src, "Tab")).toBe(false);
  });
  test("Given every name, When src is read, Then each is stamped through UI_NAMES and none by its literal", async () => {
    const src = await sources();
    const orphans = Object.keys(UI_NAMES).filter((key) => !references(src, key));
    expect(orphans).toEqual([]);
    const literals = Object.values(UI_NAMES).filter((value) => src.includes(`data-ui="${value}"`));
    expect(literals).toEqual([]);
  });
});
