import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SIDEBAR_WIDTH } from "../src/sidebar";

/**
 * The strip's geometry is a handful of tokens that must add up: the collapsed
 * zone and the overlay panel share one width token, which must hold the zone's
 * inset, the control step, and the gaps; the numbers behind it are the
 * reference console's. Asserted on
 * the CSS text, because a token that drifts is invisible to the compiler.
 */
const SRC = join(import.meta.dir, "..", "src");
const CSS = await Bun.file(join(SRC, "styles.css")).text();

/** A `--token: <n>px` declaration, in px. */
function px(token: string): number {
  const hit = CSS.match(new RegExp(`${token}:\\s*(\\d+(?:\\.\\d+)?)px;`));
  if (!hit) throw new Error(`${token} is not a px literal`);
  return Number(hit[1]);
}

/** A `--token: calc(...)` declaration, as its expression text with whitespace folded. */
function calc(token: string): string {
  const hit = CSS.match(new RegExp(`${token}:\\s*calc\\(([^;]+)\\);`))?.[1];
  if (hit === undefined) throw new Error(`${token} is not a calc()`);
  return hit.replace(/\s+/g, " ").trim();
}

describe("the strip's tokens", () => {
  test("Given the reference measurements, When read, Then strip 42, tab 26, control 28, safe zone 81", () => {
    expect(px("--spacing-shell-strip")).toBe(42);
    expect(px("--spacing-tab-height")).toBe(26);
    expect(px("--spacing-control-base")).toBe(28);
    expect(px("--spacing-control-xs")).toBe(20);
    expect(px("--spacing-traffic-safe")).toBe(81);
    expect(CSS).toContain("--shell-top: var(--spacing-shell-strip);");
  });

  test("Given the darwin inset, When resolved, Then the toggle starts at 89 = safe zone + 8", () => {
    expect(calc("--spacing-strip-inset-darwin")).toBe("var(--spacing-traffic-safe) + 8px");
    expect(px("--spacing-traffic-safe") + 8).toBe(89);
  });

  test("Given the collapsed zone and the overlay, When resolved, Then both read ONE token that holds the zone's contents", () => {
    const overlay = px("--spacing-sidebar-overlay");
    const control = px("--spacing-control-base");
    const inset = px("--spacing-traffic-safe") + 8;
    // darwin: 89 inset + toggle + gap + trio (3 controls, 2 gaps) + 12 right pad.
    const contents = inset + control + 4 + (3 * control + 2 * 4) + 12;
    expect(contents).toBe(225);
    expect(overlay).toBeGreaterThanOrEqual(contents);
    expect(overlay).toBe(240);
    // ONE number: the overlay token and the pinned default, so a reveal that is
    // pinned does not reflow the column.
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
  test("Given the reference's 16px icons at 1.5 units, When read, Then the stroked glyphs run 1.5px in screen pixels at the 16px sites only", async () => {
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
    const nav = await Bun.file(join(SRC, "sidebar-nav.tsx")).text();
    expect(nav).toContain("[&_svg]:glyph-stroke flex h-7");
  });

  test("Given the strip, When its imports are read, Then the toggle and chevrons are ours, not lucide's", async () => {
    const strip = await Bun.file(join(SRC, "tab-strip.tsx")).text();
    const lucide = strip.match(/import \{([^}]+)\} from "lucide-react"/)?.[1] ?? "";
    expect(lucide.split(",").map((name) => name.trim())).toEqual(["Plus", "X"]);
    expect(strip).toContain('from "./icons/sidebar-toggle"');
    expect(strip).toContain('from "./icons/chevron"');
  });
});
