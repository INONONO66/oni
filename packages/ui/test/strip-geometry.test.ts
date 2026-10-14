import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SIDEBAR_WIDTH } from "../src/sidebar";

/**
 * The strip's geometry is a handful of tokens that must add up: the collapsed
 * zone holds the darwin inset, the toggle, the trio and the gaps, and the
 * overlay panel is the pinned default. Asserted on the CSS text, because a
 * token that drifts is invisible to the compiler.
 */
const SRC = join(import.meta.dir, "..", "src");
const CSS = await Bun.file(join(SRC, "styles.css")).text();

/** A `--token: <n>px` declaration, in px. */
function px(token: string): number {
  const hit = CSS.match(new RegExp(`${token}:\\s*(\\d+(?:\\.\\d+)?)px;`));
  if (!hit) throw new Error(`${token} is not a px literal`);
  return Number(hit[1]);
}

/** A token in px, literal or a `calc()` sum of products over other tokens. */
function resolve(token: string): number {
  const raw = CSS.match(new RegExp(`${token}:\\s*([^;]+);`))?.[1];
  if (raw === undefined) throw new Error(`${token} is not declared`);
  const flat = raw
    .replace(/var\((--[\w-]+)\)/g, (_, inner: string) => String(resolve(inner)))
    .replace(/calc\(|\)|px|\s/g, "");
  return flat
    .split("+")
    .map((term) => term.split("*").reduce((product, factor) => product * Number(factor), 1))
    .reduce((sum, term) => sum + term, 0);
}

describe("the strip's tokens", () => {
  test("Given the frame's tokens, When read, Then strip 40, tab 28, control 28, safe zone 68", () => {
    expect(px("--spacing-shell-strip")).toBe(40);
    expect(px("--spacing-tab-height")).toBe(28);
    expect(px("--spacing-control-base")).toBe(28);
    expect(px("--spacing-control-xs")).toBe(20);
    expect(px("--spacing-traffic-safe")).toBe(68);
    expect(CSS).toContain("--shell-top: var(--spacing-shell-strip);");
  });

  test("Given the darwin inset, When resolved, Then the zone's content starts at 76 = safe zone + 8", () => {
    expect(resolve("--spacing-strip-inset-darwin")).toBe(76);
    expect(px("--spacing-traffic-safe") + 8).toBe(76);
  });

  test("Given the collapsed zone, When resolved, Then it holds inset + 10, four controls at 4px gaps and 12 on the right", async () => {
    const control = px("--spacing-control-base");
    const inset = resolve("--spacing-strip-inset-darwin");
    // darwin: 76 + 10 to the toggle's box, then toggle + trio (4 controls, 3 gaps), then 12.
    const contents = inset + 10 + 4 * control + 3 * 4 + 12;
    expect(contents).toBe(222);
    expect(resolve("--spacing-strip-zone-collapsed")).toBe(contents);
    const strip = await Bun.file(join(SRC, "tab-strip.tsx")).text();
    expect(strip).toContain("w-strip-zone-collapsed");
    expect(strip).toContain("pl-[calc(var(--spacing-strip-inset-darwin)+10px)]");
    expect(strip).toContain("pl-strip-inset-darwin");
  });

  test("Given the overlay, When resolved, Then it is ONE number with the pinned default: 252", () => {
    const overlay = px("--spacing-sidebar-overlay");
    expect(overlay).toBe(252);
    // A reveal that is pinned does not reflow the column.
    expect(overlay).toBe(SIDEBAR_WIDTH.default);
  });

  test("Given the trio, When the CSS is read, Then it has NO fade: no progress property, no opacity or visibility rule, no starting-style", async () => {
    expect(CSS).not.toContain("--strip-trio-progress");
    expect(CSS).not.toContain("strip-trio");
    expect(CSS).not.toContain("data-collapsed");
    expect(CSS).not.toContain("@starting-style");
    const strip = await Bun.file(join(SRC, "tab-strip.tsx")).text();
    const trio = strip.slice(strip.indexOf("data-ui={UI_NAMES.TabStripTrio}") - 200, strip.indexOf("<HistoryMenu"));
    const className = trio.match(/className="([^"]+)"/)?.[1] ?? "";
    expect(className).toBe("ml-auto flex items-center gap-1");
    expect(className).not.toMatch(/opacity|visible|invisible|transition/);
    expect(trio).not.toContain("data-collapsed");
  });

  test("Given the strip's source, When read, Then the trio carries no key: one node in both states", async () => {
    const strip = await Bun.file(join(SRC, "tab-strip.tsx")).text();
    const trio = strip.slice(strip.indexOf('className="ml-auto flex'), strip.indexOf("<HistoryMenu"));
    expect(trio).toContain("data-ui={UI_NAMES.TabStripTrio}");
    expect(trio).not.toContain("key=");
    expect(strip).not.toContain("key={open");
  });
});

describe("the strip's glyphs", () => {
  test("Given 16px icons at a 1.5px stroke, When read, Then the stroked glyphs run 1.5px in screen pixels at the 16px sites only", async () => {
    expect(px("--stroke-glyph")).toBe(1.5);
    const utility = CSS.slice(CSS.indexOf("@utility glyph-stroke {"));
    const block = utility.slice(0, utility.indexOf("\n}\n"));
    expect(block).toContain("stroke-width: var(--stroke-glyph);");
    expect(block).toContain("vector-effect: non-scaling-stroke;");
    const button = await Bun.file(join(SRC, "primitives", "button.tsx")).text();
    const sizes: Record<string, string | undefined> = Object.fromEntries(
      [...button.matchAll(/^\s+(sm|base|md): "([^"]+)",$/gm)].map((hit): [string, string | undefined] => [hit[1] ?? "", hit[2]]),
    );
    expect(sizes.base).toContain("[&_svg]:glyph-stroke");
    expect(sizes.sm).not.toContain("glyph-stroke");
    expect(sizes.md).not.toContain("glyph-stroke");
  });

  test("Given the strip, When its imports are read, Then the toggle and chevrons are ours, not lucide's", async () => {
    const strip = await Bun.file(join(SRC, "tab-strip.tsx")).text();
    const lucide = strip.match(/import \{([^}]+)\} from "lucide-react"/)?.[1] ?? "";
    expect(lucide.split(",").map((name) => name.trim())).toEqual(["Plus", "X"]);
    expect(strip).toContain('from "./icons/sidebar-toggle"');
    expect(strip).toContain('from "./icons/chevron"');
  });
});
