import { runEffect } from "./effect";
import type { planeOf } from "./ledger";

/** Seed a resident's genesis before exercising its app-facing entity door. */
export async function materializeResident(
  plane: Awaited<ReturnType<typeof planeOf>>,
  sessionId: string,
  generation: number,
): Promise<void> {
  const kernel = plane.openKernel(sessionId);
  await runEffect(kernel.materialize({
    id: sessionId,
    parentId: null,
    role: "resident",
    tools: [],
    system: { preset: "", blocks: [] },
    policyGeneration: generation,
    actionId: `${sessionId}:materialize`,
    at: 1,
  }));
  plane.catalog.indexSession({ id: sessionId, parentId: null, role: "resident", createdAt: 1 });
}
