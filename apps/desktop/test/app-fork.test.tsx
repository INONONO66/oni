import { beforeEach, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { notifyManager, QueryClient } from "@tanstack/react-query";
import { Window } from "happy-dom";
import { act } from "react";
import { z } from "zod";
import type { SessionRead } from "@oni/protocol";
import { App } from "../src/renderer/app";
import { StateProvider } from "../src/renderer/state/provider";
import { queryKeys } from "../src/renderer/state/queries";
import { bindDurableSession } from "../src/renderer/state/session-actions";
import { activateTab, consoleStore, INITIAL_CLIENT_STATE, newSessionTab } from "../src/renderer/state/store";
import { installGlobals, mountWindow } from "./helpers";
import { upgradeWebSocket } from "./helpers/chat-server";
import { testPlatform } from "./helpers/platform";

beforeEach(() => consoleStore.setState(() => INITIAL_CLIENT_STATE));

const pin = { session: "durable", anchor: "turn-1", parentSeq: 3, parentHead: "parent-latest", copied: 4 };

/**
 * The gateway double: pages carry a boundary anchor; the fork answers in
 * order. Under `script: "children"` the single fork succeeds immediately and
 * the parent's pages then list fork children (one adopted by that fork, one
 * historical child this app never bound), the way the real gateway's
 * inspect-tree projection does (#1257 H-2).
 */
function serveFork(script: "legs" | "children" = "legs") {
  let forkCalls = 0;
  const childrenField = () =>
    script === "children" && forkCalls > 0
      ? {
          children: [
            { sessionId: "child-1", anchor: "turn-1" },
            { sessionId: "child-9", anchor: "turn-1" },
          ],
        }
      : {};
  const parentPage = (sessionId: string, cursored: boolean) => ({
    type: cursored ? "session_page" : "session_snapshot",
    sessionId, state: "idle", phase: "completed", phaseSince: 100,
    epoch: 1, afterRevision: 0, headRevision: 1, nextRevision: null,
    actions: [{ revision: 1, actionId: "turn-1", kind: "turn", at: 120, forkAnchor: "turn-1" }],
    usage: [], toolWallMs: 0,
    ...(sessionId === "durable" ? childrenField() : {}),
  });
  // The shipped gateway's post-fork subscription refresh: the parent chain
  // did not grow, so the pushed page is same-head and action-free; only the
  // catalog-derived `children` are new (#1257 r4 H-1).
  const parentRefresh = () => ({
    type: "session_page", sessionId: "durable", state: "idle", phase: "completed",
    phaseSince: 100, epoch: 1, afterRevision: 1, headRevision: 1, nextRevision: null,
    actions: [], usage: [], toolWallMs: 0, ...childrenField(),
  });
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: upgradeWebSocket,
    websocket: {
      message(socket: ServerWebSocket<undefined>, raw) {
        const frame = z.record(z.string(), z.json()).parse(JSON.parse(String(raw)));
        if (frame.type === "session_read") {
          socket.send(JSON.stringify(parentPage(z.string().parse(frame.sessionId), frame.cursor !== undefined)));
          return;
        }
        if (frame.type !== "session_fork") return;
        forkCalls += 1;
        if (script === "children") {
          socket.send(JSON.stringify({ type: "session_forked", sessionId: "child-1",
            parentId: frame.sessionId, forkedFrom: pin, head: "child-head" }));
          socket.send(JSON.stringify(parentRefresh()));
          return;
        }
        if (forkCalls === 3) {
          // The dead-gateway leg: close instead of answering, so the client's
          // pending fork waiter is rejected by the socket drain.
          socket.close();
          return;
        }
        socket.send(JSON.stringify(forkCalls === 1
          ? { type: "session_fork_refused", sessionId: frame.sessionId,
              reason: "byte_cap", detail: "copied bytes exceed the cap" }
          : { type: "session_forked", sessionId: "child-1", parentId: frame.sessionId,
              forkedFrom: pin, head: "child-head" }));
      },
    },
  });
}

/** The one allowed timer: a failure BOUND on an already-awaited signal, never a wait. */
function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out awaiting ${label}`)), 5000);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

const clientFrame = z.record(z.string(), z.json());
type ClientFrame = z.infer<typeof clientFrame>;
const frameListeners = new Set<(frame: ClientFrame) => void>();
const closeListeners = new Set<() => void>();

/**
 * The renderer's real socket, observed: every server frame the CLIENT receives
 * and every close it sees also notifies the test's listeners, so a test can
 * subscribe to the exact wire event BEFORE acting instead of polling renders.
 */
class ObservedWebSocket extends WebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    this.addEventListener("message", (event) => {
      const frame = clientFrame.parse(JSON.parse(String(event.data)));
      for (const listener of frameListeners) listener(frame);
    });
    this.addEventListener("close", () => {
      for (const listener of closeListeners) listener();
    });
  }
}

/** Resolves on the next client-received frame matching `predicate`; subscribe before acting. */
function frameSignal(predicate: (frame: ClientFrame) => boolean, label: string): Promise<void> {
  return bounded(
    new Promise<void>((resolve) => {
      const listener = (frame: ClientFrame) => {
        if (!predicate(frame)) return;
        frameListeners.delete(listener);
        resolve();
      };
      frameListeners.add(listener);
    }),
    label,
  );
}

/** Resolves when the client socket closes; subscribe before acting. */
function closeSignal(label: string): Promise<void> {
  return bounded(
    new Promise<void>((resolve) => {
      const listener = () => {
        closeListeners.delete(listener);
        resolve();
      };
      closeListeners.add(listener);
    }),
    label,
  );
}

/** Resolves when the console store satisfies `predicate`; subscribe before acting. */
function storeSignal(predicate: () => boolean, label: string): Promise<void> {
  return bounded(
    new Promise<void>((resolve) => {
      if (predicate()) {
        resolve();
        return;
      }
      const subscription = consoleStore.subscribe(() => {
        if (!predicate()) return;
        subscription.unsubscribe();
        resolve();
      });
    }),
    label,
  );
}

/** Resolves when a read page for `sessionId` satisfying `holds` is cached. */
function pageSignal(
  client: QueryClient,
  sessionId: string,
  holds: (page: SessionRead.Page) => boolean = () => true,
): Promise<void> {
  const cached = () => {
    const page = client.getQueryData<SessionRead.Page>(queryKeys.session(sessionId));
    return page !== undefined && holds(page);
  };
  return bounded(
    new Promise<void>((resolve) => {
      if (cached()) {
        resolve();
        return;
      }
      const unsubscribe = client.getQueryCache().subscribe((event) => {
        if (event.query.queryKey.at(-1) !== sessionId || !cached()) return;
        unsubscribe();
        resolve();
      });
    }),
    `read page for ${sessionId}`,
  );
}

/**
 * Await `signal` INSIDE `act`. The signal is a wire/store fact that resolves
 * without React, so the queued act work cannot deadlock on it; the extra
 * microtask turn lets the transport's promise chain run `setState` before the
 * act exit flushes the render.
 */
async function settled(signal: Promise<void>, after?: () => void): Promise<void> {
  await act(async () => {
    after?.();
    await signal;
    await Promise.resolve();
  });
}

test("the desktop fork control adopts the gateway's child and surfaces typed refusals", async () => {
  const server = serveFork();
  const window = new Window({ url: "http://localhost" });
  const { host, restoreGlobals, root } = mountWindow(window);
  const restoreSocket = installGlobals({ WebSocket: ObservedWebSocket });
  const client = new QueryClient();
  const localId = newSessionTab();
  bindDurableSession(localId, "durable");
  client.setQueryData(queryKeys.gatewayEndpoint, { url: `ws://127.0.0.1:${server.port}` });
  // Synchronous query notifications: the cache event, the React setState and
  // the act-queue entry land in ONE frame, so an awaited cache signal inside
  // `act` deterministically renders at the act exit (no scheduler races).
  notifyManager.setScheduler((callback) => callback());
  try {
    const parentPaged = pageSignal(client, "durable");
    await act(() =>
      root.render(
        <StateProvider client={client}>
          <App platform="darwin" storage={null} host={testPlatform} />
        </StateProvider>,
      ),
    );
    // The page's boundary anchor earns the fork control.
    await settled(parentPaged);
    const button = host.querySelector<HTMLElement>('[data-ui="SessionContent.Fork"]');
    expect(button).not.toBeNull();

    // First answer: the typed refusal reaches the composer as a sentence.
    await settled(
      frameSignal((frame) => frame.type === "session_fork_refused", "fork refusal"),
      () => button?.click(),
    );
    expect(host.textContent).toContain("fork refused: byte_cap");
    expect(host.textContent).toContain("copied bytes exceed the cap");

    // Second answer: the durable child is adopted - bound, titled, in a tab.
    await settled(
      storeSignal(() => consoleStore.state.sessions.length === 2, "child adoption"),
      () => button?.click(),
    );
    const child = consoleStore.state.sessions.find((session) => session.id !== localId);
    expect(child?.durableSessionId).toBe("child-1");
    expect(child?.title).toBe("Fork of durable");
    expect(consoleStore.state.tabs.map((tab) => tab.place)).toContainEqual({
      kind: "session",
      sessionId: child?.id ?? "",
    });

    // A dying socket: the transport failure reaches the composer, not the void.
    // Adoption switched the active tab to the child; wait for ITS read page
    // (it also carries a boundary anchor) to earn the child's fork control.
    await settled(pageSignal(client, "child-1"));
    const forkControl = host.querySelector<HTMLElement>('[data-ui="SessionContent.Fork"]');
    expect(forkControl).not.toBeNull();
    await settled(closeSignal("socket drain"), () => forkControl?.click());
    expect(host.textContent).toContain("gateway socket closed");
  } finally {
    await act(() => root.unmount());
    host.remove();
    restoreSocket();
    restoreGlobals();
    await window.happyDOM.close();
    server.stop(true);
    client.clear();
    // The library default (restored for the rest of the suite's files).
    notifyManager.setScheduler((callback) => setTimeout(callback, 0));
  }
}, 20_000);

/**
 * Parent->children inspection (#1257 H-2): after a fork the parent's read
 * page lists its fork children; clicking an entry opens the child - the
 * already-bound fork reuses its local session, a historical child this app
 * never bound is adopted through the same adoption path as a fresh fork.
 */
test("the parent page lists fork children and clicking one opens it", async () => {
  const server = serveFork("children");
  const window = new Window({ url: "http://localhost" });
  const { host, restoreGlobals, root } = mountWindow(window);
  const restoreSocket = installGlobals({ WebSocket: ObservedWebSocket });
  const client = new QueryClient();
  const localId = newSessionTab();
  bindDurableSession(localId, "durable");
  client.setQueryData(queryKeys.gatewayEndpoint, { url: `ws://127.0.0.1:${server.port}` });
  notifyManager.setScheduler((callback) => callback());
  try {
    const parentPaged = pageSignal(client, "durable");
    await act(() =>
      root.render(
        <StateProvider client={client}>
          <App platform="darwin" storage={null} host={testPlatform} />
        </StateProvider>,
      ),
    );
    await settled(parentPaged);
    const button = host.querySelector<HTMLElement>('[data-ui="SessionContent.Fork"]');
    expect(button).not.toBeNull();

    // Fork, then wait for the authoritative parent page that lists children.
    const listed = pageSignal(client, "durable", (page) => page.children !== undefined);
    await settled(
      storeSignal(() => consoleStore.state.sessions.length === 2, "child adoption"),
      () => button?.click(),
    );
    await settled(listed);

    // Back on the parent tab: both children render with their anchors.
    const parentTab = consoleStore.state.tabs.find(
      (tab) => tab.place.kind === "session" && tab.place.sessionId === localId,
    );
    expect(parentTab).toBeDefined();
    await act(() => activateTab(parentTab?.id ?? ""));
    const entries = [...host.querySelectorAll<HTMLElement>('[data-ui="SessionContent.ForkChild"]')];
    expect(entries.map((entry) => entry.dataset.child)).toEqual(["child-1", "child-9"]);
    expect(entries.map((entry) => entry.dataset.anchor)).toEqual(["turn-1", "turn-1"]);

    // The unbound historical child adopts a new local session and its tab.
    await settled(
      storeSignal(() => consoleStore.state.sessions.length === 3, "historical child adoption"),
      () => entries[1]?.click(),
    );
    const adopted = consoleStore.state.sessions.find((session) => session.durableSessionId === "child-9");
    expect(adopted?.title).toBe("child-9");
    const activePlace = () => {
      const tab = consoleStore.state.tabs.find((candidate) => candidate.id === consoleStore.state.activeTabId);
      return tab?.place.kind === "session" ? tab.place.sessionId : undefined;
    };
    expect(activePlace()).toBe(adopted?.id);

    // The already-bound fork child reuses its local session: no new adoption.
    await act(() => activateTab(parentTab?.id ?? ""));
    const bound = consoleStore.state.sessions.find((session) => session.durableSessionId === "child-1");
    const reopened = storeSignal(() => activePlace() === bound?.id, "bound child tab activation");
    await settled(reopened, () => {
      host.querySelector<HTMLElement>('[data-ui="SessionContent.ForkChild"][data-child="child-1"]')?.click();
    });
    expect(consoleStore.state.sessions.length).toBe(3);
  } finally {
    await act(() => root.unmount());
    host.remove();
    restoreSocket();
    restoreGlobals();
    await window.happyDOM.close();
    server.stop(true);
    client.clear();
    notifyManager.setScheduler((callback) => setTimeout(callback, 0));
  }
}, 20_000);
