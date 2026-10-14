import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { attributes, classes, textContent } from "./markup";
import { SidebarContextError, useSidebar } from "../src/sidebar";
import { EpochRule } from "../src/primitives/epoch-rule";
import { GutterLine } from "../src/primitives/gutter";
import { StatusDot } from "../src/primitives/state";
import { HistoryMenu } from "../src/history-menu";
import {
  NavItem,
  SectionHeader,
  SectionSearchInput,
  SidebarFooter,
  SidebarHeader,
  SidebarNav,
  SidebarSection,
} from "../src/sidebar-nav";
import { TreeRow } from "../src/tree-row";

const header = (searching: boolean) => (
  <SectionHeader
    label="Projects"
    searching={searching}
    onSearchingChange={() => undefined}
    searchLabel="Search projects"
    resultLabel="2 results"
  >
    <SectionSearchInput
      label="Projects"
      placeholder="Filter"
      value="x"
      onValueChange={() => undefined}
      onKeyDown={() => undefined}
      inputRef={() => undefined}
      controlsId="results"
      activeDescendantId="row-1"
    />
  </SectionHeader>
);

describe("sidebar navigation controls", () => {
  test("renders active and inactive destinations with accessible state", () => {
    const node = (
      <SidebarNav>
        <NavItem active icon={<svg aria-hidden="true" />}>
          One
        </NavItem>
        <NavItem icon={<svg aria-hidden="true" />}>Two</NavItem>
      </SidebarNav>
    );
    const html = attributes(node);
    const items = html.filter((element) => element["data-ui"] === "NavItem");
    expect(items).toHaveLength(2);
    expect(items[0]?.["aria-current"]).toBe("page");
    expect(items[1]?.["aria-current"]).toBeUndefined();
    expect(items[0]?.class?.split(" ")).toEqual(
      expect.arrayContaining(["h-7", "px-2"]),
    );
    expect(textContent(node, '[data-ui="NavItem"]')).toBe("OneTwo");
  });
  test("header is a 44px row with the brand at the left and the actions at the right", () => {
    const node = (
      <SidebarHeader
        actions={
          <>
            <button type="button">new</button>
            <button type="button">collapse</button>
          </>
        }
        brand={<span data-brand="" />}
      />
    );
    const frame = attributes(node, '[data-ui="Sidebar.Header"]');
    expect(frame).toHaveLength(1);
    expect(frame[0]?.class?.split(" ")).toEqual(expect.arrayContaining(["h-11", "pr-2", "pl-4"]));
    expect(attributes(node, '[data-ui="Sidebar.Header"] > span > [data-brand]')).toHaveLength(1);
    expect(attributes(node, '[data-ui="Sidebar.Header"] > span > button')).toHaveLength(2);
  });
  test("header toggles search semantics and result announcement", () => {
    const closed = attributes(header(false));
    const open = attributes(header(true));
    expect(closed.some((element) => "data-searching" in element)).toBe(false);
    expect(closed.some((element) => element["aria-live"] === "polite")).toBe(true);
    expect(open.find((element) => element.role === "combobox")).toMatchObject({
      "aria-expanded": "true",
      "aria-controls": "results",
      "aria-activedescendant": "row-1",
    });
  });
  test("header keeps one 28px row and one 28px control in both states", () => {
    for (const searching of [false, true]) {
      const row = attributes(header(searching), '[data-ui="SectionHeader"] > div');
      expect(row).toHaveLength(1);
      expect(row[0]?.class?.split(" ")).toEqual(expect.arrayContaining(["h-7", "pl-2"]));
      expect("data-searching" in (row[0] ?? {})).toBe(searching);
      const toggle = attributes(header(searching), '[data-ui="SectionHeader.Toggle"]');
      expect(toggle[0]?.["data-size"]).toBe("base");
    }
    expect(textContent(header(false), '[data-ui="SectionHeader"] > div > span')).toBe("Projects");
    expect(attributes(header(true), '[data-ui="SectionHeader"] input')[0]?.value).toBe("x");
  });
  test("section and footer preserve their structural slots", () => {
    const html = attributes(
      <SidebarSection>
        <SidebarFooter>footer</SidebarFooter>
      </SidebarSection>,
    );
    expect(html.some((element) => element["data-ui"] === "Sidebar.Footer")).toBe(true);
    expect(textContent(
      <SidebarSection><SidebarFooter>footer</SidebarFooter></SidebarSection>,
      '[data-ui="Sidebar.Footer"]',
    )).toBe("footer");
  });
});

describe("tree rows", () => {
  test("a group row is a 28px heading with the chevron in the glyph slot and the count beside the label", () => {
    const node = (
      <TreeRow expanded trailing="3">
        Work
      </TreeRow>
    );
    const [row] = attributes(node, '[data-ui="TreeRow"]');
    expect(row?.["aria-expanded"]).toBe("true");
    expect(row?.class?.split(" ")).toEqual(
      expect.arrayContaining(["h-7", "px-2"]),
    );
    expect(classes(node, '[data-ui="TreeRow"] > .size-4 > svg')).toEqual(
      expect.arrayContaining(["size-3.5", "rotate-90"]),
    );
    expect(textContent(node, '[data-ui="TreeRow"]')).toBe("Work3");
    expect(attributes(<TreeRow expanded={false}>Work</TreeRow>, "svg")[0]?.class).not.toContain(
      "rotate-90",
    );
  });
  test("a session row is a two-line grid with the glyph slot in its own column", () => {
    const node = (
      <TreeRow current leading={<i data-glyph="" />} secondary="2m" trailing="12">
        Title
      </TreeRow>
    );
    const [row] = attributes(node, '[data-ui="TreeRow"]');
    expect(row).toMatchObject({ "aria-current": "true", "data-density": "double" });
    expect(row?.class?.split(" ")).toEqual(
      expect.arrayContaining([
        "grid",
        "min-h-11",
        "grid-cols-[1rem_1fr]",
        "gap-x-2",
        "gap-y-0.5",
        "px-2",
        "py-1.5",
      ]),
    );
    expect(attributes(node, '[data-ui="TreeRow"] > .row-span-2 > [data-glyph]')).toHaveLength(1);
    expect(classes(node, '[data-ui="TreeRow"] > .row-span-2')).toEqual(
      expect.arrayContaining(["size-4", "pt-1"]),
    );
    expect(textContent(node, '[data-ui="TreeRow"]')).toBe("Title122m");
    expect(textContent(node, "[data-secondary]")).toBe("2m");
    const [rest] = attributes(<TreeRow secondary="2m">Title</TreeRow>, '[data-ui="TreeRow"]');
    expect(rest?.["aria-current"]).toBeUndefined();
  });
  test("a leaf row keeps the 28px line and its level step", () => {
    const [row] = attributes(<TreeRow level={1}>Leaf</TreeRow>, '[data-ui="TreeRow"]');
    expect(row).toMatchObject({ "data-density": "single", "data-level": "1" });
    expect(row?.class?.split(" ")).toEqual(
      expect.arrayContaining(["h-7", "pr-2", "pl-[calc(var(--spacing-inset)+var(--spacing-indent))]"]),
    );
  });
});

describe("drawn primitive behavior", () => {
  test("gutter marks encode add, remove, context and anchor interaction", () => {
    const html = attributes(
      <>
        <GutterLine number={1} mark="add">
          a
        </GutterLine>
        <GutterLine number={2} mark="remove" anchored onAnchor={() => undefined}>
          b
        </GutterLine>
        <GutterLine number={3}>c</GutterLine>
      </>,
    );
    expect(html.some((element) => element["data-mark"] === "add")).toBe(true);
    expect(html.some((element) => element["data-mark-char"] === "remove")).toBe(true);
    expect(html.find((element) => element["aria-label"] === "line 2")?.["aria-pressed"]).toBe(
      "true",
    );
  });
  test("status shapes use distinct machine attributes", () => {
    const html = attributes(
      <>
        <StatusDot shape="pulse" tier="live" />
        <StatusDot shape="ring" tier="attention" />
        <StatusDot shape="slashed" tier="settled" />
      </>,
    );
    expect(html.flatMap((element) => element["data-status-dot"] ?? [])).toEqual([
      "running",
      "ring",
      "slashed",
    ]);
    expect(attributes(<StatusDot shape="slashed" tier="settled" />, "mask")).toHaveLength(1);
  });
  test("epoch rule is inert without destination and a button with one", () => {
    const inert = attributes(<EpochRule label="compacted" />);
    const jump = attributes(<EpochRule label="resumed" meta="3h" onJump={() => undefined} />);
    expect(inert.some((element) => "data-epoch-rule" in element)).toBe(true);
    expect(inert.some((element) => element.type === "button")).toBe(false);
    expect(jump.filter((element) => element.type === "button")).toHaveLength(1);
    expect(textContent(<EpochRule label="resumed" meta="3h" onJump={() => undefined} />, "button")).toBe("resumed3h");
  });
});

describe("history menu first paint", () => {
  test("empty and populated histories expose a closed menu trigger", () => {
    const empty = attributes(
      <HistoryMenu entries={[]} currentId={null} now={0} onJump={() => undefined} />,
    );
    const entries = Array.from({ length: 21 }, (_: undefined, i: number) => ({
      id: String(i),
      title: `t${i}`,
      at: 0,
    }));
    const html = attributes(
      <HistoryMenu entries={entries} currentId="20" now={0} onJump={() => undefined} />,
    );
    for (const markup of [empty, html]) {
      expect(markup.find((element) => element["aria-haspopup"] === "menu")?.["aria-expanded"]).toBe(
        "false",
      );
      expect(markup.filter((element) => element.role === "menuitem")).toEqual([]);
    }
  });
});

describe("sidebar context guard", () => {
  test("a primitive rendered outside <Sidebar> fails with the named class", () => {
    function Orphan() {
      useSidebar();
      return null;
    }
    expect(() => renderToStaticMarkup(<Orphan />)).toThrow(SidebarContextError);
  });
});
