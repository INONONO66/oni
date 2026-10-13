import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import { installGlobals, mountWindow } from "../helpers";

export function automationRenderer() {
  const window = new Window({ url: "http://localhost" });
  const { host, root, restoreGlobals } = mountWindow(window);
  const restoreForm = installGlobals({ Event: window.Event, FormData: window.FormData, HTMLInputElement: window.HTMLInputElement, HTMLTextAreaElement: window.HTMLTextAreaElement, HTMLSelectElement: window.HTMLSelectElement });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  notifyManager.setScheduler((callback) => callback());
  return {
    host, client,
    async render(node: ReactNode) { await act(async () => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)); },
    async click(text: string) {
      const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === text);
      if (button === undefined) throw new Error(`Missing button ${text}`);
      await act(async () => button.click());
    },
    async field(label: string, value: string) {
      const element = [...host.querySelectorAll("label")].find((node) => node.querySelector("span")?.textContent === label)?.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select");
      if (element === null || element === undefined) throw new Error(`Missing field ${label}`);
      await act(async () => {
        if (element instanceof HTMLSelectElement) {
          element.value = value;
          element.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          const prototype = element.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
          element.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
    },
    async submit() {
      const form = host.querySelector("form");
      if (form === null) throw new Error("Missing form");
      await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    },
    async close() {
      await act(() => root.unmount());
      client.clear();
      host.remove();
      restoreForm();
      restoreGlobals();
      await window.happyDOM.close();
      notifyManager.setScheduler((callback) => setTimeout(callback, 0));
    },
  };
}
