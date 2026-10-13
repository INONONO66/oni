import { foldSessionHistory, hydrateSessionHistory } from "../../src/inspect/history";
import { compactionSeamService } from "../../src/plugins/compaction";

// Composition wires the compaction seam; fixtures get the real service
// by default. A test that wants the capability OFF sets the key explicitly
// (`compactionSeam: undefined` / `compaction: undefined`).
export const fixtureCompactionSeam = compactionSeamService({
  fold: foldSessionHistory,
  hydrate: hydrateSessionHistory,
});
