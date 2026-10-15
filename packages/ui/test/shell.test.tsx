import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { relativeTime } from "../src/history-menu";
import {
  clampSidebarWidth,
  createRevealIntent,
  type RevealTimers,
  SIDEBAR_REVEAL,
} from "../src/sidebar";
import { SectionHeader } from "../src/sidebar-nav";
import { TabStrip, type WindowPlatform } from "../src/tab-strip";
import { TreeRow } from "../src/tree-row";
import { Sidebar } from "../src/sidebar";
import { STRIP } from "./fixture";
import { SidebarFrame } from "./sidebar-frame";

/**
 * The frame's class-state contract, asserted on static markup: which classes
 * and attributes each sidebar state produces. The numbers are the reference console's
 * (docs/desktop-shell.md); the tests pin the ones a regression would move.
 */

function frame(
  open: boolean,
  children: ReactNode,
  platform: WindowPlatform = "darwin",
  floating = false,
) {
  return renderToStaticMarkup(
    <SidebarFrame floating={floating} open={open} platform={platform}>
      <Sidebar.Container>{children}</Sidebar.Container>
    </SidebarFrame>,
  );
}

/** The element carrying a `data-ui` name, as its opening tag. */
function tag(html: string, name: string): string {
  const match = html.match(new RegExp(`<[a-z]+[^>]*data-ui="${name.replace(".", "\\.")}"[^>]*>`));
  if (match === null) throw new Error(`no element named ${name}`);
  return match[0];
}

describe("the width clamp", () => {
  test("Given widths outside 224..330, When clamped, Then they land on the edges", () => {
    expect(clampSidebarWidth(100)).toBe(224);
    expect(clampSidebarWidth(400)).toBe(330);
  });

  test("Given a fractional width inside the range, When clamped, Then it is a whole pixel", () => {
    expect(clampSidebarWidth(250.4)).toBe(250);
    expect(clampSidebarWidth(250.6)).toBe(251);
  });
});

describe("the sidebar root", () => {
  test("Given an open sidebar, When rendered, Then the root states it and carries the width", () => {
    const root = tag(frame(true, null), "Sidebar");
    expect(root).toContain('data-sidebar-state="open"');
    expect(root).toContain("--sidebar-width:240px");
  });

  test("Given a collapsed sidebar, When rendered, Then the column is hidden, inert, and has no handle", () => {
    const html = frame(false, <p>rows</p>);
    expect(tag(html, "Sidebar")).toContain('data-sidebar-state="collapsed"');
    const container = tag(html, "Sidebar.Container");
    expect(container).toContain('data-mode="hidden"');
    expect(container).toContain("-translate-x-full");
    expect(tag(html, "Sidebar.Content")).toContain("inert");
    expect(html).not.toContain('data-ui="Sidebar.ResizeHandle"');
  });

  test("Given an open sidebar, When rendered, Then the column is pinned, live, and the handle is a focus stop", () => {
    const html = frame(true, <p>rows</p>);
    expect(tag(html, "Sidebar.Container")).toContain('data-mode="pinned"');
    expect(tag(html, "Sidebar.Content")).not.toContain("inert");
    expect(tag(html, "Sidebar.ResizeHandle")).toContain('tabindex="0"');
  });

  test("Given the three moving parts, When rendered, Then each animates its own property and yields to reduced motion", () => {
    const html = frame(true, null);
    const gap = tag(html, "Sidebar.Gap");
    const container = tag(html, "Sidebar.Container");
    const content = tag(html, "Sidebar.Content");
    expect(gap).toContain("transition-[width]");
    expect(gap).toContain("group-data-[sidebar-state=collapsed]/sidebar:w-0");
    expect(container).toContain("transition-[translate,inset,width,border-radius,box-shadow]");
    expect(content).toContain("transition-[opacity,translate]");
    expect(content).toContain("delay-[40ms]");
    // The measured scale: the frame slides on `base`, the column fades on `fast`.
    expect(gap).toContain("duration-base");
    expect(container).toContain("duration-base");
    expect(content).toContain("duration-fast");
    for (const part of [gap, container, content]) {
      expect(part).toContain("ease-frame");
      expect(part).toContain("motion-reduce:transition-none");
      expect(part).toContain("group-data-[resizing]/sidebar:duration-0");
    }
  });
});

describe("the hover reveal", () => {
  test("Given a collapsed sidebar, When rendered, Then an 8px edge zone listens and the column is hidden", () => {
    const html = frame(false, <p>rows</p>);
    expect(tag(html, "Sidebar.Edge")).toContain("w-2");
    expect(tag(html, "Sidebar.Edge")).toContain("top-(--shell-top)");
    expect(tag(html, "Sidebar.Container")).toContain('data-mode="hidden"');
  });

  test("Given an open sidebar, When rendered, Then there is no edge zone", () => {
    expect(frame(true, null)).not.toContain('data-ui="Sidebar.Edge"');
  });

  test("Given a collapsed sidebar that is floating, When rendered, Then the SAME column is an inset, raised overlay", () => {
    const html = frame(false, <p data-ui="Rows">rows</p>, "darwin", true);
    const container = tag(html, "Sidebar.Container");
    expect(container).toContain('data-mode="overlay"');
    expect(container).toContain("left-2 bottom-2");
    expect(container).toContain("top-[calc(var(--shell-top)+--spacing(2))]");
    expect(container).toContain("rounded-panel");
    expect(container).toContain("shadow-panel");
    expect(container).toContain("z-(--z-drawer)");
    // The overlay's width is the strip's collapsed zone's width: one token.
    expect(container).toContain("w-sidebar-overlay");
    expect(container).not.toContain("w-(--sidebar-width)");
    expect(tag(html, "TabStrip.Controls")).toContain("w-sidebar-overlay");
    expect(container).not.toContain("-translate-x-full");
    // Live: the rows are reachable and there is exactly one of them.
    expect(tag(html, "Sidebar.Content")).not.toContain("inert");
    expect(html.match(/data-ui="Rows"/g)).toHaveLength(1);
    // Floating, not pinned: the gap stays closed and the handle stays away.
    expect(tag(html, "Sidebar")).toContain('data-sidebar-state="collapsed"');
    expect(html).not.toContain('data-ui="Sidebar.ResizeHandle"');
  });

  test("Given an open sidebar, When `floating` is also set, Then pinned wins", () => {
    expect(tag(frame(true, null, "darwin", true), "Sidebar.Container")).toContain(
      'data-mode="pinned"',
    );
  });

  test("Given the overlay and the pinned column, When compared, Then the ONE box morphs: inset, radius, shadow, and width transition on the frame's curve, opaque in both, and neither starts from zero width", () => {
    const overlay = tag(frame(false, null, "darwin", true), "Sidebar.Container");
    const pinned = tag(frame(true, null), "Sidebar.Container");
    for (const box of [overlay, pinned]) {
      // The morph is a CSS transition on the same node: every property that
      // differs between the two modes is in the list, on the frame's duration.
      expect(box).toContain("transition-[translate,inset,width,border-radius,box-shadow]");
      expect(box).toContain("duration-base");
      expect(box).toContain("ease-frame");
      // Both are fixed boxes with the sunken ground: nothing shows through mid-morph.
      expect(box).toMatch(/(^|[\s"])fixed([\s"]|$)/);
      expect(box).toContain("bg-sunken");
      // The column never grows from nothing: no zero width in either mode.
      expect(box).not.toMatch(/(^|[\s"])w-0([\s"]|$)/);
    }
    // The two ends of the glide: the overlay's inset and radius, the column's flush edge.
    expect(overlay).toContain("left-2");
    expect(overlay).toContain("rounded-panel");
    expect(pinned).toContain("left-0");
    expect(pinned).not.toContain("rounded-panel");
    expect(pinned).not.toContain("shadow-panel");
  });
});

/** A clock the test advances by hand: every scheduled callback and when it is due. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; run: () => void }>();
  const timers: RevealTimers<number> = {
    setTimeout: (callback, ms) => {
      const id = nextId++;
      pending.set(id, { at: now + ms, run: callback });
      return id;
    },
    clearTimeout: (handle) => {
      pending.delete(handle);
    },
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (const [id, timer] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > until) break;
      pending.delete(id);
      now = timer.at;
      timer.run();
    }
    now = until;
  };
  return { timers, advance, pendingCount: () => pending.size };
}

describe("the reveal's timing", () => {
  function harness() {
    const clock = fakeClock();
    const log: boolean[] = [];
    let floating = false;
    const intent = createRevealIntent(
      () => floating,
      (value) => {
        floating = value;
        log.push(value);
      },
      clock.timers,
    );
    return { ...clock, intent, log, shown: () => floating };
  }

  test("Given the pointer rests on a hot zone, When the open delay passes, Then it opens once", () => {
    const h = harness();
    h.intent.enter();
    h.advance(SIDEBAR_REVEAL.openDelay - 1);
    expect(h.log).toEqual([]);
    h.advance(1);
    expect(h.log).toEqual([true]);
    h.intent.enter();
    h.advance(1000);
    expect(h.log).toEqual([true]);
  });

  test("Given the pointer leaves before the delay, When time passes, Then nothing opens", () => {
    const h = harness();
    h.intent.enter();
    h.advance(SIDEBAR_REVEAL.openDelay - 50);
    h.intent.leave();
    h.advance(1000);
    expect(h.log).toEqual([]);
    expect(h.pendingCount()).toBe(0);
  });

  test("Given it is shown, When the pointer leaves for the close delay, Then it closes", () => {
    const h = harness();
    h.intent.enter();
    h.advance(SIDEBAR_REVEAL.openDelay);
    h.intent.leave();
    h.advance(SIDEBAR_REVEAL.closeDelay - 1);
    expect(h.shown()).toBe(true);
    h.advance(1);
    expect(h.log).toEqual([true, false]);
  });

  test("Given it is shown, When the pointer hops from the toggle into the panel, Then the close is cancelled", () => {
    const h = harness();
    h.intent.enter();
    h.advance(SIDEBAR_REVEAL.openDelay);
    h.intent.leave();
    h.advance(SIDEBAR_REVEAL.closeDelay - 100);
    h.intent.enter();
    h.advance(1000);
    expect(h.log).toEqual([true]);
    expect(h.pendingCount()).toBe(0);
  });

  test("Given a pending open or close, When cancelled, Then neither fires", () => {
    const h = harness();
    h.intent.enter();
    h.intent.cancel();
    h.advance(1000);
    expect(h.log).toEqual([]);
    h.intent.enter();
    h.advance(SIDEBAR_REVEAL.openDelay);
    h.intent.leave();
    h.intent.cancel();
    h.advance(1000);
    expect(h.log).toEqual([true]);
    expect(h.pendingCount()).toBe(0);
  });
});

describe("the tab strip's controls zone", () => {
  /** The toggle's opening tag: the one element named `Sidebar.Toggle`. */
  const toggle = (html: string) => tag(html, "Sidebar.Toggle");

  test("Given an open sidebar, When rendered, Then the zone is the sidebar's width and leads with the one toggle", () => {
    const html = frame(true, null);
    const zone = tag(html, "TabStrip.Controls");
    expect(zone).toContain("w-(--sidebar-width)");
    expect(zone).toContain("pl-strip-inset-darwin");
    expect(zone).toContain("pr-3");
    expect(zone).toContain("gap-1");
    expect(html.match(/data-ui="Sidebar.Toggle"/g)).toHaveLength(1);
    expect(toggle(html)).toContain('aria-label="Collapse sidebar"');
    expect(toggle(html)).toContain('aria-expanded="true"');
    expect(html.indexOf('data-ui="Sidebar.Toggle"')).toBeLessThan(
      html.indexOf('aria-label="History"'),
    );
    expect(html.indexOf('aria-label="History"')).toBeLessThan(html.indexOf('aria-label="Back"'));
    expect(html.indexOf('aria-label="Back"')).toBeLessThan(html.indexOf('aria-label="Forward"'));
  });

  test("Given the zone, When rendered, Then the trio is its last child, pushed to the sidebar's edge by `ml-auto`", () => {
    const html = frame(true, null);
    const zone = html.slice(
      html.indexOf('data-ui="TabStrip.Controls"'),
      html.indexOf('data-ui="TabStrip.List"'),
    );
    // Children in order: toggle, trio — and nothing after the trio's closing tag.
    const toggleAt = zone.indexOf('data-ui="Sidebar.Toggle"');
    const trioAt = zone.indexOf('data-ui="TabStrip.Trio"');
    expect(toggleAt).toBeGreaterThan(0);
    expect(trioAt).toBeGreaterThan(toggleAt);
    const trio = tag(html, "TabStrip.Trio");
    expect(trio).toContain("ml-auto");
    expect(trio).toContain("gap-1");
    // No motion of its own: it slides with the zone's width and never fades.
    expect(trio).not.toMatch(/opacity|invisible|transition|data-collapsed/);
    expect(tag(frame(false, null), "TabStrip.Trio")).not.toMatch(/opacity|invisible|transition/);
    expect(
      zone.slice(trioAt + 1).match(/data-ui="(?!IconButton|Sidebar\.Toggle\.Icon)[^"]+"/g),
    ).toBeNull();
  });

  test("Given the strip's four controls, When rendered, Then each is the 28px `base` step and the toggle paints no hover fill", () => {
    const html = frame(true, null);
    expect(toggle(html)).toContain('data-size="base"');
    expect(toggle(html)).toContain('data-variant="plain"');
    expect(toggle(html)).not.toContain("hover:bg-hover");
    for (const label of ["History", "Back", "Forward"]) {
      const button = html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0];
      expect(button).toContain('data-size="base"');
      expect(button).toContain("hover:bg-hover");
    }
  });

  test("Given the toggle's glyph, When the column is pinned, hidden, or revealed, Then the bar's width reads 4.5 / 1.5 / 4.5", () => {
    const icon = (html: string) => {
      const start = html.indexOf('data-ui="Sidebar.Toggle.Icon"');
      return html.slice(start, html.indexOf("</svg>", start));
    };
    expect(icon(frame(true, null))).toContain('width="4.5"');
    expect(icon(frame(false, null))).toContain('width="1.5"');
    expect(icon(frame(false, null, "darwin", true))).toContain('width="4.5"');
    expect(icon(frame(false, null))).toContain('x="4" y="5"');
    expect(icon(frame(false, null))).toContain('height="6" rx="0.75"');
  });

  test("Given a collapsed sidebar on darwin, When rendered, Then the zone clears the traffic lights, is as wide as the overlay, and the same toggle leads it", () => {
    const html = frame(false, null);
    const zone = tag(html, "TabStrip.Controls");
    expect(zone).toContain("pl-strip-inset-darwin");
    expect(zone).toContain("w-sidebar-overlay");
    expect(zone).not.toContain("w-(--sidebar-width)");
    expect(html.match(/data-ui="Sidebar.Toggle"/g)).toHaveLength(1);
    expect(toggle(html)).toContain('aria-label="Expand sidebar"');
    expect(toggle(html)).toContain('aria-expanded="false"');
    expect(html.indexOf('data-ui="Sidebar.Toggle"')).toBeLessThan(
      html.indexOf('aria-label="History"'),
    );
  });

  test("Given a floating reveal, When rendered, Then the toggle still reads as the collapsed state it would pin", () => {
    const html = frame(false, null, "darwin", true);
    expect(toggle(html)).toContain('aria-label="Expand sidebar"');
    expect(toggle(html)).toContain('aria-expanded="false"');
  });

  test("Given a collapsed sidebar elsewhere, When rendered, Then the zone starts at the window edge", () => {
    const zone = tag(frame(false, null, "other"), "TabStrip.Controls");
    expect(zone).toContain("w-sidebar-overlay");
    expect(zone).not.toContain("pl-strip-inset-darwin");
  });

  test("Given the zone, When rendered, Then it animates width on the frame's curve and yields to reduced motion", () => {
    const zone = tag(frame(true, null), "TabStrip.Controls");
    expect(zone).toContain("transition-[width]");
    expect(zone).toContain("duration-base");
    expect(zone).toContain("ease-frame");
    expect(zone).toContain("motion-reduce:transition-none");
    expect(zone).toContain("group-data-[resizing]/sidebar:duration-0");
  });

  test("Given no title, When rendered, Then no tab is drawn but the create control is", () => {
    const html = frame(true, null);
    expect(html).not.toContain('data-ui="Tab"');
    expect(html).toContain('aria-label="New"');
  });

  test("Given a title, When rendered, Then the tab is a 26px card with no status mark", () => {
    const html = renderToStaticMarkup(
      <Sidebar
        floating={false}
        onFloatingChange={() => undefined}
        onToggle={() => undefined}
        onWidthCommit={() => undefined}
        open
        width={240}
      >
        <TabStrip
          {...STRIP}
          createLabel="New"
          history={STRIP.history}
          onCreate={() => undefined}
          platform="darwin"
          tabs={[{ id: "a", title: "ledger", icon: <svg aria-hidden="true" />, active: true }]}
        />
      </Sidebar>,
    );
    const tab = tag(html, "Tab");
    expect(tab).toContain("h-tab-height");
    expect(tab).toContain("min-w-24");
    expect(tab).toContain("max-w-56");
    expect(tab).toContain("rounded-card");
    expect(html).not.toContain('data-ui="StatusDot"');
  });

  test("Given a history at its ends, When rendered, Then back and forward are disabled", () => {
    const html = frame(true, null);
    expect(html).toMatch(/aria-label="Back"[^>]*disabled/);
    expect(html).toMatch(/aria-label="Forward"[^>]*disabled/);
  });
});

describe("the section header", () => {
  const rest = renderToStaticMarkup(
    <SectionHeader
      label="Sessions"
      onSearchingChange={() => undefined}
      searchLabel="Search sessions"
      searching={false}
    >
      <input />
    </SectionHeader>,
  );
  const searching = renderToStaticMarkup(
    <SectionHeader
      label="Sessions"
      onSearchingChange={() => undefined}
      resultLabel="2 results"
      searchLabel="Search sessions"
      searching
    >
      <input />
    </SectionHeader>,
  );

  test("Given a section at rest, When rendered, Then it is a 32px row with the label on the text x and a search toggle", () => {
    expect(rest).toContain("h-8");
    expect(rest).toContain("pl-4");
    expect(rest).toContain("Sessions");
    expect(rest).toContain('aria-label="Search sessions"');
    expect(rest).not.toContain("<input");
  });

  test("Given a searching section, When rendered, Then the field replaces the label, the inset tightens, and the toggle closes", () => {
    expect(searching).toContain("<input");
    expect(searching).not.toContain(">Sessions<");
    expect(searching).toContain("pl-2");
    expect(searching).toContain('aria-label="Close search"');
    expect(searching).toContain("2 results");
  });
});

describe("a tree row", () => {
  test("Given each level, When rendered, Then the depth is an attribute and a padding step", () => {
    expect(renderToStaticMarkup(<TreeRow level={0}>a</TreeRow>)).toContain('data-level="0"');
    const one = renderToStaticMarkup(<TreeRow level={1}>a</TreeRow>);
    expect(one).toContain('data-level="1"');
    expect(one).toContain("var(--spacing-indent))]");
    expect(renderToStaticMarkup(<TreeRow level={2}>a</TreeRow>)).toContain(
      "var(--spacing-indent)*2)]",
    );
  });

  test("Given a row, When rendered, Then it is one 28px line with no mark or connector", () => {
    const html = renderToStaticMarkup(<TreeRow>a very long session title</TreeRow>);
    expect(html).toContain("h-7");
    expect(html).toContain("truncate");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("StatusDot");
  });

  test("Given the current row, When rendered, Then it says so and takes the raised fill", () => {
    const html = renderToStaticMarkup(<TreeRow current>a</TreeRow>);
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("bg-raised");
  });

  test("Given a group row, When rendered, Then it reads as a heading, not a sibling", () => {
    // The group name is a boundary the eye reads only when it wants one: meta
    // size, faint tone, a shorter line, and never a fill of its own.
    const html = renderToStaticMarkup(<TreeRow expanded>a</TreeRow>);
    expect(html).toContain("text-meta");
    expect(html).toContain("text-fg-faint");
    expect(html).toContain("h-6");
    expect(html).not.toContain("h-7");
    expect(html).not.toContain("bg-raised");
    expect(html).not.toContain("hover:bg-hover");
    const leaf = renderToStaticMarkup(<TreeRow>a</TreeRow>);
    expect(leaf).toContain("text-label");
    expect(leaf).not.toContain("text-fg-faint");
  });

  test("Given a group row, When rendered, Then only it carries the chevron and its state", () => {
    const html = renderToStaticMarkup(<TreeRow expanded>a</TreeRow>);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("<svg");
    expect(html).toContain("rotate-90");
  });
});

describe("history time", () => {
  test("Given elapsed spans, When formatted, Then the coarsest whole unit is used", () => {
    const now = 1_000_000_000;
    expect(relativeTime(now, now)).toBe("now");
    expect(relativeTime(now - 59_000, now)).toBe("now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d");
  });

  test("Given a clock behind the entry, When formatted, Then it never goes negative", () => {
    expect(relativeTime(10, 0)).toBe("now");
  });
});
