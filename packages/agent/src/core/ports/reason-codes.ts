export const RunReasonCode = {
  /** The loop reports `stalled`, not a guard abort. */
  Stalled: "stalled",
  BudgetWarning: "budget_warning",
  BudgetReassurance: "budget_reassurance",
} as const;
