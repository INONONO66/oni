import { QueryClient } from "@tanstack/react-query";
import type { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "../src/renderer/app";
import { StateProvider } from "../src/renderer/state/provider";
import { queryKeys } from "../src/renderer/state/queries";
import type { Session } from "../src/renderer/state/store";
import type { RendererPlatform } from "../src/renderer/platform";
import { testPlatform } from "./helpers/platform";
import { cacheSession } from "./helpers/session";

/** Install `replacements` as browser globals; the returned function restores the originals. */
export function installGlobals(replacements: Record<string, object | boolean>): () => void {
  const descriptors = new Map(
    Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(replacements))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  return () => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}

export function installWindowGlobals(window: Window): () => void {
  return installGlobals({
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    KeyboardEvent: window.KeyboardEvent,
    Node: window.Node,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
}

export function mountWindow(window: Window): {
  readonly host: HTMLElement;
  readonly restoreGlobals: () => void;
  readonly root: Root;
} {
  const restoreGlobals = installWindowGlobals(window);
  const host = document.createElement("div");
  document.body.append(host);
  return { host, restoreGlobals, root: createRoot(host) };
}

export function signal(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve: () => void = () => {
    // Replaced synchronously by the Promise constructor.
  };
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** The shell's static markup with the endpoint query already answered, or still in flight. */
export function renderShell(
  endpoint: "pending" | null = null,
  sessions: readonly Session[] = [],
  host: RendererPlatform = testPlatform,
): string {
  const client = new QueryClient();
  for (const session of sessions) cacheSession(client, session);
  if (endpoint !== "pending") client.setQueryData(queryKeys.gatewayEndpoint, endpoint);
  return renderToStaticMarkup(
    <StateProvider client={client}>
      <App platform="darwin" storage={null} host={host} />
    </StateProvider>,
  );
}

/** The element carrying a `data-ui` name, as its opening tag. */
export function tag(html: string, name: string): string {
  const escaped = name.replace(".", "\\.");
  const match = html.match(new RegExp(`<[a-z]+[^>]*data-ui="${escaped}"[^>]*>`));
  if (match === null) throw new Error(`no element named ${name}`);
  return match[0];
}
