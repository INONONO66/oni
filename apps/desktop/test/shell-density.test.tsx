import { beforeAll, describe, expect, test } from "bun:test";
import { Timeline } from "@openomni/ui";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "../src/renderer/app";
import { uiMessagesToTranscript } from "../src/renderer/chat/adapter";
import type { OpenOmniUIMessage } from "../src/renderer/chat/message";
import { StateProvider } from "../src/renderer/state/provider";
import { consoleStore, createSession, INITIAL_CLIENT_STATE } from "../src/renderer/state/store";
import { testPlatform } from "./helpers/platform";

/**
 * The renderer reads at Shell density, and every transcript role declares its
 * type level.
 *
 * This is the regression test for the defect the owner reported: the shell
 * rendered its transcript in the sans prose ramp two steps too large, and every
 * other gate stayed green. Two independent causes produced it, so both are
 * pinned separately here.
 *
 *   1. The window root did not carry `data-density="shell"`, so the whole
 *      surface fell back to the System scale.
 *   2. Row content that declared a tone but no LEVEL inherited the document's
 *      16px default, which no token in the system names.
 *
 * `packages/ui/test/density.test.ts` pins what the shell tokens ARE. This file
 * pins that this surface is actually inside them.
 */

/** The shell with one session open, so both columns have rows to measure. */
let SHELL = "";
beforeAll(() => {
  consoleStore.setState(() => INITIAL_CLIENT_STATE);
  createSession(1);
  SHELL = renderToStaticMarkup(
    <StateProvider>
      <App platform="darwin" storage={null} host={testPlatform} />
    </StateProvider>,
  );
  consoleStore.setState(() => INITIAL_CLIENT_STATE);
});

/**
 * One conversation as SDK messages, so the nodes this file asserts on are the
 * ADAPTER'S output — the same crossing `App` makes. Rendering a hand-built node
 * array here would let the shell and this gate disagree about what the column
 * actually contains. Small on purpose: one prompt, one tool call, one answer.
 */
const MESSAGES: readonly OpenOmniUIMessage[] = [
  {
    id: "m1",
    role: "user",
    parts: [{ type: "text", text: "Why does append take the lease twice?" }],
  },
  {
    id: "m2",
    role: "assistant",
    parts: [
      {
        type: "tool-bash",
        toolCallId: "c1",
        state: "output-available",
        input: { command: "rg lease.acquire src/ledger/append.rs" },
        output: { stdout: "138: let lease = acquire();" },
      },
      { type: "text", text: "The retry branch re-enters acquire() without releasing." },
    ],
  },
];

const nodes = uiMessagesToTranscript(MESSAGES).nodes;

const transcript = () =>
  renderToStaticMarkup(<Timeline emptyLabel="empty" nodes={nodes} sessionId="density" />);

/**
 * The three voices, as the exact class pairs the transcript emits.
 *
 * They are spelled out here rather than imported so this gate is INDEPENDENT of
 * the module it checks: importing the voice table would make the test agree with
 * whatever the source says, including a fourth voice someone added.
 */
const PROSE = "text-[14px]/[21px]";
const META = "text-[12px]/[18px]";
const VOICES = ["14/21", "13/20", "12/18"];

describe("the shell renders at shell density", () => {
  test("Given the window root, When rendered, Then it declares the shell density scope", () => {
    // The attribute is on the ROOT because the whole window is the shell: the
    // navigator and the transcript are one surface at one density. Scoping it
    // lower leaves whichever column was missed on the System scale, which is
    // exactly how this regressed.
    expect(SHELL).toContain('data-density="shell"');
  });

  test("Given the window, When the scope is counted, Then exactly one element declares it", () => {
    // Nested density scopes are how a surface acquires two type scales. One
    // declaration, at the top, or the cascade decides per subtree.
    expect(SHELL.match(/data-density="shell"/g)).toHaveLength(1);
  });

  test("Given the density scope, When placed, Then it wraps both columns", () => {
    // The navigator must be INSIDE the scope, not a sibling of it: the reported
    // defect was visible in the sidebar first, because its rows are the densest
    // thing on screen.
    const at = SHELL.indexOf('data-density="shell"');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(SHELL.indexOf('aria-label="Sessions"')).toBeGreaterThan(at);
    expect(SHELL.indexOf("<main")).toBeGreaterThan(at);
  });
});

describe("the transcript sets exactly three voices", () => {
  test("Given the fixture, When adapted, Then there is a prompt and a tool call to assert on", () => {
    expect(nodes.some((node) => node.kind === "prompt")).toBe(true);
    expect(nodes.some((node) => node.kind === "tool")).toBe(true);
  });

  test("Given the transcript, When rendered, Then every size is one of the three voices", () => {
    // THE gate on the transcript law. Three voices and no fourth: any
    // `text-[Npx]` in the column that is not one of these three is a size the
    // reader has to learn, and at five sizes a system stops reading as a system.
    //
    // Code-fence INTERIORS are exempt because the `<pre>` owns one size for the
    // whole block and its syntax tokens carry tone only — the fence is asserted
    // as a unit separately.
    const outside = transcript()
      .split(/<pre[\s\S]*?<\/pre>/)
      .join("");
    const sizes = [...outside.matchAll(/text-\[(\d+)px\]\/\[(\d+)px\]/g)].map(
      (m) => `${m[1]}/${m[2]}`,
    );
    expect(sizes.length, "no sized text").toBeGreaterThan(0);
    for (const size of sizes) {
      expect(VOICES, `unnamed size ${size}`).toContain(size);
    }
  });

  test("Given the transcript markup, When scanned, Then no scale class leaks into it", () => {
    // The other half of the gate. The three voices are literal pixel pairs, so
    // a `text-body` or `text-meta` from the shared type scale appearing in the
    // column means something is being sized by the density scope instead — a
    // fourth voice that arrives without anyone declaring one.
    const outside = transcript()
      .split(/<pre[\s\S]*?<\/pre>/)
      .join("");
    for (const level of ["text-display", "text-title", "text-heading", "text-body", "text-label"]) {
      expect(outside, `${level} leaked into the transcript`).not.toContain(level);
    }
  });

  test("Given a tool call, When rendered, Then it is ONE line in the meta voice", () => {
    // A tool call is one line: `read  src/auth.ts · 34ms`. No row height, no
    // two-line layout, no status column — those belonged to the grammar this
    // replaced, and the row is the transcript's densest element becoming its
    // most decorated one the moment any of them come back.
    const html = transcript();
    const row = html.slice(html.indexOf("data-tool-row"));
    expect(row).toContain(META);
    expect(html).not.toContain('lines="two"');
    expect(html).not.toContain("h-row");
  });

  test("Given the transcript, When prose is rendered, Then it is the prose voice", () => {
    expect(transcript()).toContain(PROSE);
  });

  test("Given a user message, When rendered, Then it is a right-aligned block with no fill", () => {
    // The one asymmetry that tells two speakers apart. It must stay geometry:
    // a background or a border here is the chat bubble the column rejected.
    const html = transcript();
    const marker = html.indexOf("data-user-message");
    expect(marker).toBeGreaterThanOrEqual(0);
    // From the wrapper's own `<div` — the alignment class sits before the
    // marker attribute — up to the message's text, which is where the block's
    // classes end. A fixed-width window would silently stop asserting the
    // moment a fixture's prompt got longer.
    const block = html.slice(html.lastIndexOf("<div", marker), html.indexOf("</p>", marker));
    expect(block).toContain("justify-end");
    expect(block).toContain("max-w-[82%]");
    // Left-aligned TEXT inside a right-aligned block: right-set prose is
    // decoration, and this is something a person wrote.
    expect(block).toContain("text-left");
    expect(block).not.toMatch(/bg-(raised|sunken|accent|hover)/);
    expect(block).not.toMatch(/\bborder\b/);
  });
});

describe("the sidebar row keeps its own rank", () => {
  test("Given a session row, When rendered, Then the row is label and the section title is semibold label", () => {
    // The header shares the 13px row size and gains rank through weight.
    const nav = SHELL.slice(SHELL.indexOf('data-ui="Sidebar"'), SHELL.indexOf("<main"));
    expect(nav).toContain("text-label");
    const header = nav.slice(
      nav.indexOf('data-ui="SectionHeader"'),
      nav.indexOf('data-ui="SectionHeader.Toggle"'),
    );
    expect(header).toContain("text-label");
    expect(header).toContain("font-semibold");
  });

  test("Given the navigator, When scanned, Then no element sets a raw font size", () => {
    // Sizes in the SIDEBAR come from the shared scale or they are drift: an
    // arbitrary-value size class is how a single row escapes the density scope.
    //
    // The transcript is the deliberate exception and is excluded here rather
    // than exempted silently. Its three voices are literal pixel pairs BECAUSE
    // they must not be re-pointable by a density scope, and that rule is gated
    // above. Two different laws, so two different assertions.
    const nav = SHELL.slice(SHELL.indexOf('aria-label="Sessions"'), SHELL.indexOf("<main"));
    expect(nav.length).toBeGreaterThan(0);
    expect(nav).not.toMatch(/text-\[\d+(px|rem)\]/);
    expect(nav).not.toMatch(/font-size:/);
  });
});
