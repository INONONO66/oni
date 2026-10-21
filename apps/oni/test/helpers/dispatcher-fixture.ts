import { Bundle, Core } from "@oni/agent";
const createDispatcher = Bundle.createDispatcher;
const ToolCatalog = Core.ToolCatalog;
import type { AnyToolDefinition } from "@oni/protocol";
import { Effect } from "effect";
import { runSyncEffect } from "./effect";

export function dispatcherFixture(definitions: readonly AnyToolDefinition[], options?: Parameters<typeof createDispatcher>[0]) {
  return runSyncEffect(createDispatcher(options).pipe(Effect.provideService(ToolCatalog, { definitions })));
}
