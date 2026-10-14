import { describe, expect, test } from "bun:test";
import type { LedgerAction } from "@openomni/protocol";
import { CHILD, PARENT, useForkFixture } from "./helpers/fork-fixture";
import * as SessionHandleStore from "../../src/core/store/fence";

const { stores, child, fixture } = useForkFixture();

const OUTPUT_ID = `sha256:${"ab".repeat(32)}`;
const OTHER_ID = `sha256:${"cd".repeat(32)}`;
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("tool_outputs storage (#1305)", () => {
  test("put/get roundtrip keeps bytes and the media hint; unknown ids read as undefined", () => {
    stores.kernel.putToolOutput({ outputId: OUTPUT_ID, bytes: bytesOf("payload"), mediaType: "text/plain" });
    const stored = stores.kernel.toolOutput(OUTPUT_ID);
    expect(stored).toBeDefined();
    expect(new TextDecoder().decode(stored?.bytes)).toBe("payload");
    expect(stored?.mediaType).toBe("text/plain");
    expect(stores.kernel.toolOutput(OTHER_ID)).toBeUndefined();
  });

  test("a repeated put of the same identifier is a no-op — the digest key dedupes", () => {
    stores.session.toolOutputs.put({ outputId: OTHER_ID, bytes: bytesOf("first") });
    stores.session.toolOutputs.put({ outputId: OTHER_ID, bytes: bytesOf("second write ignored") });
    const stored = stores.session.toolOutputs.get(OTHER_ID);
    expect(new TextDecoder().decode(stored?.bytes)).toBe("first");
    expect(stored?.mediaType).toBeUndefined();
  });
});

/** A pre-anchor row whose effect carries a stored-output ref (fork rule). */
function refRow(parentId: string, outputId: string, bytes: number): LedgerAction.Append {
  return {
    id: `ref-${outputId.slice(7, 13)}`,
    parentId,
    sessionId: PARENT,
    kind: "action",
    intent: { encodingVersion: 1, value: { op: "projected-tool" } },
    effect: {
      encodingVersion: 1,
      value: { phase: "result", result: { outputRef: { outputId, bytes, preview: "pre" } } },
    },
    irreversible: true,
    ts: 6,
  };
}

/** A fresh boundary anchor committed after the ref row. */
function terminalRow(turnId: string): LedgerAction.Append {
  return {
    id: `${turnId}:terminal`,
    parentId: null,
    sessionId: PARENT,
    kind: "turn",
    intent: { encodingVersion: 1, value: { phase: "terminal", turnId } },
    effect: { encodingVersion: 1, value: { phase: "terminal", turnId } },
    irreversible: true,
    ts: 7,
  };
}

function hashOf(id: string): string {
  const nodes = stores.kernel.historyPage(PARENT, { afterRevision: 0, limit: 100 }).actions;
  const node = nodes.find((candidate) => candidate.id === id);
  if (node === undefined) throw new Error(`missing parent node ${id}`);
  return node.actionHash;
}

describe("Session.fork copies referenced tool outputs (#1305)", () => {
  test("outputs referenced by copied rows land on the child under the same identifiers", () => {
    const parent = fixture.buildParent();
    stores.kernel.putToolOutput({ outputId: OUTPUT_ID, bytes: bytesOf("forked bytes"), mediaType: "text/plain" });
    stores.kernel.putToolOutput({ outputId: OTHER_ID, bytes: bytesOf("unreferenced") });
    // The ref row sits before the boundary anchor the fork uses.
    fixture.commit(parent.authority, [refRow("turn-1:terminal", OUTPUT_ID, 12), terminalRow("turn-2")]);

    fixture.forked(hashOf("turn-2:terminal"));
    const childKernel = SessionHandleStore.createSessionKernel(child(), stores.catalog);
    const copied = childKernel.toolOutput(OUTPUT_ID);
    expect(copied).toBeDefined();
    expect(new TextDecoder().decode(copied?.bytes)).toBe("forked bytes");
    expect(copied?.mediaType).toBe("text/plain");
    // Only referenced outputs travel: the unreferenced one stays parent-only.
    expect(childKernel.toolOutput(OTHER_ID)).toBeUndefined();
    const verdict = childKernel.verifyChain(CHILD);
    expect(verdict.kind).toBe("intact");
  });

  test("referenced output bytes count against the fork copy cap", () => {
    const parent = fixture.buildParent();
    const large = new Uint8Array(4096).fill(120);
    stores.kernel.putToolOutput({ outputId: OUTPUT_ID, bytes: large });
    fixture.commit(parent.authority, [refRow("turn-1:terminal", OUTPUT_ID, large.byteLength), terminalRow("turn-2")]);
    // Rows alone fit under 4096 bytes; the 4096-byte output pushes past it.
    fixture.pinForkCap(parent.authority, 4096);
    const refusal = fixture.refusalOf(fixture.fork(hashOf("turn-2:terminal")));
    expect(refusal.reason).toBe("byte_cap");
    expect(refusal.detail).toContain("exceed the cap 4096");
  });
});

test("a referenced output the parent no longer holds refuses the fork with no child row or index", () => {
  const parent = fixture.buildParent();
  fixture.commit(parent.authority, [refRow("turn-1:terminal", OUTPUT_ID, 12), terminalRow("turn-2")]);
  const refusal = fixture.refusalOf(fixture.fork(hashOf("turn-2:terminal")));
  expect(refusal.reason).toBe("output_missing");
  expect(refusal.detail).toBe(`parent holds no tool output ${OUTPUT_ID}`);
  expect(child().sessions.get(CHILD)).toBeUndefined();
  expect(stores.catalog.sessionIndex(CHILD)).toBeUndefined();
});
