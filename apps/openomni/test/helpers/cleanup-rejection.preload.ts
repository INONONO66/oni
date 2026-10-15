import { spyOn } from "bun:test";
import * as fixtures from "./resident-suite";

// An explicit subprocess-only probe: real cleanup runs first and must resolve.
const residentSuite = fixtures.residentSuite;
spyOn(fixtures, "residentSuite").mockImplementation((afterStop) => {
  const suite = residentSuite(afterStop);
  const cleanup = suite.cleanup;
  suite.cleanup = async () => {
    await cleanup();
    console.log("U1_REAL_CLEANUP_RESOLVED");
    const error = new Error("U1_TEARDOWN_REJECTION");
    error.name = "U1_TEARDOWN_REJECTION";
    throw error;
  };
  return suite;
});
