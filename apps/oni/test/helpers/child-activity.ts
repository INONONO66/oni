import type { ChildWatch } from "../../src/bundles/child-activity/index";

export const spec: ChildWatch = {
  id: "child-source",
  sessionId: "parent",
  contact: "reviewer",
  child: "child-redacted",
  turn: "turn-redacted",
  machine: "self",
  cursor: {
    sessionId: "child-redacted",
    generation: 1,
    byteOffset: 0,
    recordHash: "a".repeat(64),
  },
};
