import { describe, expect, test } from "bun:test";
import { Highlight } from "../src/primitives/highlight";
import { ScrollArea } from "../src/primitives/scroll-area";
import { Panel, Text } from "../src/primitives/surface";
import { attributes, classes, textContent } from "./markup";

describe("Panel", () => {
  test("Given an edge, When rendered, Then only left and right splits exist", () => {
    expect(classes(<Panel edge="right">x</Panel>)).toContain("border-r");
    expect(classes(<Panel edge="left">x</Panel>)).toContain("border-l");
    expect(classes(<Panel>x</Panel>).filter((token) => token.startsWith("border"))).toEqual([]);
  });
  test("Given each tone, When rendered, Then the tonal ramp is three steps", () => {
    for (const tone of ["bg", "sunken", "raised"] as const)
      expect(classes(<Panel tone={tone}>x</Panel>)).toContain(`bg-${tone}`);
  });
});

describe("Text", () => {
  test("Given the announce levels, When rendered, Then weight never reaches 700", () => {
    for (const level of ["display", "title", "heading"] as const) {
      const tokens = classes(<Text level={level}>x</Text>);
      expect(tokens).not.toContain("font-bold");
      expect(tokens).not.toContain("font-[700]");
    }
  });
  test("Given numeric text, When rendered, Then tabular figures are requested", () => {
    expect(classes(<Text numeric>1487</Text>)).toContain("tabular-nums");
  });
  test("Given mono text, When rendered, Then the machine-truth family is used", () => {
    expect(classes(<Text mono>fs.read</Text>)).toContain("font-mono");
  });
});

describe("Highlight", () => {
  const runs = [
    { text: "led", matched: true },
    { text: "ger append path", matched: false },
  ] as const;
  test("Given matched runs, When rendered, Then emphasis is weight and tone, never a fill", () => {
    const tokens = classes(<Highlight runs={runs} />);
    expect(tokens).toContain("font-medium");
    expect(tokens).toContain("text-fg");
    expect(
      tokens.filter(
        (token) => token.startsWith("bg-") || token.includes("accent") || token === "underline",
      ),
    ).toEqual([]);
  });
  test("Given a rest tone, When rendered, Then only the unmatched remainder takes it", () => {
    const label = <Highlight runs={runs} tone="muted" />;
    expect(classes(label, '[data-ui="Highlight"]')).toContain("text-fg-muted");
    expect(attributes(label, '[data-ui="Highlight"] > span').map((run) => run.class)).toEqual([
      "font-medium text-fg",
      "font-normal",
    ]);
  });
  test("Given every run, When rendered, Then the full label survives in order", () => {
    expect(textContent(<Highlight runs={runs} />, '[data-ui="Highlight"]')).toBe(
      runs.map((run) => run.text).join(""),
    );
  });
  test("Given no match, When rendered, Then nothing is emphasised", () => {
    expect(
      classes(<Highlight runs={[{ text: "ledger append path", matched: false }]} />),
    ).not.toContain("font-medium");
  });
});

describe("ScrollArea", () => {
  test("Given content, When rendered, Then the viewport is the single scrolling element", () => {
    const area = (
      <ScrollArea className="fixture-root" contentClassName="fixture-content">
        rows
      </ScrollArea>
    );
    expect(attributes(area, ".fixture-root")).toHaveLength(1);
    expect(textContent(area, ".fixture-content")).toBe("rows");
    const viewports = attributes(area, ".overscroll-contain");
    expect(viewports).toHaveLength(1);
    expect(viewports[0]?.style).toContain("overflow:scroll");
  });
});
