import type { LedgerAction, Storage as ProtocolStorage } from "@oni/protocol";

/** Independent unbounded audit oracle for tests; never exported by the runtime barrel. */
export function sessionTree(
  sessionId: string,
  adapter: ProtocolStorage.ActionSubAdapter,
): LedgerAction.Node[] {
  const revision = adapter.latestAction(sessionId, Number.MAX_SAFE_INTEGER)?.ordinal ?? 0;
  const actions: LedgerAction.Node[] = [];
  let cursor = 0;
  while (cursor < revision) {
    const page = adapter.range(sessionId, cursor, 256);
    actions.push(...page.filter((action) => action.ordinal <= revision));
    cursor = actions.at(-1)?.ordinal ?? cursor;
  }
  return actions;
}
