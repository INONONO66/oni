import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConsoleContent } from "../src/console";
import { UI_NAMES } from "../src/names";
import type { TranscriptNode } from "../src/timeline/model";

/**
 * A session with no turns yet is ONE surface, not an empty column with a field
 * docked under it: the label and the composer sit together at the center, and
 * the first turn moves the same field to the column's foot. The move is
 * asserted on a live root over a DOM, because two static renders cannot show
 * that the hero gives way rather than stacking under the transcript.
 */

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  await GlobalRegistrator.unregister();
});

const address = (name: string) => `[data-ui="${name}"]`;

function node(selector: string): HTMLElement {
  const element = host.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`Missing ${selector}`);
  return element;
}

const tokens = (element: Element) => element.className.split(/\s+/).filter(Boolean);

const LABEL = "Say what to do.";
const FIRST: readonly TranscriptNode[] = [{ kind: "prompt", id: "p1", text: "go" }];

type Transcript = NonNullable<ComponentProps<typeof ConsoleContent>["transcript"]>;

const sendable = (nodes: readonly TranscriptNode[]): Transcript => ({
  id: "s",
  nodes,
  draft: "",
  onDraftChange: () => undefined,
  onSubmit: () => undefined,
});

describe("the new-session surface", () => {
  test("Given no turns and a way to send, When rendered, Then the label and the one composer are centered, and the first turn docks the field", async () => {
    const render = (nodes: readonly TranscriptNode[]) =>
      act(() =>
        root.render(
          <ConsoleContent emptyLabel={LABEL} header={<p data-head />} transcript={sendable(nodes)} />,
        ),
      );
    await render([]);
    const content = node(address(UI_NAMES.ConsoleContent));
    const hero = node(address(UI_NAMES.ConsoleHero));
    expect(hero.parentElement).toBe(content);
    expect(hero.previousElementSibling).toBe(node("[data-head]"));
    expect(hero.nextElementSibling).toBeNull();
    expect(tokens(hero)).toEqual([
      "flex",
      "min-h-0",
      "flex-1",
      "flex-col",
      "items-center",
      "justify-center",
      "px-section",
    ]);
    const column = node(`${address(UI_NAMES.ConsoleHero)} > div`);
    expect(tokens(column)).toEqual(["flex", "w-full", "max-w-new-column", "flex-col", "gap-4"]);
    const label = node(`${address(UI_NAMES.ConsoleHero)} > div > p`);
    expect(label.textContent).toBe(LABEL);
    expect(tokens(label)).toEqual(["text-meta", "text-fg-faint"]);
    const composer = node(address(UI_NAMES.Composer));
    expect(label.nextElementSibling).toBe(composer);
    expect(composer.parentElement).toBe(column);
    expect(composer.nextElementSibling).toBeNull();
    expect(host.querySelectorAll(address(UI_NAMES.Composer))).toHaveLength(1);
    expect(node("textarea").getAttribute("aria-label")).toBe("Message");
    expect(host.querySelector(address(UI_NAMES.ScrollArea))).toBeNull();
    expect(host.querySelector(address(UI_NAMES.Timeline))).toBeNull();

    await render(FIRST);
    expect(host.querySelector(address(UI_NAMES.ConsoleHero))).toBeNull();
    const docked = node(address(UI_NAMES.Composer));
    expect(docked.parentElement).toBe(node(address(UI_NAMES.ConsoleContent)));
    expect(docked.previousElementSibling).toBe(node(address(UI_NAMES.ScrollArea)));
    expect(docked.nextElementSibling).toBeNull();
    expect(host.querySelectorAll(address(UI_NAMES.Composer))).toHaveLength(1);
    expect(node(address(UI_NAMES.Timeline)).textContent).toContain("go");
  });

  test("Given no turns and no way to send, When rendered, Then there is no hero and the column carries the label as before", async () => {
    await act(() =>
      root.render(
        <ConsoleContent
          emptyLabel={LABEL}
          transcript={{ id: "s", nodes: [], onDraftChange: () => undefined }}
        />,
      ),
    );
    expect(host.querySelector(address(UI_NAMES.ConsoleHero))).toBeNull();
    expect(host.querySelector(address(UI_NAMES.Composer))).toBeNull();
    expect(host.querySelector("textarea")).toBeNull();
    const scroll = node(address(UI_NAMES.ScrollArea));
    expect(scroll.parentElement).toBe(node(address(UI_NAMES.ConsoleContent)));
    expect(scroll.nextElementSibling).toBeNull();
    const timeline = node(address(UI_NAMES.Timeline));
    expect(scroll.contains(timeline)).toBe(true);
    expect(timeline.textContent).toBe(LABEL);
  });

  test("Given no transcript, When rendered, Then the label sits in the scroll region and nothing is a hero", async () => {
    await act(() => root.render(<ConsoleContent emptyLabel={LABEL} />));
    expect(host.querySelector(address(UI_NAMES.ConsoleHero))).toBeNull();
    expect(host.querySelector(address(UI_NAMES.Composer))).toBeNull();
    const label = node(`${address(UI_NAMES.ScrollArea)} p`);
    expect(label.textContent).toBe(LABEL);
    expect(tokens(label)).toEqual(["text-meta", "text-fg-faint"]);
  });
});
