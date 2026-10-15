import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { orderByAttention } from "../src/renderer/attention";
import { SessionTree } from "../src/renderer/shell/session-tree";
import type { Session } from "../src/renderer/state/store";
import { makeSession } from "./helpers/session";
import "./helpers/platform";

/**
 * The tree's render contract over store sessions: PROJECT → SESSION, exactly
 * one row marked current, and an honest sentence when there is nothing to list.
 *
 * The click/keydown handlers are exercised in visual QA — there is no DOM test
 * runner here — and the store's own transitions are covered by store.test.ts.
 */
const sessions: readonly Session[] = [
  makeSession({ id: "s1", title: "Session 1", projectId: "default", createdAt: 1 }),
  makeSession({ id: "s2", title: "Session 2", projectId: "default", createdAt: 2 }),
  makeSession({ id: "s3", title: "Session 3", projectId: "other", createdAt: 3 }),
];

const ordered = orderByAttention(sessions, 10);

const tree = (
  selectedId: string | null,
  list: readonly Session[] = sessions,
  options: { pendingChanges?: number; collapsed?: ReadonlySet<string | null> } = {},
) =>
  renderToStaticMarkup(
    <SessionTree
      collapsedProjectIds={options.collapsed ?? new Set()}
      onNavigate={() => undefined}
      onSelect={() => undefined}
      onToggleProject={() => undefined}
      now={10}
      ordered={orderByAttention(list, 10)}
      pendingChanges={options.pendingChanges ?? 0}
      route="sessions"
      selectedId={selectedId}
      sessions={list}
    />,
  );

describe("the sidebar marks exactly one selected row", () => {
  test("Given a selection, When the tree renders, Then one row is marked current", () => {
    expect(tree("s1").match(/aria-current="true"/g)).toHaveLength(1);
  });

  test("Given a different selection, When the tree renders, Then the marker moves", () => {
    const html = tree("s3");

    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toMatch(
      /id="session-row-s3"[^>]*aria-current="true"|aria-current="true"[^>]*id="session-row-s3"/,
    );
  });

  test("Given no selection, When the tree renders, Then no row is marked", () => {
    expect(tree(null).match(/aria-current="true"/g)).toBeNull();
  });
});

describe("the sidebar is project groups over sessions", () => {
  const html = tree("s1");

  test("Given the ordered groups, When the tree renders, Then every project is a disclosure header", () => {
    for (const group of ordered.groups.flatMap((kind) => kind.projects))
      expect(html).toContain(group.id ?? "no project");
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(
      ordered.groups.flatMap((kind) => kind.projects).length,
    );
  });

  test("Given every row, When the tree renders, Then it is one line: the title", () => {
    for (const session of sessions) expect(html).toContain(`>${session.title}</span>`);
    expect(html.match(/id="session-row-/g)).toHaveLength(sessions.length);
    // No second line and no status cell: nothing real fills either yet.
    expect(html).not.toContain("data-status-dot");
  });

  test("Given a collapsed project, When the tree renders, Then its rows are absent from the tree", () => {
    const collapsed = tree("s1", sessions, { collapsed: new Set(["other"]) });

    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed).not.toContain("Session 3");
    expect(collapsed).toContain("Session 1");
  });

  test("Given no pending drift, When the tree renders, Then no change hint is shown", () => {
    expect(html).not.toContain("changes");
  });

  test("Given pending drift, When the tree renders, Then the hint reports the count", () => {
    expect(tree("s1", sessions, { pendingChanges: 3 })).toContain("3 changes");
  });
});

describe("the empty sidebar says so", () => {
  test("Given no sessions, When the tree renders, Then the sentence names the way out and no group is drawn", () => {
    const html = tree(null, []);

    expect(html).toContain("No sessions yet");
    expect(html).not.toContain('data-ui="Disclosure"');
    expect(html).not.toContain('id="session-row-');
    // The sentence names the way out: the `+` in the tab strip.
    expect(html).toContain("press +");
  });
});
