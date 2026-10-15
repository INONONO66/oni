import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient } from "@tanstack/react-query";
import type { ServerWebSocket } from "bun";
import type { ShellCommand } from "../src/preload/api";
import { serveChat } from "./helpers/chat-server";
import { commandBridge } from "./helpers/bridge";

const native = {
  WebSocket: globalThis.WebSocket,
  ReadableStream: globalThis.ReadableStream,
  WritableStream: globalThis.WritableStream,
  TransformStream: globalThis.TransformStream,
};
GlobalRegistrator.register();
Object.assign(globalThis, native);
let onWireMessage: () => void = () => undefined;
globalThis.WebSocket = class extends native.WebSocket {
  constructor(...args: ConstructorParameters<typeof native.WebSocket>) {
    super(...args);
    this.addEventListener("message", () => onWireMessage());
  }
};
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act, Fragment, StrictMode } = await import("react");
const { createRoot } = await import("react-dom/client");
const { App } = await import("../src/renderer/app");
const { StateProvider } = await import("../src/renderer/state/provider");
const { queryKeys } = await import("../src/renderer/state/queries");
const {
  activeTab,
  activateTab,
  back,
  closeTab,
  jumpTo,
  consoleStore,
  createSession,
  INITIAL_CLIENT_STATE,
  navigate,
  newSessionTab,
  openTab,
  setDraft,
  setSidebarOpen,
  toggleProject,
} = await import("../src/renderer/state/store");
const { setSessionTitleIfPlaceholder } = await import("../src/renderer/state/session-actions");
const { historyMenuEntries } = await import("../src/renderer/state/selectors");
// Loaded after `GlobalRegistrator.register()` like every DOM-touching module:
// this import binds the store platform and supplies the suite's entropy.
const { testId } = await import("./helpers/platform");

/** The suite's injected clock matches its pinned `Date.now` spy (#1245). */
const suitePlatform = { now: () => 10_000, id: testId };
const { SessionList } = await import("../src/renderer/shell/session-list");

const cleanups: (() => void)[] = [];
const listeners = new Set<(command: ShellCommand) => void>();
let subscriptions = 0;
beforeEach(() => {
  const clock = spyOn(Date, "now").mockReturnValue(10_000);
  cleanups.push(() => clock.mockRestore());
  consoleStore.setState(() => INITIAL_CLIENT_STATE);
  subscriptions = 0;
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: commandBridge(listeners, () => {
      subscriptions += 1;
    }),
  });
});
afterEach(async () => {
  await act(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  });
  expect(listeners.size).toBe(0);
});
afterAll(() => GlobalRegistrator.unregister());

function node(root: ParentNode, selector: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`Missing ${selector}`);
  return found;
}
async function mount(url?: string, strict = false) {
  const Wrapper = strict ? StrictMode : Fragment;
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Number.POSITIVE_INFINITY } },
  });
  client.setQueryData(queryKeys.gatewayEndpoint, url ? { url } : { url: "ws://127.0.0.1:1" });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = () =>
    act(async () =>
      root.render(
        <Wrapper>
          <StateProvider client={client}>
            <App platform="darwin" storage={null} host={suitePlatform} />
          </StateProvider>
        </Wrapper>,
      ),
    );
  await render();
  cleanups.push(() => {
    root.unmount();
    host.remove();
    client.clear();
  });
  return { host, render, client, unmount: () => act(async () => root.render(null)) };
}
const click = (element: HTMLElement) => act(async () => element.click());
const command = (value: ShellCommand) =>
  act(async () => {
    for (const listener of listeners) listener(value);
  });
const key = (target: EventTarget, value: string, metaKey = false) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: value, metaKey, bubbles: true }));
  });
function seed() {
  const a = createSession(1000);
  openTab({ kind: "session", sessionId: a });
  setSessionTitleIfPlaceholder(a, "alpha");
  const aTab = consoleStore.state.activeTabId;
  const b = createSession(2000);
  openTab({ kind: "session", sessionId: b });
  setSessionTitleIfPlaceholder(b, "beta");
  const bTab = consoleStore.state.activeTabId;
  const c = createSession(3000);
  setSessionTitleIfPlaceholder(c, "gamma");
  if (aTab === null || bTab === null) throw new Error("Missing tabs");
  activateTab(aTab);
  return { a, b, c, aTab, bTab };
}

test("one frame survives session, route, empty and reopen; bridge subscribes once per mount", async () => {
  const { aTab, bTab } = seed();
  const { host, unmount, render } = await mount();
  const stable = ["Sidebar", "Sidebar.Container", "TabStrip", "TabStrip.Trio"].map((name) =>
    node(host, `[data-ui="${name}"]`),
  );
  expect(listeners.size).toBe(1);
  await command("select-tab-2");
  expect(consoleStore.state.activeTabId).toBe(bTab);
  await click(node(host, '[data-ui="Sidebar.Nav"] button'));
  expect(activeTab(consoleStore.state)?.place).toEqual({ kind: "route", route: "sessions" });
  expect(host.querySelectorAll('[role="tabpanel"]')).toHaveLength(1);
  expect(host.querySelector("textarea")).toBeNull();
  await command("close-tab");
  await command("close-tab");
  await command("close-tab");
  expect(consoleStore.state.activeTabId).toBeNull();
  expect(host.querySelector('[role="tabpanel"]')).toBeNull();
  expect(host.querySelector("textarea")).toBeNull();
  expect(host.querySelector('[aria-current="true"]')).toBeNull();
  expect(stable.every((element) => element.isConnected)).toBe(true);
  await command("reopen-tab");
  expect(consoleStore.state.activeTabId).toBe(aTab);
  expect(subscriptions).toBe(1);
  await unmount();
  expect(listeners.size).toBe(0);
  await render();
  expect(listeners.size).toBe(1);
  expect(subscriptions).toBe(2);
  await click(node(host, '[data-ui="TabStrip.Create"]'));
  expect(consoleStore.state.tabs).toHaveLength(2);
  expect(consoleStore.state.sessions).toHaveLength(4);
});

test("Sessions list ignores collapsed/filter state, keeps attention order and explicitly dedupes", async () => {
  const { a, b, c, bTab } = seed();
  toggleProject("default");
  openTab({ kind: "route", route: "sessions" });
  const listTab = consoleStore.state.activeTabId;
  const { host } = await mount();
  await key(document, "k", true);
  const input = node(host, '[role="combobox"]');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, "no-match");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(host.querySelectorAll('[role="tree"] [role="treeitem"]:not([aria-expanded])')).toHaveLength(0);
  const list = node(host, '[role="tabpanel"] ul');
  const rows = [...list.querySelectorAll("button")];
  expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual(["gamma", "beta", "alpha"]);
  expect(list.querySelectorAll('[data-level="0"]')).toHaveLength(3);
  expect(list.querySelectorAll("time")).toHaveLength(3);
  await click(node(list, 'button[aria-label="beta"]'));
  expect(consoleStore.state.activeTabId).toBe(bTab);
  expect(consoleStore.state.tabs).toHaveLength(3);
  await act(async () => {
    if (listTab) activateTab(listTab);
  });
  await click(node(host, '[role="tabpanel"] button[aria-label="gamma"]'));
  expect(consoleStore.state.activeTabId).toBe(listTab);
  expect(activeTab(consoleStore.state)?.place).toEqual({ kind: "session", sessionId: c });
  await key(input, "Escape");
  await key(input, "Escape");
  await act(async () => toggleProject("default"));
  await click(node(host, `#session-row-${b}`));
  expect(consoleStore.state.activeTabId).toBe(bTab);
  expect(consoleStore.state.sessions.map((session) => session.id)).toEqual([a, b, c]);
});

test("Sessions list holds its order until a focus boundary after a phase update", async () => {
  const { a, c } = seed();
  openTab({ kind: "route", route: "sessions" });
  const tabId = consoleStore.state.activeTabId;
  const { host, client } = await mount();
  const kinds = () =>
    [...host.querySelectorAll('[role="tabpanel"] [data-attention-kind]')].map((group) =>
      group.getAttribute("data-attention-kind"),
    );
  expect(kinds()).toEqual(["rest"]);
  await act(() => {
    client.setQueryData(queryKeys.gatewayEndpoint, null);
    for (const session of consoleStore.state.sessions) cacheSession(client, makeSession({
      ...session, phase: session.id === a ? "waiting_input" : session.id === c ? "running" : "idle",
    }));
  });
  expect(kinds()).toEqual(["rest"]);
  await click(node(host, `#tab-${tabId}`));
  expect(kinds()).toEqual(["demand", "watch", "rest"]);
  expect(host.querySelectorAll('[role="tree"] [data-ui="StatusGlyph"]')).toHaveLength(3);
});

test("list selection targets its own active tab even when sidebar search was invoked elsewhere", async () => {
  const { aTab, c } = seed();
  const { host } = await mount();
  await key(document, "k", true);
  // ⌘-click opens the Sessions list in its own tab; a plain click would move the invoking tab.
  await act(() =>
    node(host, '[data-ui="Sidebar.Nav"] button').dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }),
    ),
  );
  const listTab = consoleStore.state.activeTabId;
  expect(listTab).not.toBe(aTab);
  const invocationHistory = consoleStore.state.tabs.find((tab) => tab.id === aTab)?.history;
  await click(node(host, '[role="tabpanel"] button[aria-label="gamma"]'));
  expect(consoleStore.state.activeTabId).toBe(listTab);
  expect(activeTab(consoleStore.state)?.place).toEqual({ kind: "session", sessionId: c });
  expect(consoleStore.state.tabs.find((tab) => tab.id === aTab)?.history).toBe(invocationHistory);
});

const { cacheSession, makeSession } = await import("./helpers/session");

test("SessionList renders real project/time metadata and an empty list without controls", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  cleanups.push(() => root.unmount());
  const sessions = [makeSession({ id: "s", title: "sample", projectId: null, createdAt: 0 })];
  const selected: string[] = [];
  await act(async () =>
    root.render(
      <SessionList sessions={sessions} now={120_000} onSelect={(id) => selected.push(id)} />,
    ),
  );
  // The project cell renders a placeholder for a null project; the wording is copy, not contract.
  expect(host.querySelectorAll("span > span")[1]?.textContent).not.toBe("");
  expect(node(host, "time").getAttribute("datetime")).toBe(new Date(0).toISOString());
  expect(node(host, "time").textContent).toBe("2m");
  await click(node(host, "button"));
  expect(selected).toEqual(["s"]);
  await act(async () =>
    root.render(<SessionList sessions={[]} now={120_000} onSelect={(id) => selected.push(id)} />),
  );
  expect(host.querySelector("button, textarea")).toBeNull();
  expect(host.textContent?.length).toBeGreaterThan(0);
});

test("search captures invocation once: existing B then unopened C targets A and preserves reveal", async () => {
  const { aTab, bTab, c } = seed();
  setSidebarOpen(false);
  const { host } = await mount();
  const original = consoleStore.state.tabs[0]?.history;
  await key(document, "k", true);
  expect(consoleStore.state.sidebarFloating).toBe(true);
  const input = node(host, '[role="combobox"]');
  await key(input, "ArrowDown");
  await key(input, "ArrowDown");
  await key(input, "Enter");
  expect(consoleStore.state.activeTabId).toBe(bTab);
  expect(consoleStore.state.tabs[0]?.history).toBe(original);
  await key(document, "k", true);
  await key(input, "ArrowUp");
  await key(input, "Enter");
  expect(consoleStore.state.activeTabId).toBe(aTab);
  expect(activeTab(consoleStore.state)?.place).toEqual({ kind: "session", sessionId: c });
  expect(consoleStore.state.sidebarFloating).toBe(true);
  await command("select-tab-2");
  expect(consoleStore.state.sidebarFloating).toBe(true);
  await key(input, "Escape");
  expect(consoleStore.state.sidebarFloating).toBe(false);
});

for (const empty of [false, true]) {
  test(`search uses ${empty ? "new tab" : "then-active"} after invocation closes`, async () => {
    const { aTab, bTab, c } = seed();
    const { host } = await mount();
    await key(document, "k", true);
    const input = node(host, '[role="combobox"]');
    await act(async () => {
      closeTab(aTab);
      if (empty) closeTab(bTab);
    });
    await key(input, "Enter");
    expect(activeTab(consoleStore.state)?.place).toEqual({ kind: "session", sessionId: c });
    if (!empty) expect(consoleStore.state.activeTabId).toBe(bTab);
    expect(consoleStore.state.tabs).toHaveLength(1);
  });
}

async function inactiveTabControls(id: string) {
  const { host } = await mount();
  const editor = node(host, "textarea");
  editor.focus();
  const inactive = node(host, `#tab-${id}`).parentElement;
  if (inactive === null) throw new Error("Missing tab wrapper");
  return { host, editor, close: node(inactive, '[data-ui="Tab.Close"]') };
}

test("real close commands recover composer/panel/tab focus, inactive closure preserves editor", async () => {
  const { aTab, bTab } = seed();
  const { host, editor, close } = await inactiveTabControls(bTab);
  await click(close);
  expect(document.activeElement).toBe(editor);
  await command("reopen-tab");
  node(host, "textarea").focus();
  await command("close-tab");
  expect(consoleStore.state.activeTabId).toBe(aTab);
  expect(document.activeElement).toBe(node(host, "textarea"));
  await command("new-tab");
  node(host, '[role="tabpanel"]').tabIndex = 0;
  node(host, '[role="tabpanel"]').focus();
  await command("close-tab");
  expect(document.activeElement).toBe(node(host, "textarea"));
  await command("new-tab");
  node(host, '[role="tab"][aria-selected="true"]').focus();
  await command("close-tab");
  expect(document.activeElement).toBe(node(host, `#tab-${aTab}`));
  await command("close-tab");
  expect(document.activeElement).toBe(node(host, '[data-ui="TabStrip.Create"]'));
});

test("closing a composer onto a route focuses its tab rather than the removed panel", async () => {
  openTab({ kind: "route", route: "automations" });
  const routeTab = consoleStore.state.activeTabId;
  newSessionTab();
  const { host } = await mount();
  node(host, "textarea").focus();
  await command("close-tab");
  expect(document.activeElement).toBe(node(host, `#tab-${routeTab}`));
  expect(host.querySelector("textarea")).toBeNull();
});

test.each([
  "newest",
  "oldest",
])("mounted history menu is newest first at the %s cursor with the current entry included once", async (position) => {
  seed();
  for (let index = 0; index < 25; index += 1) {
    const id = createSession(4000 + index);
    setSessionTitleIfPlaceholder(id, `visit-${index}`);
    navigate({ kind: "session", sessionId: id });
  }
  if (position === "oldest") jumpTo(0);
  const { host } = await mount();
  await click(node(host, '[aria-label="History"]'));
  const items = Array.from(document.querySelectorAll<HTMLElement>('[data-ui="HistoryMenu.Item"]'));
  expect(items.map((item) => item.textContent)).toEqual(
    historyMenuEntries().map((entry) => entry.title),
  );
  expect(items).toHaveLength(20);
  expect(items[0]?.textContent).toBe("visit-24");
  expect(items.at(-1)?.textContent).toBe(position === "oldest" ? "alpha" : "visit-5");
  expect(items.filter((item) => item.getAttribute("aria-current") === "true")).toHaveLength(1);
});

test("pointer-pressing an inactive tab's close control leaves the editor focused", async () => {
  const { bTab } = seed();
  const { editor, close } = await inactiveTabControls(bTab);
  const press = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 });
  await act(async () => close.dispatchEvent(press));
  if (!press.defaultPrevented) close.focus();
  await click(close);
  expect(consoleStore.state.tabs.some((tab) => tab.id === bTab)).toBe(false);
  expect(document.activeElement === editor).toBe(true);
});

test("history stays local across live duplicate views and tab titles resolve current metadata", async () => {
  const { a, b, aTab, bTab } = seed();
  navigate({ kind: "route", route: "automations" });
  activateTab(bTab);
  navigate({ kind: "session", sessionId: a });
  expect(consoleStore.state.activeTabId).toBe(bTab);
  activateTab(aTab);
  const { host } = await mount();
  await command("back");
  expect(consoleStore.state.activeTabId).toBe(aTab);
  expect(activeTab(consoleStore.state)?.place).toEqual({ kind: "session", sessionId: a });
  await command("forward");
  expect(consoleStore.state.activeTabId).toBe(aTab);
  await act(async () => {
    back();
    setDraft(a, "retained");
  });
  expect((node(host, "textarea") as HTMLTextAreaElement).value).toBe("retained");
  await act(async () => activateTab(bTab));
  expect((node(host, "textarea") as HTMLTextAreaElement).value).toBe("retained");
  expect(node(host, `#tab-${aTab}`).getAttribute("aria-label")).toBe(
    consoleStore.state.sessions.find((session) => session.id === a)?.title ?? "",
  );
  expect(consoleStore.state.sessions.some((session) => session.id === b)).toBe(true);
});

function deferred<T>() {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  return { promise, resolve, reject };
}

test("real Chat and gateway keep in-flight messages across switch, close and reopen; title earned at send", async () => {
  const received = deferred<ServerWebSocket<undefined>>();
  const server = serveChat((socket) => received.resolve(socket));
  cleanups.push(() => server.stop(true));
  const id = newSessionTab();
  const tab = consoleStore.state.activeTabId;
  setDraft(id, "  earned title  ");
  const { host } = await mount(`ws://127.0.0.1:${server.port}`, true);
  expect(listeners.size).toBe(1);
  await act(async () => {
    node(host, "textarea").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await received.promise;
  });
  const socket = await received.promise;
  expect(consoleStore.state.sessions[0]?.titleSource).toBe("prompt");
  expect(consoleStore.state.drafts[id]).toBe("");
  expect(node(host, '[role="tab"]').getAttribute("aria-label")).toBe(
    consoleStore.state.sessions[0]?.title ?? "",
  );
  await act(async () => setDraft(id, "next draft"));
  await key(node(host, "textarea"), "Enter");
  expect(consoleStore.state.drafts[id]).toBe("next draft");
  expect(node(host, `#session-row-${id} [data-ui="Highlight"]`).textContent).toBe(
    consoleStore.state.sessions[0]?.title ?? "",
  );
  await command("new-tab");
  await command("select-tab-1");
  expect(node(host, '[role="tabpanel"]').textContent).toContain("earned title");
  await command("close-tab");
  await command("reopen-tab");
  expect(consoleStore.state.activeTabId).toBe(tab);
  expect(node(host, '[role="tabpanel"]').textContent).toContain("earned title");
  const rendered = deferred<void>();
  const observer = new MutationObserver(() => {
    if (host.textContent?.includes("stream-continuity-sentinel")) rendered.resolve();
  });
  observer.observe(host, { childList: true, subtree: true, characterData: true });
  cleanups.push(() => observer.disconnect());
  const incoming = deferred<void>();
  onWireMessage = () => incoming.resolve();
  const timeout = setTimeout(
    () => rendered.reject(new Error(`Missing stream: ${host.textContent}`)),
    2000,
  );
  await act(async () => {
    socket.send(
      JSON.stringify({ type: "message", messageId: "reply", text: "stream-continuity-sentinel" }),
    );
    await incoming.promise;
  });
  await rendered.promise;
  clearTimeout(timeout);
  expect(node(host, '[role="tabpanel"]').textContent).toContain("stream-continuity-sentinel");
  await command("close-tab");
  await command("reopen-tab");
  expect(node(host, '[role="tabpanel"]').textContent).toContain("stream-continuity-sentinel");
}, 5000);
