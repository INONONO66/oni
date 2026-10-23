import { afterEach, beforeEach } from "bun:test";
import { createChannelStores } from "@oni/channels";
import type { TestLedgerPlane as AppLedgerPlane } from "./ledger";
import { channelStoreSource } from "../../src/gateway";
import { testPlane } from "./ledger";
import { testClock } from "./test-entropy";

/** A per-test standalone ledger plane and its channel-store view; the
 * beforeEach/afterEach hooks bind to the calling describe scope. */
export function planeFixture() {
  const planeRef: { current: AppLedgerPlane | undefined } = { current: undefined };
  function plane(): AppLedgerPlane {
    if (planeRef.current === undefined) throw new Error("test plane not open");
    return planeRef.current;
  }
  const channelStores = () => createChannelStores(channelStoreSource(plane(), testClock()));
  beforeEach(() => {
    planeRef.current = testPlane();
  });
  afterEach(() => {
    planeRef.current?.close();
    planeRef.current = undefined;
  });
  return { plane, channelStores };
}
