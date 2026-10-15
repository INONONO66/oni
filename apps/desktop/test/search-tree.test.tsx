import { describe, expect, test } from "bun:test";
import { Highlight } from "@openomni/ui";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { ATTENTION_LABEL, orderByAttention } from "../src/renderer/attention/order";
import { SessionTree } from "../src/renderer/shell/session-tree";
import type { Session } from "../src/renderer/state/store";
import { makeSession } from "./helpers/session";
import "./helpers/platform";

/**
 * The rendered wiring between the search field and the tree it filters.
 *
 * `aria-controls` and `aria-activedescendant` are the two facts a screen reader
 * uses to follow the field, and both fail SILENTLY: a mismatched id announces
 * nothing while looking perfect in every screenshot. So the ids are asserted to
 * agree with the rows that actually rendered, rather than to match a literal.
 *
 * Behavior driven by real key events is covered by search-keyboard.test.ts (the
 * reducer).
 */
const sessions: readonly Session[] = [
  makeSession({
    id: "s1",
    title: "ledger append path",
    titleSource: "prompt",
    projectId: "kernel",
    createdAt: 1,
  }),
  makeSession({ id: "s2", title: "lease semantics", projectId: "kernel", createdAt: 2 }),
  makeSession({ id: "s3", title: "sync engine", projectId: "perimeter", createdAt: 3 }),
];
const selectedId = "s2";

const ordered = orderByAttention(sessions, 10);

const html = renderToStaticMarkup(
  <SessionTree
    collapsedProjectIds={new Set()}
    defaultSearching
    onNavigate={() => undefined}
    onSelect={() => undefined}
    onToggleProject={() => undefined}
    now={10}
    ordered={ordered}
    pendingChanges={0}
    route="sessions"
    selectedId={selectedId}
    sessions={sessions}
  />,
);

describe("attention kind headers disambiguate repeated projects", () => {
  test("mixed kinds show non-collapsible labels above each project group", () => {
    const mixed = [
      makeSession({ id: "waiting", phase: "waiting_input", projectId: "default" }),
      makeSession({ id: "running", phase: "running", projectId: "default" }),
      makeSession({ id: "rest", phase: "idle", projectId: "default" }),
    ];
    const mixedHtml = renderToStaticMarkup(
      <SessionTree
        collapsedProjectIds={new Set()}
        onNavigate={() => undefined}
        onSelect={() => undefined}
        onToggleProject={() => undefined}
        now={10}
        ordered={orderByAttention(mixed, 10)}
        pendingChanges={0}
        route="sessions"
        selectedId={null}
        sessions={mixed}
      />,
    );
    const document = new Window().document;
    document.body.innerHTML = mixedHtml;
    const groups = [...document.querySelectorAll('[role="tree"] > div')];
    expect(groups).toHaveLength(3);
    expect(groups.map((group) => group.firstElementChild?.textContent)).toEqual([
      ATTENTION_LABEL.demand,
      ATTENTION_LABEL.watch,
      ATTENTION_LABEL.rest,
    ]);
    for (const group of groups) {
      const header = group.firstElementChild;
      expect(header?.tagName).toBe("SPAN");
      expect(header?.classList.contains("text-meta")).toBe(true);
      expect(header?.classList.contains("text-fg-faint")).toBe(true);
      expect(header?.hasAttribute("aria-expanded")).toBe(false);
      expect(header?.nextElementSibling?.getAttribute("data-level")).toBe("0");
      expect(group.querySelectorAll('[data-ui="TreeRow"]')).toHaveLength(2);
    }
  });

  test("rest-only sessions keep the plain project tree without a kind label", () => {
    expect(html).not.toContain(`>${ATTENTION_LABEL.rest}</span>`);
    expect(html.match(/data-ui="TreeRow"/g)).toHaveLength(5);
  });
});

describe("the field is wired to the tree it filters", () => {
  test("Given the sidebar, When rendered, Then the field is a combobox over a real element", () => {
    const controls = /aria-controls="([^"]+)"/.exec(html)?.[1];

    expect(html).toContain('role="combobox"');
    expect(controls).toBeDefined();
    // The target must EXIST — an aria-controls pointing at nothing is silent.
    expect(html).toContain(`id="${controls}"`);
  });

  test("Given the sidebar, When rendered, Then it is labelled for a screen reader", () => {
    expect(html).toContain("Search sessions");
  });

  test("Given every session row, When rendered, Then each carries the id the field can point at", () => {
    // The reserved shape: `aria-activedescendant` is set from the same helper,
    // so a row missing its id is a row the field can never announce.
    for (const session of sessions) expect(html).toContain(`id="session-row-${session.id}"`);
  });

  test("Given the rows, When rendered, Then they are options inside the controlled element", () => {
    expect(html.match(/id="session-row-/g)).toHaveLength(sessions.length);
  });

  test("Given no active row, When rendered, Then the field points at nothing", () => {
    // A stale activedescendant is worse than none: it announces a row the
    // operator is not on.
    expect(html).not.toContain("aria-activedescendant");
    expect(html.match(/aria-selected="true"/g)).toBeNull();
  });

  test("Given the field open with no query, When rendered, Then there is no count", () => {
    expect(html).not.toContain("results");
    expect(html).not.toContain("no sessions match");
  });
});

describe("the tree still reads as a tree under the search field", () => {
  test("Given the sidebar, When rendered, Then groups are headings and rows sit flush under them", () => {
    // The project row reads as a heading (`aria-expanded`), the sessions as
    // the list under it — depth is stated by the heading, not by an indent.
    const levels = [...html.matchAll(/data-level="(\d)"/g)].map((hit) => Number(hit[1]));
    const projects = ordered.groups.flatMap((kind) => kind.projects).length;

    expect(levels).toHaveLength(projects + sessions.length);
    expect(levels.every((level) => level === 0)).toBe(true);
    expect(html.match(/aria-expanded="(true|false)"[^>]*role="treeitem"/g)).toHaveLength(
      projects,
    );
  });

  test("Given a selection, When rendered, Then exactly one row is current", () => {
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
  });

  test("Given every row, When rendered, Then its title survives the highlight split", () => {
    // At rest there are no matched glyphs, so each title must render as ONE
    // unweighted run — a split label would show as the same text with a seam.
    for (const session of sessions) expect(html).toContain(`>${session.title}</span>`);
  });

  test("Given the field at rest, When rendered, Then no glyph run is emphasised", () => {
    // A weighted RUN at rest would mean the highlight fires with no query,
    // which is how a highlight becomes decoration. The selected row's own
    // `font-medium` is selection and stays — so this looks at the run spans
    // only, which are the exact elements the highlight owns.
    expect(html).not.toContain('<span class="font-medium text-fg">');
  });

  test("Given no query, When rendered, Then the selected row keeps the primary tone", () => {
    // At rest there is nothing to separate, so the selected row reads at full
    // strength. The muting is a filtering treatment, not the resting one.
    const selected = sessions.find((session) => session.id === selectedId)?.title ?? "";
    const highlight = /<span class="([^"]*)" data-ui="Highlight"><span class="([^"]*)">([^<]*)</g;
    const labels = [...html.matchAll(highlight)].map((match) => ({
      tone: match[1] ?? "",
      run: match[2] ?? "",
      text: match[3] ?? "",
    }));

    const row = labels.find((label) => label.text === selected);
    expect(row, `no Highlight rendered for the selected row "${selected}"`).toBeDefined();
    expect(row?.tone).toContain("text-fg");
    expect(row?.tone).not.toContain("text-fg-muted");
    expect(row?.run).toBe("font-normal");
  });

  test("Given a match, When the same span markup is produced, Then this test would see it", () => {
    // Guards the assertion above against passing vacuously: if the highlight's
    // emitted class string ever changes, the negative check must stop matching
    // the real thing, and this catches that instead of going quietly green.
    const emphasised = renderToStaticMarkup(<Highlight runs={[{ text: "led", matched: true }]} />);

    expect(emphasised).toContain('<span class="font-medium text-fg">');
  });
});
