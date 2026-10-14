import { foldSessionHistory, hydrateSessionHistory } from "../../src/inspect/history";
import { compactionPortService } from "../../src/plugins/compaction";

// Composition wires the compaction seam; fixtures get the real service
// by default. A test that wants the capability OFF sets the key explicitly
// (`compactionPort: undefined` / `compaction: undefined`).
export const fixtureCompactionPort = compactionPortService({
  fold: foldSessionHistory,
  hydrate: hydrateSessionHistory,
});
