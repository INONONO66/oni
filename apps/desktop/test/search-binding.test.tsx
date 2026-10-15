import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { orderByAttention } from "../src/renderer/attention/order";
import { SessionTree } from "../src/renderer/shell/session-tree";
import { useSearch, type Search } from "../src/renderer/shell/use-search";
import { installGlobals, installWindowGlobals } from "./helpers";
import { TEST_NOW } from "./helpers/platform";
import { makeSession } from "./helpers/session";

test("search binding translates shortcuts, query edits and navigation into focus and selection", async () => {
  const window = new Window();
  const restoreGlobals = installGlobals({
    window,
    document: window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let binding: Search;
  const selections: string[] = [];
  let returned = 0;
  function Harness() {
    binding = useSearch({
      ordered: { groups: [{ kind: "rest", projects: [{ id: null, sessions: ["one", "two"] }] }] },
      sessions: [],
      onSelect: (id) => {
        selections.push(id);
      },
      focusSelectedRow: () => {
        returned++;
      },
    });
    return <input ref={binding.inputRef} onKeyDown={binding.onKeyDown} />;
  }
  try {
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {
      window.document.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "k", metaKey: true, cancelable: true }),
      );
    });
    expect(document.activeElement === container.querySelector("input")).toBe(true);
    await act(async () => {
      binding.onValueChange("one");
    });
    await act(async () => {
      expect(binding.filtered.sequence).toEqual(["one"]);
    });
    await act(async () => {
      binding.onValueChange("missing");
    });
    await act(async () => {
      expect(binding.filtered.sequence).toEqual([]);
    });
    await act(async () => {
      binding.onValueChange("");
    });
    const key = (value: string) =>
      window.document
        .querySelector("input")
        ?.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }),
        );
    await act(async () => {
      key("ArrowDown");
    });
    await act(async () => {
      expect(binding.state.activeId).toBe("one");
    });
    await act(async () => {
      key("Enter");
    });
    expect(selections).toEqual(["one"]);
    await act(async () => {
      key("Escape");
    });
    expect(returned).toBe(1);
    await act(async () => {
      key("a");
    });
    expect(selections).toEqual(["one"]);
  } finally {
    await act(async () => {
      root.unmount();
    });
    restoreGlobals();
    await window.happyDOM.close();
  }
});

test("session tree arrows move focus only to an adjacent row", async () => {
  const window = new Window();
  const restoreGlobals = installWindowGlobals(window);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const sessions = [makeSession({ id: "one" }), makeSession({ id: "two" })];
  try {
    await act(() =>
      root.render(
        <SessionTree
          collapsedProjectIds={new Set()}
          now={TEST_NOW}
          onNavigate={() => undefined}
          onSelect={() => undefined}
          onToggleProject={() => undefined}
          ordered={orderByAttention(sessions, TEST_NOW)}
          pendingChanges={0}
          route="sessions"
          selectedId={null}
          sessions={sessions}
        />,
      ),
    );
    const rows = container.querySelectorAll<HTMLElement>('[role="treeitem"]');
    expect(rows).toHaveLength(3);
    const first = rows[1];
    const second = rows[2];
    if (first === undefined || second === undefined) throw new Error("Missing session rows");
    first.focus();
    await act(() =>
      first.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Tab" })),
    );
    expect(document.activeElement).toBe(first);
    await act(() =>
      first.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" })),
    );
    expect(document.activeElement).toBe(first);
    await act(() =>
      first.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown", cancelable: true }),
      ),
    );
    expect(document.activeElement).toBe(second);
  } finally {
    await act(() => root.unmount());
    container.remove();
    restoreGlobals();
    await window.happyDOM.close();
  }
});
