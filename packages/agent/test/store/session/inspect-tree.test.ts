import { describe, expect, test } from "bun:test";
import { CHILD, PARENT, useForkFixture } from "../helpers/fork-fixture";
import * as SessionHandleStore from "../../../src/core/store/fence";
import { forkAncestryOf, forkAside, inspectTree } from "../../../src/inspect/tree";

const { stores, child, fixture } = useForkFixture();

describe("inspect tree (#1257)", () => {
  test("projects the ancestry tree with fork pins and asides from catalog edges", () => {
    const parent = fixture.buildParent();
    const receipt = fixture.forked(parent.hashOf("turn-1:terminal"));
    const childKernel = SessionHandleStore.createSessionKernel(child(), stores.catalog);

    // Ancestry reads the genesis pin; a root session has none.
    const ancestry = forkAncestryOf(childKernel, CHILD);
    expect(ancestry).toEqual(receipt.forkedFrom);
    expect(forkAncestryOf(stores.kernel, PARENT)).toBeNull();
    if (ancestry === null) throw new Error("child ancestry missing");

    const tree = inspectTree(stores.kernel, PARENT, {}, (id) =>
      id === CHILD ? childKernel : stores.kernel,
    );
    expect(tree.sessionId).toBe(PARENT);
    expect(tree.forkedFrom).toBeNull();
    expect(tree.aside).toBeNull();
    expect(tree.children.map((node) => node.sessionId)).toEqual([CHILD]);
    const node = tree.children[0];
    expect(node?.parentId).toBe(PARENT);
    expect(node?.forkedFrom).toEqual(ancestry);
    expect(node?.aside).toBe(forkAside(ancestry));
    expect(node?.children).toEqual([]);
    expect(node?.nextChildrenCursor).toBeNull();

    // Depth 0 stops at the root without reading children.
    const shallow = inspectTree(stores.kernel, PARENT, { depth: 0 });
    expect(shallow.children).toEqual([]);

    // A filled child page advertises its continuation cursor.
    const paged = inspectTree(stores.kernel, PARENT, { limit: 1 }, (id) =>
      id === CHILD ? childKernel : stores.kernel,
    );
    expect(paged.nextChildrenCursor).toBe(CHILD);
  });
});
