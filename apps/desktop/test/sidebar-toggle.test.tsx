import { beforeEach, describe, expect, test } from "bun:test";
import {
  consoleStore,
  createSession,
  INITIAL_CLIENT_STATE,
  setSidebarFloating,
  toggleSidebar,
} from "../src/renderer/state/store";
import { renderShell, tag } from "./helpers";

/**
 * The sidebar toggle as the WINDOW renders it, from the store: one button in
 * the strip in every state, its ARIA telling the truth, and the hover reveal
 * rendering the same column as an overlay. No DOM: the contract is what each
 * store state renders TO.
 */
beforeEach(() => {
  consoleStore.setState(() => INITIAL_CLIENT_STATE);
});

const shell = () => renderShell(null);

describe("the one toggle", () => {
  test("Given the sidebar open, When rendered, Then the toggle leads the strip's zone and says it will collapse", () => {
    const html = shell();
    expect(html.match(/data-ui="Sidebar.Toggle"/g)).toHaveLength(1);
    const toggle = tag(html, "Sidebar.Toggle");
    expect(toggle).toContain('aria-label="Collapse sidebar"');
    expect(toggle).toContain('aria-expanded="true"');
    // Inside the strip's controls zone, before the history trio, above the nav.
    const zone = html.indexOf('data-ui="TabStrip.Controls"');
    expect(zone).toBeLessThan(html.indexOf('data-ui="Sidebar.Toggle"'));
    expect(html.indexOf('data-ui="Sidebar.Toggle"')).toBeLessThan(
      html.indexOf('aria-label="History"'),
    );
    expect(html.indexOf('data-ui="Sidebar.Toggle"')).toBeLessThan(
      html.indexOf('data-ui="Sidebar.Nav"'),
    );
    // No header row: the column starts with the nav, and the one search entry
    // point is the section header's toggle.
    expect(html).not.toContain('data-ui="Sidebar.Header"');
    expect(html).not.toContain('aria-label="Search (⌘K)"');
    expect(html.match(/data-ui="SectionHeader.Toggle"/g)).toHaveLength(1);
    // Pinned: the zone and the container ride the same runtime variable.
    expect(tag(html, "TabStrip.Controls")).toContain("w-(--sidebar-width)");
    expect(tag(html, "Sidebar.Container")).toContain("w-(--sidebar-width)");
    expect(html).not.toContain('aria-label="Expand sidebar"');
  });

  test("Given the sidebar collapsed, When rendered, Then the same toggle stays put and says it will expand", () => {
    toggleSidebar();
    const html = shell();
    expect(html.match(/data-ui="Sidebar.Toggle"/g)).toHaveLength(1);
    const toggle = tag(html, "Sidebar.Toggle");
    expect(toggle).toContain('aria-label="Expand sidebar"');
    expect(toggle).toContain('aria-expanded="false"');
    expect(html.indexOf('data-ui="Sidebar.Toggle"')).toBeLessThan(
      html.indexOf('aria-label="History"'),
    );
    expect(tag(html, "Sidebar.Container")).toContain('data-mode="hidden"');
    expect(html).toContain('data-ui="Sidebar.Edge"');
    expect(html).not.toContain('data-ui="Sidebar.ResizeHandle"');
  });

  test("Given the reveal floating, When rendered, Then the session tree renders once, as an overlay", () => {
    createSession(1);
    toggleSidebar();
    setSidebarFloating(true);
    const html = shell();
    const container = tag(html, "Sidebar.Container");
    expect(container).toContain('data-mode="overlay"');
    expect(container).toContain("rounded-panel");
    expect(container).toContain("shadow-panel");
    // One tree, one nav: the overlay IS the sidebar, not a copy of it.
    expect(html.match(/role="tree"/g)).toHaveLength(1);
    expect(html.match(/data-ui="Sidebar.Nav"/g)).toHaveLength(1);
    // Collapsed: the zone and the overlay share one width token.
    expect(container).toContain("w-sidebar-overlay");
    expect(tag(html, "TabStrip.Controls")).toContain("w-sidebar-overlay");
    expect(tag(html, "Sidebar.Content")).not.toContain("inert");
    expect(tag(html, "Sidebar")).toContain('data-sidebar-state="collapsed"');
  });

  test("Given each store state, When rendered, Then the glyph's bar reads the column's visibility while aria-expanded reads the pin", () => {
    const glyph = (html: string) => tag(html, "Sidebar.Toggle.Icon");
    expect(glyph(shell())).toContain('data-opened="true"');
    toggleSidebar();
    expect(glyph(shell())).toContain('data-opened="false"');
    setSidebarFloating(true);
    const revealed = shell();
    expect(glyph(revealed)).toContain('data-opened="true"');
    expect(tag(revealed, "Sidebar.Toggle")).toContain('aria-expanded="false"');
  });

  test("Given the strip, When rendered from the store, Then the trio closes the zone, right-aligned, at the 28px step", () => {
    const html = shell();
    const trio = tag(html, "TabStrip.Trio");
    expect(trio).toContain("ml-auto");
    expect(html.indexOf('data-ui="Sidebar.Toggle"')).toBeLessThan(
      html.indexOf('data-ui="TabStrip.Trio"'),
    );
    expect(tag(html, "Sidebar.Toggle")).toContain('data-size="base"');
    expect(tag(html, "TabStrip.Controls")).toContain("pl-strip-inset-darwin");
  });
});
