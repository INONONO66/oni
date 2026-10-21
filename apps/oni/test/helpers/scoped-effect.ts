import { afterEach } from "bun:test";
import { closeAcquiredEffects } from "./effect";

// Kept separate from effect.ts: subprocess fixtures use its runners outside bun test.
afterEach(closeAcquiredEffects);
export { acquireEffect, acquireSyncEffect, runEffect, runSyncEffect } from "./effect";
