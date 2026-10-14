import type { LedgerAction } from "@openomni/protocol";
import type { SessionKernel } from "../../src/core/session/entity";

/** Independent unbounded audit oracle over one kernel's chain; bounded pages underneath. */
export function sessionTree(kernel: SessionKernel, sessionId: string): LedgerAction.Node[] {
  const actions: LedgerAction.Node[] = [];
  let afterRevision = 0;
  for (;;) {
    const page = kernel.historyPage(sessionId, { afterRevision, limit: 256 });
    actions.push(...page.actions);
    if (page.nextRevision === null) return actions;
    afterRevision = page.nextRevision;
  }
}
