import { setSessionTitleIfPlaceholder } from "../src/renderer/state/session-actions";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as ui from "@openomni/ui";
import { QueryClient } from "@tanstack/react-query";
import type { ServerWebSocket } from "bun";
import { Window } from "happy-dom";
import { serveChat, type ClientFrame } from "./helpers/chat-server";
import { commandBridge } from "./helpers/bridge";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { GatewayEndpoint, ShellCommand } from "../src/preload/api";
import { App } from "../src/renderer/app";
import { SessionList } from "../src/renderer/shell/session-list";
import { makeSession } from "./helpers/session";
import { StateProvider } from "../src/renderer/state/provider";
import { queryKeys } from "../src/renderer/state/queries";
import { SIDEBAR_OPEN_KEY, SIDEBAR_WIDTH_KEY } from "../src/renderer/state/shell-preferences";
import {
  activateTab,
  activeTab,
  consoleStore,
  createSession,
  INITIAL_CLIENT_STATE,
  navigate,
  newSessionTab,
  openTab,
  setDraft,
  setSidebarFloating,
  setSidebarOpen,
  setSidebarWidth,
} from "../src/renderer/state/store";
import { testId } from "./helpers/platform";

/** The suite's injected clock matches its pinned `Date.now` spy (#1245). */
const suitePlatform = { now: () => 10_000, id: testId };

let browser: Window;
let host: HTMLElement;
let root: Root;
let client: QueryClient;
let subscriptions: number;
let closedWindows: number;
const listeners = new Set<(command: ShellCommand) => void>();
const descriptors = new Map<string, PropertyDescriptor | undefined>();
const cleanups: (() => void)[] = [];
beforeEach(() => {
  const clock = spyOn(Date, "now").mockReturnValue(10_000);
  cleanups.push(() => clock.mockRestore());
  browser = new Window({ url: "http://localhost" });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    KeyboardEvent: browser.KeyboardEvent,
    HTMLInputElement: browser.HTMLInputElement,
    HTMLTextAreaElement: browser.HTMLTextAreaElement,
    MutationObserver: browser.MutationObserver,
    ResizeObserver: browser.ResizeObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  subscriptions = 0;
  closedWindows = 0;
  Object.defineProperty(browser, "desktop", {
    value: commandBridge(
      listeners,
      () => {
        subscriptions += 1;
      },
      () => {
        closedWindows += 1;
      },
    ),
  });
  consoleStore.setState(() => INITIAL_CLIENT_STATE);
  client = new QueryClient({ defaultOptions: { queries: { gcTime: Number.POSITIVE_INFINITY } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  expect(listeners.size).toBe(0);
  client.clear();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  descriptors.clear();
  await browser.happyDOM.close();
});

function node(selector: string, parent: ParentNode = host): HTMLElement {
  const element = parent.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}
async function mount(
  endpoint: GatewayEndpoint | null = { url: "ws://localhost:1" },
  storage: Storage | null = null,
) {
  client.setQueryData(queryKeys.gatewayEndpoint, endpoint);
  await act(() =>
    root.render(
      <StateProvider client={client}>
        <App platform="darwin" storage={storage} host={suitePlatform} />
      </StateProvider>,
    ),
  );
}
const click = (selector: string, parent: ParentNode = host) =>
  act(() => node(selector, parent).click());
const command = (value: ShellCommand) =>
  act(() => {
    for (const listener of listeners) listener(value);
  });
const key = (target: EventTarget, value: string, metaKey = false) =>
  act(() =>
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: value, metaKey, bubbles: true, cancelable: true }),
    ),
  );
function seed() {
  const first = createSession(1000);
  openTab({ kind: "session", sessionId: first });
  const firstTab = consoleStore.state.activeTabId;
  const second = createSession(2000);
  openTab({ kind: "session", sessionId: second });
  const secondTab = consoleStore.state.activeTabId;
  const unopened = createSession(3000);
  setSessionTitleIfPlaceholder(first, "alpha");
  setSessionTitleIfPlaceholder(second, "beta");
  setSessionTitleIfPlaceholder(unopened, "gamma");
  if (firstTab === null || secondTab === null) throw new Error("Missing tabs");
  activateTab(firstTab);
  return { first, firstTab, second, secondTab, unopened };
}

test("App restores and persists shell preferences, scopes bracket shortcuts and disposes subscriptions", async () => {
  const storage = browser.localStorage;
  storage.setItem(SIDEBAR_OPEN_KEY, "false");
  storage.setItem(SIDEBAR_WIDTH_KEY, "280");
  newSessionTab();
  await mount(undefined, storage);
  expect(consoleStore.state.sidebarOpen).toBe(false);
  expect(consoleStore.state.sidebarWidth).toBe(280);
  await key(document, "[");
  expect(consoleStore.state.sidebarOpen).toBe(true);
  expect(storage.getItem(SIDEBAR_OPEN_KEY)).toBe("true");
  await key(node("textarea"), "[");
  await key(document, "x");
  expect(consoleStore.state.sidebarOpen).toBe(true);
  await act(() => setSidebarWidth(300));
  expect(storage.getItem(SIDEBAR_WIDTH_KEY)).toBe("300");
  expect(subscriptions).toBe(1);
  await act(() => root.render(null));
  expect(listeners.size).toBe(0);
  await act(() => setSidebarWidth(260));
  expect(storage.getItem(SIDEBAR_WIDTH_KEY)).toBe("300");
  await key(document, "[");
  expect(consoleStore.state.sidebarOpen).toBe(true);
  await mount();
  expect(subscriptions).toBe(2);
  expect(listeners.size).toBe(1);
});

test("pointer navigation, local history and list selection keep one frame and preserve tab identities", async () => {
  const { first, firstTab, secondTab, unopened } = seed();
  navigate({ kind: "route", route: "automations" });
  // Base UI's portal is SSR-disabled when an earlier test imports it without a DOM.
  // Observe App's generic callback while retaining the real Console and controls.
  const RealConsole = ui.Console;
  let strip: ui.ConsoleStrip | undefined;
  const consoleSpy = spyOn(ui, "Console").mockImplementation((props) => {
    strip = props.strip;
    return <RealConsole {...props} />;
  });
  cleanups.push(() => consoleSpy.mockRestore());
  await mount();
  const frame = node('[data-ui="TabStrip"]');
  const historyButtons = node('[data-ui="TabStrip.Trio"]').querySelectorAll("button");
  const back = historyButtons[1];
  const forward = historyButtons[2];
  if (!back || !forward) throw new Error("Missing history controls");
  await act(() => back.click());
  expect(activeTab(consoleStore.state)?.place).toEqual({ kind: "session", sessionId: first });
  await act(() => forward.click());
  expect(activeTab(consoleStore.state)?.place).toEqual({ kind: "route", route: "automations" });
  await act(() => strip?.history.onJump("0"));
  expect(activeTab(consoleStore.state)?.history.cursor).toBe(0);
  expect(consoleStore.state.activeTabId).toBe(firstTab);
  await click(`#tab-${secondTab}`);
  expect(consoleStore.state.activeTabId).toBe(secondTab);
  await click('[data-ui="Sidebar.Nav"] button');
  const listTab = consoleStore.state.activeTabId;
  const list = node('[role="tabpanel"] ul');
  expect(list.querySelectorAll("li")).toHaveLength(3);
  await click('button[aria-label="alpha"]', list);
  expect(consoleStore.state.activeTabId).toBe(firstTab);
  await act(() => {
    if (listTab) activateTab(listTab);
  });
  await click('button[aria-label="gamma"]', node('[role="tabpanel"] ul'));
  expect(consoleStore.state.activeTabId).toBe(listTab);
  expect(activeTab(consoleStore.state)?.place).toEqual({ kind: "session", sessionId: unopened });
  expect(node('[data-ui="TabStrip"]')).toBe(frame);
  await click('[data-ui="TabStrip.Create"]');
  // The nav click moved the second tab, so only `+` grew the strip: two seeded tabs plus one.
  expect(consoleStore.state.tabs).toHaveLength(3);
  expect(consoleStore.state.sessions).toHaveLength(4);
});

test("close commands recover focus from panels and tabs without stealing focus on inactive close", async () => {
  const { firstTab, secondTab } = seed();
  await mount();
  const editor = node("textarea");
  editor.focus();
  const inactive = node(`#tab-${secondTab}`).parentElement;
  if (!inactive) throw new Error("Missing wrapper");
  await click('[data-ui="Tab.Close"]', inactive);
  expect(document.activeElement === editor).toBe(true);
  await command("reopen-tab");
  node("textarea").focus();
  await command("close-tab");
  expect(consoleStore.state.activeTabId).toBe(firstTab);
  expect(document.activeElement === node("textarea")).toBe(true);
  await act(() => openTab({ kind: "route", route: "automations" }));
  const routeTab = consoleStore.state.activeTabId;
  await act(() => activateTab(firstTab));
  node("textarea").focus();
  await command("close-tab");
  expect(document.activeElement === node(`#tab-${routeTab}`)).toBe(true);
  await command("new-tab");
  node('[role="tab"][aria-selected="true"]').focus();
  await command("close-tab");
  expect(document.activeElement === node(`#tab-${routeTab}`)).toBe(true);
  await command("close-tab");
  expect(document.activeElement === node('[data-ui="TabStrip.Create"]')).toBe(true);
  expect(host.querySelector('[role="tabpanel"], textarea')).toBeNull();
  const before = consoleStore.state;
  expect(closedWindows).toBe(0);
  await command("close-tab");
  expect(consoleStore.state).toBe(before);
  // Cmd+W with nothing left to close hands the keystroke back to the window.
  expect(closedWindows).toBe(1);
});

test("search keeps its invoking tab and reveal while explicit result activation changes the active tab", async () => {
  const { firstTab, secondTab, unopened } = seed();
  setSidebarOpen(false);
  await mount();
  const originalHistory = consoleStore.state.tabs[0]?.history;
  await key(document, "k", true);
  expect(consoleStore.state.sidebarFloating).toBe(true);
  const input = node('[role="combobox"]');
  await key(input, "ArrowDown");
  await key(input, "ArrowDown");
  await key(input, "Enter");
  expect(consoleStore.state.activeTabId).toBe(secondTab);
  expect(consoleStore.state.tabs[0]?.history).toBe(originalHistory);
  await key(document, "k", true);
  await key(input, "ArrowUp");
  await key(input, "Enter");
  expect(consoleStore.state.activeTabId).toBe(firstTab);
  expect(activeTab(consoleStore.state)?.place).toEqual({ kind: "session", sessionId: unopened });
  await command("select-tab-2");
  expect(consoleStore.state.sidebarFloating).toBe(true);
  await key(input, "Escape");
  expect(consoleStore.state.sidebarFloating).toBe(false);
  await act(() => setSidebarFloating(true));
  await key(document, "Escape");
  expect(consoleStore.state.sidebarFloating).toBe(false);
});

test("SessionList preserves attention order, dates and callback ids and has no controls when empty", async () => {
  const sessions = [
    makeSession({ id: "one", title: "first", projectId: "p", createdAt: 1000 }),
    makeSession({ id: "two", title: "second", projectId: null, createdAt: 2000 }),
  ];
  const selected: string[] = [];
  await act(() =>
    root.render(
      <SessionList sessions={sessions} now={120000} onSelect={(id) => selected.push(id)} />,
    ),
  );
  const rows = [...host.querySelectorAll("li")];
  expect(rows).toHaveLength(2);
  for (const [index, row] of rows.entries()) {
    const session = sessions[sessions.length - 1 - index];
    if (!session) throw new Error("Missing session");
    expect(node("button", row).getAttribute("aria-label")).toBe(session.title);
    expect(node("time", row).getAttribute("datetime")).toBe(
      new Date(session.createdAt).toISOString(),
    );
    expect(node("button", row).dataset.level).toBe("0");
    await act(() => node("button", row).click());
  }
  expect(selected).toEqual(["two", "one"]);
  expect(host.querySelector("textarea")).toBeNull();
  await act(() =>
    root.render(<SessionList sessions={[]} now={120000} onSelect={(id) => selected.push(id)} />),
  );
  expect(host.querySelector("ul, button, textarea")).toBeNull();
  expect(selected).toEqual(["two", "one"]);
});

function signal<T>() {
  const result = Promise.withResolvers<T>();
  const timeout = setTimeout(
    () => result.reject(new Error("Expected lifecycle signal was not emitted")),
    2000,
  );
  cleanups.push(() => clearTimeout(timeout));
  return {
    ...result,
    resolve: (value: T) => {
      clearTimeout(timeout);
      result.resolve(value);
    },
  };
}

test("real Chat sends once, retains in-flight work across tab closure and stops through the composer", async () => {
  const received = signal<{ socket: ServerWebSocket<undefined>; payload: ClientFrame }>();
  const server = serveChat((socket, payload) => received.resolve({ socket, payload }));
  cleanups.push(() => server.stop(true));
  const id = newSessionTab();
  const tab = consoleStore.state.activeTabId;
  setDraft(id, "  lifecycle-sentinel  ");
  await mount({ url: `ws://127.0.0.1:${server.port}` });
  expect((node("textarea") as HTMLTextAreaElement).value).toBe("  lifecycle-sentinel  ");
  expect((node('[data-ui="Composer.Send"]') as HTMLButtonElement).disabled).toBe(false);
  await act(async () => {
    node('[data-ui="Composer.Send"]').click();
    await received.promise;
  });
  expect((await received.promise).payload).toEqual({ text: "lifecycle-sentinel" });
  expect(consoleStore.state.sessions[0]?.titleSource).toBe("prompt");
  expect(consoleStore.state.drafts[id]).toBe("");
  expect(node('[role="tab"]').getAttribute("aria-label")).toBe(
    consoleStore.state.sessions[0]?.title ?? "",
  );
  expect((node("textarea") as HTMLTextAreaElement).disabled).toBe(true);
  await act(() => setDraft(id, "retained-draft"));
  await key(node("textarea"), "Enter");
  expect(consoleStore.state.drafts[id]).toBe("retained-draft");
  await command("new-tab");
  await command("select-tab-1");
  await command("close-tab");
  await command("reopen-tab");
  expect(consoleStore.state.activeTabId).toBe(tab);
  expect(node('[data-ui="Composer.Stop"]').getAttribute("aria-label")).toBe("Stop response");
  expect(node('[data-ui="Composer.Stop"]').hasAttribute("disabled")).toBe(false);
  expect(node('[role="tabpanel"]').textContent).toContain("lifecycle-sentinel");
  await click('[data-ui="Composer.Stop"]');
  expect(host.querySelector('[data-ui="Composer.Stop"]')).toBeNull();
  expect((node("textarea") as HTMLTextAreaElement).disabled).toBe(false);
  expect((node("textarea") as HTMLTextAreaElement).value).toBe("retained-draft");
});
