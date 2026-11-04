import type { Core } from "@oni/agent";

type SettleChild = NonNullable<Core.SessionHostRuntime["options"]["settleChild"]>;

/**
 * #1258 M-4: a child is active while work is in flight — an open turn or an
 * undelivered input, both durable journal facts.
 */
export function activeChildRead(read: Core.LedgerHost["read"]): (childId: string) => boolean {
  return (childId) => {
    const kernel = read.session(childId);
    return kernel.latestOpenTurn(childId) !== undefined || kernel.pendingMessages(childId).length > 0;
  };
}

/** #1841: a peer lease names a delegation — a catalogued child row that is still active. */
export function liveDelegationRead(read: Core.LedgerHost["read"]): (delegationId: string) => boolean {
  const active = activeChildRead(read);
  return (delegationId) => {
    const row = read.sessions.list().find((item) => item.id === delegationId);
    return row !== undefined && row.parentId !== null && active(delegationId);
  };
}

/**
 * #1841: a delegation's settlement (#1311, folded once per child) ends every
 * peer lease issued for it before the settlement commits — a lease never
 * outlives the work it was issued for, and a settlement whose commit loses the
 * fence has only ended reach early.
 */
export function settleEndingLeases(
  settle: SettleChild,
  endLeases: (delegationId: string) => void,
): SettleChild {
  return (kernel, row, terminal, result) => {
    endLeases(row.id);
    return settle(kernel, row, terminal, result);
  };
}
