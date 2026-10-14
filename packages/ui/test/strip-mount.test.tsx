import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { SidebarFrame } from "./sidebar-frame";

/**
 * The strip's history trio is ONE node for the window's life: collapsing and
 * re-opening the sidebar changes nothing about its identity (it slides with the
 * zone's width; it carries no state attribute and no fade). The sidebar's
 * container is ONE node across its three modes too: hidden -> overlay -> pinned
 * is a class change on the same element, which is what lets the floating panel
 * morph into the column instead of a second column growing beside it. Both are
 * asserted on a live React root over a DOM, because static markup cannot see a
 * remount: the same HTML comes out of a node that was replaced and one that was
 * kept.
 *
 * The DOM is registered BEFORE `react-dom/client` loads: the client renderer
 * decides whether it can use a DOM at module evaluation.
 */
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act, useEffect, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Sidebar } = await import("../src/sidebar");
const { SidebarToggle, TabStrip } = await import("../src/tab-strip");
const { SidebarHeader } = await import("../src/sidebar-nav");
const { STRIP } = await import("./fixture");

afterAll(() => GlobalRegistrator.unregister());

/** Counts the trio's commits: a remount would run the mount effect again. */
let mounts = 0;
function MountProbe() {
  useEffect(() => {
    mounts += 1;
  }, []);
  return null;
}

function Frame({ open, floating = false }: { readonly open: boolean; readonly floating?: boolean }) {
  return (
    <SidebarFrame floating={floating} open={open}>
      <Sidebar.Container>
        <ContainerMountProbe />
      </Sidebar.Container>
      <MountProbe />
    </SidebarFrame>
  );
}

/** Counts the container's children's commits: a remount of the box would run this again. */
let containerMounts = 0;
function ContainerMountProbe() {
  useEffect(() => {
    containerMounts += 1;
  }, []);
  return null;
}

const containerOf = (root: Element) => {
  const node = root.querySelector<HTMLElement>('[data-ui="Sidebar.Container"]');
  if (node === null) throw new Error("no container");
  return node;
};

const trioOf = (container: Element) => {
  const node = container.querySelector('[data-ui="TabStrip.Trio"]');
  if (node === null) throw new Error("no trio");
  return node;
};

const toggleOf = (container: Element) => {
  const node = container.querySelector<HTMLElement>('[data-ui="Sidebar.Toggle"]');
  if (node === null) throw new Error("no toggle");
  return node;
};

describe("the trio's identity", () => {
  test("Given the strip open, When the sidebar collapses and re-opens, Then the trio is the same node", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(() => root.render(<Frame open />));
    const trio = trioOf(container);
    expect(trio.hasAttribute("data-collapsed")).toBe(false);
    trio.setAttribute("data-probe", "survives");
    const buttons = Array.from(trio.querySelectorAll("button"));
    expect(buttons).toHaveLength(3);

    await act(() => root.render(<Frame open={false} />));
    expect(trioOf(container)).toBe(trio);
    expect(Array.from(trio.querySelectorAll("button"))).toEqual(buttons);

    await act(() => root.render(<Frame open />));
    expect(trioOf(container)).toBe(trio);
    expect(trio.getAttribute("data-probe")).toBe("survives");
    expect(Array.from(trio.querySelectorAll("button"))).toEqual(buttons);
    expect(mounts).toBe(1);

    await act(() => root.unmount());
    container.remove();
  });
});

/** The toggle drives the open state, as it does under the app's store. */
function LiveFrame() {
  const [open, setOpen] = useState(true);
  return (
    <Sidebar
      floating={false}
      onFloatingChange={() => undefined}
      onToggle={() => setOpen((value) => !value)}
      onWidthCommit={() => undefined}
      open={open}
      width={252}
    >
      <TabStrip {...STRIP} platform="darwin" />
      <Sidebar.Gap />
      <Sidebar.Container>
        <SidebarHeader actions={open ? <SidebarToggle /> : null} brand={null} />
      </Sidebar.Container>
    </Sidebar>
  );
}

describe("the toggle's focus", () => {
  test("Given the toggle focused, When it is activated, Then its replacement in the other host owns focus", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(() => root.render(<LiveFrame />));
    const headerToggle = toggleOf(host);
    headerToggle.focus();
    expect(document.activeElement).toBe(headerToggle);

    await act(() => headerToggle.click());
    const stripToggle = toggleOf(host);
    expect(stripToggle).not.toBe(headerToggle);
    expect(stripToggle.closest('[data-ui="TabStrip.Controls"]')).not.toBeNull();
    expect(document.activeElement).toBe(stripToggle);

    await act(() => stripToggle.click());
    const reopened = toggleOf(host);
    expect(reopened.closest('[data-ui="Sidebar.Header"]')).not.toBeNull();
    expect(document.activeElement).toBe(reopened);

    await act(() => root.unmount());
    host.remove();
  });

  test("Given focus elsewhere, When the toggle is clicked, Then the replacement does not take focus", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(() => root.render(<LiveFrame />));
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.focus();
    expect(document.activeElement).toBe(elsewhere);

    await act(() => toggleOf(host).click());
    expect(toggleOf(host).closest('[data-ui="TabStrip.Controls"]')).not.toBeNull();
    expect(document.activeElement).toBe(elsewhere);

    await act(() => root.unmount());
    host.remove();
    elsewhere.remove();
  });
});

describe("the toggle's placement", () => {
  test("Given the strip open, When the sidebar collapses, Then the toggle enters the zone before the trio and leaves on re-open", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(() => root.render(<Frame open />));
    const headerToggle = toggleOf(host);
    expect(headerToggle.closest('[data-ui="Sidebar.Header"]')).not.toBeNull();
    expect(host.querySelectorAll('[data-ui="Sidebar.Toggle"]')).toHaveLength(1);
    const trio = trioOf(host);

    await act(() => root.render(<Frame open={false} />));
    const toggle = toggleOf(host);
    expect(toggle).not.toBe(headerToggle);
    expect(host.querySelectorAll('[data-ui="Sidebar.Toggle"]')).toHaveLength(1);
    expect(toggle.closest('[data-ui="TabStrip.Controls"]')).not.toBeNull();
    expect(toggle.compareDocumentPosition(trio) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-label")).toBe("Expand sidebar");
    expect(toggle.dataset.size).toBe("base");
    expect(toggle.dataset.variant).toBe("plain");
    expect(toggleOf(host).querySelector("svg")?.dataset.opened).toBe("false");
    expect(trioOf(host)).toBe(trio);

    // Revealed: the glyph reads the column as showing while the button still offers to pin.
    await act(() => root.render(<Frame floating open={false} />));
    expect(toggleOf(host)).toBe(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.querySelector("svg")?.dataset.opened).toBe("true");

    await act(() => root.render(<Frame open />));
    expect(toggleOf(host).closest('[data-ui="Sidebar.Header"]')).not.toBeNull();
    expect(host.querySelectorAll('[data-ui="Sidebar.Toggle"]')).toHaveLength(1);
    expect(trioOf(host)).toBe(trio);

    await act(() => root.unmount());
    host.remove();
  });

  test("Given a bare provider, When the toggle mounts outside the strip, Then it reads the pinned state", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const toggles: boolean[] = [];
    await act(() =>
      root.render(
        <Sidebar
          floating={false}
          onFloatingChange={() => undefined}
          onToggle={() => toggles.push(true)}
          onWidthCommit={() => undefined}
          open
          width={252}
        >
          <SidebarToggle />
        </Sidebar>,
      ),
    );
    const toggle = toggleOf(host);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe("Collapse sidebar");
    expect(toggle.querySelector("svg")?.dataset.opened).toBe("true");
    await act(() => toggle.click());
    expect(toggles).toEqual([true]);

    await act(() => root.unmount());
    host.remove();
  });
});

describe("the container's identity across modes", () => {
  test("Given a collapsed sidebar, When the reveal floats it and a pin lands it, Then hidden -> overlay -> pinned is the same node with one mount", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    containerMounts = 0;
    await act(() => root.render(<Frame open={false} />));
    const box = containerOf(host);
    expect(box.dataset.mode).toBe("hidden");
    box.setAttribute("data-probe", "morph");

    await act(() => root.render(<Frame floating open={false} />));
    expect(containerOf(host)).toBe(box);
    expect(box.dataset.mode).toBe("overlay");
    expect(box.className).toContain("left-2");

    // The pin: `open` flips while `floating` is still set, exactly as the
    // store hands it over. The overlay's node becomes the pinned column.
    await act(() => root.render(<Frame floating open />));
    expect(containerOf(host)).toBe(box);
    expect(box.dataset.mode).toBe("pinned");
    expect(box.dataset.probe).toBe("morph");
    expect(box.className).toContain("left-0");
    expect(box.className).toContain("transition-[translate,inset,width,border-radius,box-shadow]");

    // And back: collapsing keeps it too.
    await act(() => root.render(<Frame open={false} />));
    expect(containerOf(host)).toBe(box);
    expect(box.dataset.mode).toBe("hidden");
    expect(containerMounts).toBe(1);

    await act(() => root.unmount());
    host.remove();
  });
});
