import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type Document, type Element, Window } from "happy-dom";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { orderByAttention } from "../src/renderer/attention/order";
import { formatRelative } from "../src/renderer/attention/reason";
import { selectChatTransport } from "../src/renderer/chat/select-transport";
import { SessionTree } from "../src/renderer/shell/session-tree";
import { queryKeys } from "../src/renderer/state/queries";
import type { Session } from "../src/renderer/state/store";
import { mountWindow } from "./helpers";
import { TEST_NOW } from "./helpers/platform";
import { makeSession } from "./helpers/session";
import type { GatewayEndpoint } from "../src/preload/api";

/**
 * What the sidebar's rows CONTAIN: the nav's leading "New session" row, the
 * count beside a project, the glyph and the clock on a session row, and the
 * footer's one line about the gateway. Each is asserted on the slot it lands
 * in, because a right value in the wrong slot looks fine in a screenshot and
 * reads wrong to a screen reader. The footer row's height is derived from its
 * classes at shell density, because the static DOM carries no layout:
 * p-1.5 (6 + 6) + leading-4 (16) + text-meta (11 × 1.3 = 14.3) = 42.3px; the
 * 24px glyph slot is the shorter flex item and never drives the height.
 */
const sessions: readonly Session[] = [
  makeSession({ id: "s1", title: "ledger append path", projectId: "kernel", createdAt: 1 }),
  makeSession({
    id: "s2",
    title: "lease semantics",
    projectId: "kernel",
    createdAt: TEST_NOW - 120_000,
  }),
  makeSession({ id: "s3", title: "sync engine", projectId: "perimeter", createdAt: 3 }),
];

const NAV_ITEM = '[data-ui="Sidebar.Nav"] [data-ui="NavItem"]';

function tree(onCreate: () => void = () => undefined, list: readonly Session[] = sessions) {
  return (
    <SessionTree
      collapsedProjectIds={new Set()}
      now={TEST_NOW}
      onCreate={onCreate}
      onNavigate={() => undefined}
      onSelect={() => undefined}
      onToggleProject={() => undefined}
      ordered={orderByAttention(list, TEST_NOW)}
      pendingChanges={0}
      route="sessions"
      selectedId={null}
      sessions={list}
    />
  );
}

/** The sidebar's static markup, parsed; `endpoint` seeds the real query cache, `"pending"` leaves it in flight. */
function render(endpoint: GatewayEndpoint | null | "pending" = "pending") {
  const client = new QueryClient();
  if (endpoint !== "pending") client.setQueryData(queryKeys.gatewayEndpoint, endpoint);
  const document = new Window().document;
  document.body.innerHTML = renderToStaticMarkup(
    <QueryClientProvider client={client}>{tree()}</QueryClientProvider>,
  );
  return document;
}

function element(root: Document | Element, selector: string): Element {
  const found = root.querySelector(selector);
  if (found === null) throw new Error(`no element matches ${selector}`);
  return found;
}

describe("the nav leads with a way to start", () => {
  test("Given the nav, When rendered, Then the rows read New session, Sessions, Automations, Ingress ledger", () => {
    const document = render();
    const items = [...document.querySelectorAll(NAV_ITEM)];
    expect(items.map((item) => item.textContent)).toEqual([
      "New session",
      "Sessions",
      "Automations",
      "Ingress ledger",
    ]);
    // Starting is an action, not a place: the row is never the current page, even on the Sessions route.
    expect(items[0]?.hasAttribute("aria-current")).toBe(false);
    expect(items[1]?.getAttribute("aria-current")).toBe("page");
    expect(items[0]?.querySelector("svg")).not.toBeNull();
  });

  test("Given the New session row, When clicked, Then onCreate is called exactly once", async () => {
    const window = new Window({ url: "http://localhost" });
    const { host, restoreGlobals, root } = mountWindow(window);
    const client = new QueryClient();
    client.setQueryData(queryKeys.gatewayEndpoint, null);
    let created = 0;
    try {
      await act(() =>
        root.render(
          <QueryClientProvider client={client}>
            {tree(() => {
              created++;
            })}
          </QueryClientProvider>,
        ),
      );
      const first = host.querySelector<HTMLButtonElement>(NAV_ITEM);
      if (first === null) throw new Error(`no element matches ${NAV_ITEM}`);
      expect(first.textContent).toBe("New session");
      await act(() => first.click());
      expect(created).toBe(1);
    } finally {
      await act(() => root.unmount());
      host.remove();
      restoreGlobals();
      await window.happyDOM.close();
    }
  });
});

describe("a project row counts its sessions", () => {
  test("Given a group of two, When rendered, Then the trailing slot reads 2", () => {
    const document = render();
    const groups = [...document.querySelectorAll('[role="treeitem"][aria-expanded]')];
    // Label then count, as the row's last two children: the count sits beside the name.
    expect(
      groups.map((group) => [
        group.lastElementChild?.previousElementSibling?.textContent,
        group.lastElementChild?.textContent,
      ]),
    ).toEqual([
      ["kernel", "2"],
      ["perimeter", "1"],
    ]);
    for (const group of groups) {
      const trailing = group.lastElementChild;
      expect(trailing?.classList.contains("text-fg-faint")).toBe(true);
      expect(trailing?.classList.contains("shrink-0")).toBe(true);
    }
  });
});

describe("a session row seats its glyph and its clock", () => {
  test("Given a session row, When rendered, Then the leading slot holds the glyph and the trailing slot a <time>", () => {
    const document = render();
    const session = sessions[1];
    if (session === undefined) throw new Error("fixture missing");
    const row = element(document, `#session-row-${session.id}`);
    expect(row.getAttribute("data-density")).toBe("double");

    const leading = row.firstElementChild;
    expect(leading?.classList.contains("row-span-2")).toBe(true);
    expect(leading?.firstElementChild?.getAttribute("data-ui")).toBe("StatusGlyph");
    expect(leading?.firstElementChild?.getAttribute("data-shape")).toBe("hollow");

    const titleLine = leading?.nextElementSibling;
    const trailing = titleLine?.lastElementChild;
    expect(trailing?.classList.contains("ml-auto")).toBe(true);
    const time = trailing?.querySelector("time");
    expect(time?.getAttribute("datetime")).toBe(new Date(session.lastActivityAt).toISOString());
    expect(time?.textContent).toBe(formatRelative(TEST_NOW, session.lastActivityAt));
    expect(time?.textContent).toBe("2m");
    expect(time?.parentElement?.classList.contains("text-fg-faint")).toBe(true);
    expect(time?.parentElement?.classList.contains("text-meta")).toBe(true);

    // The clock moved up: the second line no longer carries one.
    expect(element(row, "[data-secondary]").querySelector("time")).toBeNull();
  });

  test("Given an active session, When rendered, Then the second line names the state and the clock still trails", () => {
    const running = [makeSession({ id: "r", phase: "running", projectId: "kernel", createdAt: 1 })];
    const client = new QueryClient();
    const document = new Window().document;
    document.body.innerHTML = renderToStaticMarkup(
      <QueryClientProvider client={client}>{tree(() => undefined, running)}</QueryClientProvider>,
    );
    const row = element(document, "#session-row-r");
    expect(element(row, "[data-secondary]").textContent).toBe("running");
    expect(row.querySelectorAll("time")).toHaveLength(1);
  });
});

describe("the footer says where the gateway is", () => {
  const footer = (document: Document) => element(document, '[data-ui="Sidebar.Footer"]');
  /** The one workspace row: [glyph slot][title line over detail line]; returns its glyph and both lines. */
  const workspaceRow = (document: Document) => {
    const row = element(footer(document), "div");
    const glyphSlot = row.firstElementChild;
    const column = row.lastElementChild;
    const glyph = glyphSlot?.firstElementChild;
    const title = column?.firstElementChild;
    const detail = column?.lastElementChild;
    if (!(glyphSlot && column && glyph && title && detail)) throw new Error("footer row is not two slots");
    return { row, glyphSlot, column, glyph, title, detail };
  };

  test("Given the endpoint still in flight, When rendered, Then the footer draws nothing", () => {
    const document = render("pending");
    expect(footer(document).childElementCount).toBe(0);
  });

  test("Given no gateway, When rendered, Then the two-line row reads Gateway over Not configured", () => {
    const document = render(null);
    const { row, glyphSlot, column, glyph, title, detail } = workspaceRow(document);
    expect(row.tagName).toBe("DIV");
    expect(row.querySelector("button")).toBeNull();
    expect(row.childElementCount).toBe(2);
    // p-1.5 + leading-4 + the meta line = 42px at shell density (see the file comment).
    for (const name of ["flex", "w-full", "min-w-0", "items-center", "gap-2", "rounded-md", "p-1.5"])
      expect(row.classList.contains(name)).toBe(true);
    expect(row.classList.contains("h-7")).toBe(false);

    for (const name of ["flex", "size-6", "shrink-0", "items-center", "justify-center"])
      expect(glyphSlot.classList.contains(name)).toBe(true);
    expect(glyphSlot.childElementCount).toBe(1);
    expect(glyph.getAttribute("data-ui")).toBe("StatusGlyph");
    expect(glyph.getAttribute("data-tone")).toBe("muted");

    for (const name of ["flex", "min-w-0", "flex-1", "flex-col"])
      expect(column.classList.contains(name)).toBe(true);
    expect(column.childElementCount).toBe(2);
    expect(title.getAttribute("data-ui")).toBe("Text");
    expect(title.textContent).toBe("Gateway");
    for (const name of ["text-label", "text-fg", "truncate", "font-medium", "leading-4"])
      expect(title.classList.contains(name)).toBe(true);
    expect(detail.getAttribute("data-ui")).toBe("Text");
    expect(detail.textContent).toBe("Not configured");
    for (const name of ["text-meta", "text-fg-subtle", "truncate"])
      expect(detail.classList.contains(name)).toBe(true);
  });

  test("Given a token the wire refuses, When rendered, Then the detail line prints the refusal", () => {
    const endpoint: GatewayEndpoint = { url: "ws://127.0.0.1:3000/ws", token: "not a token" };
    const refused = selectChatTransport(endpoint, () => "");
    if (refused.kind !== "misconfigured") throw new Error("fixture must be refused");
    const document = render(endpoint);
    const { row, glyph, title, detail } = workspaceRow(document);
    expect(glyph.getAttribute("data-tone")).toBe("destructive");
    expect(title.textContent).toBe("Gateway");
    expect(detail.textContent).toBe(refused.problem);
    expect(row.textContent).not.toContain("not a token");
  });

  test("Given a configured gateway, When rendered, Then the detail line is the wire URL and the token stays out", () => {
    const document = render({ url: "ws://127.0.0.1:3000/ws", token: "secret" });
    const { row, glyph, title, detail } = workspaceRow(document);
    expect(glyph.getAttribute("data-tone")).toBe("success");
    expect(title.textContent).toBe("Gateway");
    expect(detail.textContent).toBe("ws://127.0.0.1:3000/ws");
    expect(row.textContent).not.toContain("secret");
    expect(document.querySelectorAll('[data-ui="NavItem"]')).toHaveLength(4);
    expect(document.body.textContent).not.toContain("Settings");
  });
});
