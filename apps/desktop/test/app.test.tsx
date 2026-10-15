import { beforeEach, describe, expect, test } from "bun:test";
import { setSessionTitleIfPlaceholder } from "../src/renderer/state/session-actions";
import { consoleStore, INITIAL_CLIENT_STATE, newSessionTab, openTab } from "../src/renderer/state/store";
import { renderShell } from "./helpers";

/**
 * The shell's first paint, from the store and the endpoint query and nothing
 * else. There is no DOM here, so what is pinned is what each state renders TO:
 * an honest empty column, a created session named in the header and marked in
 * the tree, and a composer that says why it is disabled instead of pretending.
 */
beforeEach(() => {
  consoleStore.setState(() => INITIAL_CLIENT_STATE);
});

const shell = renderShell;

describe("nothing open", () => {
  test("Given no sessions, When the app renders, Then both columns say so and nothing is fabricated", () => {
    const html = shell(null);

    expect(html).toContain("No sessions yet");
    expect(html).toContain("Select or create a session");
    expect(html).not.toContain('role="option"');
    // No composer: there is nothing to address a message to.
    expect(html).not.toContain("data-composer");
  });

  test("Given the endpoint still in flight, When the app renders, Then the window is already painted", () => {
    // The app must not wait on the wire: the navigator is useful before the
    // endpoint has answered.
    expect(shell("pending")).toContain('aria-label="Sessions"');
  });
});

describe("empty routes", () => {
  test("renders each non-session route as an honest empty column", () => {
    for (const route of ["automations"] as const) {
      consoleStore.setState(() => INITIAL_CLIENT_STATE);
      openTab({ kind: "route", route });
      const html = shell(null);
      expect(html).toContain('data-ui="Panel"');
      expect(html.match(/aria-current="page"/g)).toHaveLength(1);
      expect(html).not.toContain("data-composer");
    }
  });
});

describe("one session", () => {
  test("Given a created session, When the app renders, Then it is the header but not yet a row", () => {
    newSessionTab();
    const html = shell(null);

    // A session earns its row with its first prompt; until then only the tab and header name it.
    expect(html).toContain("No turns in this session yet.");
    expect(html).toContain("No sessions yet");
    expect(html).not.toContain('role="treeitem"');
  });

  test("Given a prompted session, When the app renders, Then it is the header and the current row", () => {
    newSessionTab();
    setSessionTitleIfPlaceholder(consoleStore.state.sessions[0]?.id ?? "", "fix the build");
    const html = shell(null);

    expect(html).toContain('aria-label="fix the build"');
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toContain("No turns in this session yet.");
    expect(html).not.toContain("No sessions yet");
  });

  test("Given no gateway, When the app renders, Then the composer is disabled and says why", () => {
    newSessionTab();
    const html = shell(null);
    const field = html.slice(html.indexOf("<textarea"), html.indexOf("</textarea>"));

    expect(field).toContain("disabled");
    expect(html).toContain("gateway not configured");
  });

  test("Given the endpoint still in flight, When the app renders, Then the composer waits without a verdict", () => {
    newSessionTab();
    const html = shell("pending");
    const field = html.slice(html.indexOf("<textarea"), html.indexOf("</textarea>"));

    expect(field).toContain("disabled");
    expect(html).not.toContain("gateway not configured");
  });
});
