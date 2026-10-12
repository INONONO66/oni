import { z } from "zod";
import { BusEvent } from "../bus/index.js";
import { prompt } from "./core/prompt.js";
import { signal } from "./core/signal.js";
import { turn } from "./core/turn.js";
import { llm } from "./core/llm.js";
import { message } from "./core/message.js";
import { request } from "./core/request.js";
import { alarm } from "./core/alarm.js";
import { sessionConfigure } from "./core/session-configure.js";
import { policyDecision } from "./core/policy-decision.js";
import { tool } from "./capability/tool.js";
import { compaction } from "./capability/compaction.js";
import { action } from "./capability/action.js";
import type { KindDeclaration } from "./declaration.js";

export * as JournalKind from "./declaration.js";
export { Control as SignalControl } from "./core/signal.js";
export { foldDeliveryPayload, V1_DELIVERY_FIELDS } from "./core/prompt.js";
export { Phase as RequestPhase } from "./core/request.js";
export { Op as AlarmOp, FiredOutcome as AlarmFiredOutcome, RESERVED_PURPOSES as RESERVED_ALARM_PURPOSES, isReservedPurpose as isReservedAlarmPurpose, type ReservedPurpose as ReservedAlarmPurpose } from "./core/alarm.js";
export { CheckpointPolicy, Settings as ConsumptionSettings, ConsumptionWidth, Disabled as ConfigureDisabled, DisabledEntry as ConfigureDisabledEntry } from "./core/session-configure.js";
export { CompactionReason } from "./capability/compaction.js";

/**
 * The closed journal kind set (#1252): nine core kinds folded by one
 * exhaustive reducer plus three capability kinds folded through the
 * registration table the composed generation provides. `fold.checkpoint`
 * stays a store-internal read accelerator and is not a journal kind.
 */
export namespace Journal {
  export const CORE_DECLARATIONS = Object.freeze([
    prompt,
    signal,
    turn,
    llm,
    message,
    request,
    alarm,
    sessionConfigure,
    policyDecision,
  ] as const);

  export const CAPABILITY_DECLARATIONS = Object.freeze([tool, compaction, action] as const);

  export const DECLARATIONS = Object.freeze([
    ...CORE_DECLARATIONS,
    ...CAPABILITY_DECLARATIONS,
  ] as const);

  export const CORE_KINDS = Object.freeze(
    CORE_DECLARATIONS.map((declaration) => declaration.kind),
  );
  export const CAPABILITY_KINDS = Object.freeze(
    CAPABILITY_DECLARATIONS.map((declaration) => declaration.kind),
  );
  export const KINDS = Object.freeze(DECLARATIONS.map((declaration) => declaration.kind));
  export type Kind = (typeof DECLARATIONS)[number]["kind"];

  const byKind: ReadonlyMap<string, KindDeclaration> = new Map(
    DECLARATIONS.map((declaration) => [declaration.kind, declaration]),
  );

  /** The one declaration owning a kind's schema; `undefined` outside the closed set. */
  export function declarationFor(kind: string): KindDeclaration | undefined {
    return byKind.get(kind);
  }

  export function isCapabilityKind(kind: string): boolean {
    return CAPABILITY_KINDS.includes(kind as (typeof CAPABILITY_KINDS)[number]);
  }

  /**
   * Input admission against the composed generation's registered capability
   * kinds: a capability row whose owning capability is absent stays opaque in
   * the fold and is rejected as input with `unknown_kind`.
   */
  export function admitInputKind(
    registered: readonly string[],
    kind: string,
  ): "ok" | "unknown_kind" {
    if (!isCapabilityKind(kind)) return byKind.has(kind) ? "ok" : "unknown_kind";
    return registered.includes(kind) ? "ok" : "unknown_kind";
  }

  /** A row that fails decode is kept verbatim, folds as opaque, and emits this. */
  export const Corrupt = z
    .object({
      seq: z.number().int().positive(),
      kind: z.string().min(1),
      reason: z.string().min(1),
    })
    .strict();
  export type Corrupt = z.infer<typeof Corrupt>;

  export const CorruptEvent = BusEvent.define("journal.corrupt", Corrupt, {
    visibility: "user_audit",
  });
}
