import { APPROVAL_POLICY } from "../../src/bundles/approval-policy/index";
import { testToolPorts } from "./tool-ports";
import { Effect } from "effect";
import { catalogLayer } from "../../../../packages/agent/test/helpers/service-layers";
import { runnerTestLayer } from "../../../../packages/agent/test/helpers/isolated";
import { acquireSyncEffect } from "./effect";
import { runEffect } from "./effect";
import { spyOn } from "bun:test";
import type { PlainObject } from "@openomni/protocol";
import type { CatalogOrigin } from "../../src/composition/catalog";
import { catalogDefinitions, type ToolPorts } from "../../src/composition/catalog";
import { Bundle } from "@openomni/agent";
const createTurnDispatcher = Bundle.createTurnDispatcher;
import { fixtureLedger, executorServices } from "./executor";

const RESIDENT: CatalogOrigin = { role: "resident", sessionId: "test" };
let nextCallId = 0;
export function dispatchModelTool(
  name: string,
  ports: Partial<ToolPorts>,
  origin: CatalogOrigin = RESIDENT,
  now?: () => number,
) {
  const definitions = now === undefined ? catalogDefinitions({ ...testToolPorts, clock: Date.now, ...ports }) : undefined;
  const acquire = (catalog: ReturnType<typeof catalogDefinitions>) => acquireSyncEffect(createTurnDispatcher({
    sessionId: origin.sessionId, role: origin.role, actionId: "fixture-turn", ledger: fixtureLedger,
  }, { approvalPolicy: APPROVAL_POLICY }).pipe(Effect.provide(catalogLayer(catalog)), Effect.provide(executorServices), Effect.provide(runnerTestLayer)));
  const persistentDispatcher = definitions === undefined ? undefined : acquire(definitions);
  return async (input: PlainObject) => {
    const clock = now === undefined ? undefined : spyOn(Date, "now").mockImplementation(now);
    try {
      const currentDefinitions = definitions ?? catalogDefinitions({ ...testToolPorts, clock: Date.now, ...ports });
      const dispatcher = persistentDispatcher ?? acquire(currentDefinitions);
      return await runEffect(dispatcher.execute(
        { id: `test-tool-call-${nextCallId++}`, tool: name, input },
        { sessionId: origin.sessionId, turnId: `test-turn-${nextCallId}` },
      ));
    } finally {
      clock?.mockRestore();
    }
  };
}

export function modelToolOutput(
  name: string,
  ports: Partial<ToolPorts>,
  origin: CatalogOrigin = RESIDENT,
  now?: () => number,
) {
  const dispatch = dispatchModelTool(name, ports, origin, now);
  return async (input: PlainObject): Promise<string> => String((await dispatch(input)).content);
}
