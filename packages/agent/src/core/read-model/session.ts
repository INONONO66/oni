import type { SessionKernel } from "../store/fence";

/** Read capabilities only: no fence-adoption or commit operation leaves this projection. */
export type SessionReadModel = Pick<SessionKernel,
  | "row" | "listRows" | "historyPage" | "actionById" | "latestAction"
  | "latestTurnTerminal" | "latestOpenTurn" | "childSessionsPage"
  | "generationFor" | "latestGenerationFor" | "latestSettings"
  | "policyRows" | "currentPolicyGeneration" | "policyDecisionRuleIds"
  | "pendingMessages" | "inputMessages" | "messageActionByPlatformId"
  | "requestRows" | "requestById" | "outboundReceipt" | "outboundRows"
  | "priorModelAttempt" | "toolOutput" | "getSnapshot" | "watchSnapshot"
>;

/** Also projects Core-owned runner inputs without exposing their commit capability to app readers. */
export function sessionReadModel(kernel: SessionReadModel): SessionReadModel {
  return {
    row: kernel.row,
    listRows: kernel.listRows,
    historyPage: kernel.historyPage,
    actionById: kernel.actionById,
    latestAction: kernel.latestAction,
    latestTurnTerminal: kernel.latestTurnTerminal,
    latestOpenTurn: kernel.latestOpenTurn,
    childSessionsPage: kernel.childSessionsPage,
    generationFor: kernel.generationFor,
    latestGenerationFor: kernel.latestGenerationFor,
    latestSettings: kernel.latestSettings,
    policyRows: kernel.policyRows,
    currentPolicyGeneration: kernel.currentPolicyGeneration,
    policyDecisionRuleIds: kernel.policyDecisionRuleIds,
    pendingMessages: kernel.pendingMessages,
    inputMessages: kernel.inputMessages,
    messageActionByPlatformId: kernel.messageActionByPlatformId,
    requestRows: kernel.requestRows,
    requestById: kernel.requestById,
    outboundReceipt: kernel.outboundReceipt,
    outboundRows: kernel.outboundRows,
    priorModelAttempt: kernel.priorModelAttempt,
    toolOutput: kernel.toolOutput,
    getSnapshot: kernel.getSnapshot,
    watchSnapshot: kernel.watchSnapshot,
  };
}
