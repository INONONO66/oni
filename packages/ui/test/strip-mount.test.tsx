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
const { act, useEffect } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Sidebar } = await import("../src/sidebar");

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
