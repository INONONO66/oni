import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { attributes, classes } from "./markup";
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
  SidebarNav,
  SidebarSection,
} from "../src/sidebar-nav";

describe("sidebar navigation controls", () => {
  test("renders active and inactive destinations with accessible state", () => {
    const html = attributes(
      <SidebarNav>
        <NavItem active icon={<svg aria-hidden="true" />}>
          One
        </NavItem>
        <NavItem icon={<svg aria-hidden="true" />}>Two</NavItem>
      </SidebarNav>,
    );
    const items = html.filter((element) => element["data-ui"] === "NavItem");
    expect(items).toHaveLength(2);
    expect(items.map((item) => item["aria-current"])).toEqual(["page", undefined]);
    expect(items[1]?.class?.split(" ")).toContain("text-fg-muted");
  });
  test("header toggles search semantics and result announcement", () => {
    const closed = attributes(
      <SectionHeader
        label="Projects"
        searching={false}
        onSearchingChange={() => undefined}
        searchLabel="Search projects"
        resultLabel="2 results"
      />,
    );
    const open = attributes(
      <SectionHeader
        label="Projects"
        searching
        onSearchingChange={() => undefined}
        searchLabel="Search projects"
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
      </SectionHeader>,
    );
    expect(closed.some((element) => "data-searching" in element)).toBe(false);
    expect(closed.some((element) => element["aria-live"] === "polite")).toBe(true);
    expect(open.find((element) => element.role === "combobox")).toMatchObject({
      "aria-expanded": "true",
      "aria-controls": "results",
      "aria-activedescendant": "row-1",
    });
  });
  test("section and footer preserve their structural slots", () => {
    const html = attributes(
      <SidebarSection>
        <SidebarFooter>footer</SidebarFooter>
      </SidebarSection>,
    );
    const footer = html.find((element) => element["data-ui"] === "Sidebar.Footer");
    expect(footer?.class?.split(" ")).toContain("border-line");
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
    expect(classes(<StatusDot shape="pulse" tier="live" />)).toContain("text-accent");
    expect(attributes(<StatusDot shape="slashed" tier="settled" />, "mask")).toHaveLength(1);
  });
  test("epoch rule is inert without destination and a button with one", () => {
    const inert = attributes(<EpochRule label="compacted" />);
    const jump = attributes(<EpochRule label="resumed" meta="3h" onJump={() => undefined} />);
    expect(inert.some((element) => "data-epoch-rule" in element)).toBe(true);
    expect(inert.some((element) => element.type === "button")).toBe(false);
    expect(jump.filter((element) => element.type === "button")).toHaveLength(1);
    expect(jump.some((element) => element.class?.split(" ").includes("tabular-nums"))).toBe(true);
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
