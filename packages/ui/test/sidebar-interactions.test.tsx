import { afterAll, expect, jest, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Sidebar, SIDEBAR_REVEAL } from "../src/sidebar";
import { SectionHeader, SectionList } from "../src/sidebar-nav";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
afterAll(() => GlobalRegistrator.unregister());

function Frame() {
  const [open, setOpen] = useState(false);
  const [floating, setFloating] = useState(false);
  const [width, setWidth] = useState(240);
  const [searching, setSearching] = useState(false);
  return (
    <Sidebar
      floating={floating}
      onFloatingChange={setFloating}
      onToggle={() => setOpen(!open)}
      onWidthCommit={setWidth}
      open={open}
      width={width}
    >
      <button onClick={() => setOpen(!open)} type="button">
        Toggle
      </button>
      <Sidebar.Container>
        <SectionHeader
          label="Sessions"
          onSearchingChange={setSearching}
          searchLabel="Search"
          searching={searching}
        >
          <input aria-label="Search sessions" />
        </SectionHeader>
        <SectionList>Rows</SectionList>
      </Sidebar.Container>
    </Sidebar>
  );
}

function element(host: HTMLElement, selector: string): HTMLElement {
  const found = host.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`missing ${selector}`);
  return found;
}

const pointer = (target: HTMLElement, type: string, init: PointerEventInit = {}) =>
  act(() => target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, ...init })));

const key = (target: HTMLElement | Document, value: string, shiftKey = false) =>
  act(() =>
    target.dispatchEvent(new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true })),
  );

test("mounted hover reveals, cancels across hot zones and dismisses on Escape, pin and unmount", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(() => root.render(<Frame />));
  jest.useFakeTimers();
  const box = element(host, '[data-ui="Sidebar.Container"]');
  const edge = element(host, '[data-ui="Sidebar.Edge"]');
  const toggle = element(host, "button");
  try {
    await pointer(edge, "pointerover");
    await pointer(edge, "pointerout");
    await act(() => jest.advanceTimersByTime(SIDEBAR_REVEAL.openDelay));
    expect(box.dataset.mode).toBe("hidden");
    await pointer(edge, "pointerover");
    await act(() => jest.advanceTimersByTime(SIDEBAR_REVEAL.openDelay));
    expect(box.dataset.mode).toBe("overlay");
    await pointer(edge, "pointerout");
    await pointer(box, "pointerover");
    await act(() => jest.advanceTimersByTime(SIDEBAR_REVEAL.closeDelay));
    expect(box.dataset.mode).toBe("overlay");
    await key(document, "x");
    expect(box.dataset.mode).toBe("overlay");
    await key(document, "Escape");
    expect(box.dataset.mode).toBe("hidden");
    await pointer(edge, "pointerover");
    await act(() => toggle.click());
    await act(() => jest.advanceTimersByTime(SIDEBAR_REVEAL.openDelay));
    expect(box.dataset.mode).toBe("pinned");
    await act(() => toggle.click());
    await pointer(element(host, '[data-ui="Sidebar.Edge"]'), "pointerover");
    await act(() => jest.advanceTimersByTime(SIDEBAR_REVEAL.openDelay));
    expect(box.dataset.mode).toBe("overlay");
    await pointer(box, "pointerout");
    await act(() => jest.advanceTimersByTime(SIDEBAR_REVEAL.closeDelay));
    expect(box.dataset.mode).toBe("hidden");
    const clear = spyOn(globalThis, "clearTimeout");
    const schedule = spyOn(globalThis, "setTimeout");
    try {
      await pointer(element(host, '[data-ui="Sidebar.Edge"]'), "pointerover");
      expect(schedule).toHaveBeenCalledTimes(1);
      await act(() => root.unmount());
      expect(clear).toHaveBeenCalledTimes(1);
      expect(clear).toHaveBeenCalledWith(schedule.mock.results[0]?.value);
    } finally {
      clear.mockRestore();
      schedule.mockRestore();
    }
  } finally {
    jest.useRealTimers();
    await act(() => root.unmount());
    host.remove();
  }
});

test("mounted splitter coalesces pointer frames, commits or cancels, and supports keyboard resizing", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(() => root.render(<Frame />));
  await act(() => element(host, "button").click());
  const handle = element(host, '[data-ui="Sidebar.ResizeHandle"]');
  // The handle is a silent hit zone: cursor feedback only, no line drawn on hover or drag.
  expect(handle.className.includes("cursor-col-resize")).toBe(true);
  expect(handle.className.includes("after:")).toBe(false);
  const frame = element(host, '[data-ui="Sidebar"]');
  const capture = mock((_id: number) => undefined);
  Object.defineProperty(handle, "setPointerCapture", { value: capture });
  let scheduled: FrameRequestCallback | undefined;
  const request = spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
    scheduled = callback;
    return 1;
  });
  const cancel = spyOn(globalThis, "cancelAnimationFrame").mockImplementation((_id) => {
    scheduled = undefined;
  });
  try {
    await pointer(handle, "pointermove", { clientX: 280 });
    await pointer(handle, "pointerup");
    await pointer(handle, "pointerdown", { button: 2, clientX: 240 });
    expect(capture).not.toHaveBeenCalled();
    await pointer(handle, "pointerdown", { button: 0, clientX: 240 });
    expect(capture).toHaveBeenCalledWith(1);
    expect(frame.hasAttribute("data-resizing")).toBe(true);
    await pointer(handle, "pointermove", { clientX: 260 });
    await pointer(handle, "pointermove", { clientX: 280 });
    expect(request).toHaveBeenCalledTimes(1);
    expect(scheduled).toBeDefined();
    await act(() => scheduled?.(0));
    expect(frame.style.getPropertyValue("--sidebar-width")).toBe("280px");
    await pointer(handle, "pointerup");
    expect(handle.getAttribute("aria-valuenow")).toBe("280");
    expect(frame.hasAttribute("data-resizing")).toBe(false);
    expect(document.body.style.cursor).toBe("");
    await pointer(handle, "pointerdown", { button: 0, clientX: 280 });
    await pointer(handle, "pointermove", { clientX: 100 });
    await pointer(handle, "pointercancel");
    expect(cancel).toHaveBeenCalledWith(1);
    expect(frame.style.getPropertyValue("--sidebar-width")).toBe("280px");
    expect(handle.getAttribute("aria-valuenow")).toBe("280");
    await key(handle, "ArrowLeft");
    expect(handle.getAttribute("aria-valuenow")).toBe("272");
    await key(handle, "ArrowRight", true);
    expect(handle.getAttribute("aria-valuenow")).toBe("304");
    await key(handle, "x");
    expect(handle.getAttribute("aria-valuenow")).toBe("304");
    await act(() => element(host, '[data-ui="SectionHeader.Toggle"]').click());
    expect(host.querySelector("input")).not.toBeNull();
    await act(() => element(host, '[data-ui="SectionHeader.Toggle"]').click());
    expect(host.querySelector("input")).toBeNull();
  } finally {
    request.mockRestore();
    cancel.mockRestore();
    await act(() => root.unmount());
    host.remove();
  }
});

test("sidebar consumers reject a missing provider", () => {
  expect(() => renderToStaticMarkup(<Sidebar.Container>Rows</Sidebar.Container>)).toThrow();
});
