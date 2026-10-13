import { z } from "zod";
import { BusEvent } from "../bus/index.js";
import { NamedError } from "../error/index.js";
import { canonicalDigest, PlainValueSchema } from "../json.js";
import { EpochMs } from "../time.js";
import { Message as ModelMessage } from "../message/index.js";
import { Journal } from "../journal/index.js";
import { Delivery as DeliveryWidth, EncodedPayload } from "../journal/declaration.js";
import { ForkedFrom, Settings as ConsumptionSettings } from "../journal/core/session-configure.js";

export { SessionTransition } from "./session-transition.js";

const Identifier = z.string().min(1);

/** The one definition of deliverable input kinds (#1252); `Delivery.Kind` aliases it. */
/** `cancel` (#1258) rides the existing `signal` journal kind, like interrupt/resume. */
const InputKind = z.enum(["prompt", "interrupt", "resume", "cancel", "action"]);
const NullableIdentifier = Identifier.nullable();

export { EncodedPayload } from "../journal/declaration.js";

export namespace LedgerAction {
  /** Canonical admitted args plus optional pre-transform provenance. */
  export const Intent = z
    .object({
      phase: z.literal("intent"),
      op: Identifier,
      value: PlainValueSchema,
      originalArgs: PlainValueSchema.optional(),
    })
    .catchall(PlainValueSchema);
  export type Intent = z.infer<typeof Intent>;

  /**
   * Storage-admitted action kinds (#1252): the closed 12-kind journal set
   * (`Journal.KINDS`) plus `fold.checkpoint`, the store-internal read
   * accelerator that is not a journal kind.
   */
  export const Kind = z.enum([...Journal.KINDS, "fold.checkpoint"]);
  export type Kind = z.infer<typeof Kind>;

  const BaseNode = z
    .object({
      id: Identifier,
      parentId: NullableIdentifier,
      sessionId: Identifier,
      kind: Kind,
      intent: EncodedPayload,
      effect: EncodedPayload,
      ts: EpochMs,
      ordinal: z.number().int().positive(),
      prevHash: z.string(),
      actionHash: z.string(),
    })
    .strict();

  const RevertibleNode = BaseNode.extend({
    revert: EncodedPayload,
  });
  const IrreversibleNode = BaseNode.extend({
    irreversible: z.literal(true),
  });

  export const Node = z.union([RevertibleNode, IrreversibleNode]);
  export type Node = z.infer<typeof Node>;

  export const ChainVerdict = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("intact"), head: z.string().nullable(), length: z.number() }),
    z.object({
      kind: z.literal("broken"),
      ordinal: z.number(),
      expected: z.string(),
      actual: z.string(),
    }),
  ]);
  export type ChainVerdict = z.infer<typeof ChainVerdict>;

  const AppendBase = BaseNode.omit({ ordinal: true, prevHash: true, actionHash: true });
  export const Append = z.union([
    AppendBase.extend({ revert: EncodedPayload }),
    AppendBase.extend({ irreversible: z.literal(true) }),
  ]);
  export type Append = z.infer<typeof Append>;

  export const Receipt = z
    .object({
      action: Node,
      revision: z.number().int().positive(),
    })
    .strict();
  export type Receipt = z.infer<typeof Receipt>;
}

export namespace FoldCheckpoint {
  const Count = z.number().int().nonnegative();
  /**
   * #1347: the open turn's charged budget counters, folded from the turn's
   * own rows (llm intents and attempt usage, tool intent/result pairs) so a
   * reactivated turn resumes them. `chargedAt` is the last charged row's
   * clock; `toolsThrough`/`openTools` carry the tool wall-time union across a
   * checkpoint taken mid-wave.
   */
  export const BudgetState = z
    .object({
      startTime: EpochMs,
      chargedAt: EpochMs,
      turns: Count,
      toolCalls: Count,
      toolRuntimeMs: Count,
      totalInputTokens: Count,
      totalOutputTokens: Count,
      toolsThrough: EpochMs,
      openTools: z.array(z.tuple([Identifier, EpochMs])),
    })
    .strict();
  export type BudgetState = z.infer<typeof BudgetState>;
  export const State = z
    .object({
      messages: z.array(ModelMessage.WithParts),
      canonicalTurn: z.boolean(),
      messageTurns: z.array(z.tuple([Identifier, NullableIdentifier])),
      parents: z.array(z.tuple([Identifier, NullableIdentifier])),
      compatibility: z.array(
        z
          .object({ id: Identifier, role: z.enum(["user", "assistant"]), text: z.string() })
          .strict(),
      ),
      successorActionId: NullableIdentifier,
      /** Absent on rows checkpointed before #1347; null between turns. */
      budgetState: BudgetState.nullable().optional(),
    })
    .strict();
  export type State = z.infer<typeof State>;
  export const Intent = z
    .object({
      phase: z.literal("checkpoint"),
      revision: z.number().int().nonnegative(),
      foldVersion: z.literal(1),
      reason: z.enum(["interval", "compaction"]),
    })
    .strict();
  export const Result = z
    .object({
      revision: z.number().int().nonnegative(),
      foldVersion: z.literal(1),
      stateHash: z.string().min(1),
      state: State,
    })
    .strict();
  export const Effect = z
    .object({ phase: z.literal("result"), terminal: z.literal("executed"), result: Result })
    .strict();
}

export namespace LedgerSession {
  export const Role = z.enum(["resident", "child"]);
  export type Role = z.infer<typeof Role>;

  export const State = z.enum(["idle", "running", "interrupted"]);
  export type State = z.infer<typeof State>;

  export const GenerationPointers = z
    .object({
      toolsGeneration: z.number().int().nonnegative(),
      systemHash: z.string(),
      policyGeneration: z.number().int().nonnegative(),
    })
    .strict();
  export type GenerationPointers = z.infer<typeof GenerationPointers>;

  export const Row = z
    .object({
      id: Identifier,
      parentId: NullableIdentifier,
      role: Role,
      fenceOwner: NullableIdentifier,
      fence: z.number().int().nonnegative(),
      revision: z.number().int().nonnegative(),
      state: State,
      toolsGeneration: z.number().int().nonnegative().default(0),
      systemHash: z.string().default(""),
      policyGeneration: z.number().int().nonnegative().default(0),
    })
    .strict();
  export type Row = z.infer<typeof Row>;

  export const Materialize = z
    .object({
      row: Row,
      initialAction: LedgerAction.Append,
    })
    .strict();
  export type Materialize = z.infer<typeof Materialize>;

  export const MaterializeResult = z.discriminatedUnion("created", [
    z.object({ created: z.literal(true), row: Row, receipt: LedgerAction.Receipt }).strict(),
    z.object({ created: z.literal(false), row: Row }).strict(),
  ]);
  export type MaterializeResult = z.infer<typeof MaterializeResult>;

  /**
   * Fence adoption (W5.2 F5): writes the catalog-rotated runner-generation
   * fence into the session file's single row. Only a strictly newer fence may
   * adopt; a file fence at or beyond the target means a later activation won.
   */
  export const AdoptFence = z
    .object({
      sessionId: Identifier,
      owner: Identifier,
      fence: z.number().int().positive(),
    })
    .strict();
  export type AdoptFence = z.infer<typeof AdoptFence>;

  export const Commit = z
    .object({
      sessionId: Identifier,
      owner: Identifier,
      fence: z.number().int().positive(),
      now: EpochMs,
      expectedRevision: z.number().int().nonnegative(),
      actions: z.array(LedgerAction.Append),
      state: State,
      generation: GenerationPointers.optional(),
      requestCount: z
        .object({ since: z.number().int(), count: z.number().int().nonnegative() })
        .strict()
        .optional(),
    })
    .strict();
  export type Commit = z.infer<typeof Commit>;

  export const CommitResult = z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), row: Row, receipts: z.array(LedgerAction.Receipt) }).strict(),
    z
      .object({
        ok: z.literal(false),
        reason: z.enum(["stale", "revision"]),
        currentFence: z.number().int().nonnegative(),
        currentRevision: z.number().int().nonnegative(),
      })
      .strict(),
  ]);
  export type CommitResult = z.infer<typeof CommitResult>;
}

export namespace SessionGeneration {
  /** Fork ancestry pinned at child genesis (#1257); declared with the journal kind. */
  export const ForkAncestry = ForkedFrom;
  export type ForkAncestry = z.infer<typeof ForkedFrom>;

  export const Id = z
    .object({
      sessionId: Identifier,
      generation: z.number().int().positive(),
    })
    .strict();
  export type Id = z.infer<typeof Id>;

  export const ToolCategory = z.enum(["query", "mutation", "authority", "execution"]);
  export type ToolCategory = z.infer<typeof ToolCategory>;

  export const Tool = z
    .object({
      name: Identifier,
      inputSchema: PlainValueSchema,
      category: ToolCategory,
      sequential: z.literal(true).optional(),
      /** Declared replay safety (#1255); the run loop alone decides replay. */
      idempotent: z.literal(true).optional(),
    })
    .strict();
  export type Tool = z.infer<typeof Tool>;

  export const SystemBlock = z
    .object({
      id: Identifier,
      source: Identifier,
      content: z.string(),
    })
    .strict();
  export type SystemBlock = z.infer<typeof SystemBlock>;

  export const Snapshot = z
    .object({
      generation: z.number().int().positive(),
      revertTo: z.number().int().nonnegative(),
      tools: z.array(Tool),
      toolsHash: z.string().min(1),
      bundles: z
        .array(z.string().regex(/^[a-z][a-z0-9-]*$/))
        .refine(
          (names) => names.every((name, index) => index === 0 || (names[index - 1] ?? "") < name),
          { message: "Bundle names must be sorted and unique" },
        )
        .default([])
        .readonly(),
      systemPreset: z.string(),
      systemBlocks: z.array(SystemBlock),
      systemValue: z.string(),
      systemHash: z.string().min(1),
      policyGeneration: z.number().int().nonnegative(),
      /**
       * The gate-row writer version that minted this generation's row ids
       * (#1319); absent on snapshots written before the versioned writer.
       * Readers report the field as recorded — never default it.
       */
      rowsVersion: z.number().int().positive().optional(),
      /** The composed manifest's `Generation.hash` this snapshot adopted (#1255). */
      manifestHash: z.string().min(1).optional(),
    })
    .strict();
  export type Snapshot = z.infer<typeof Snapshot>;

  export const ConfigureIntent = z
    .object({
      operation: z.enum([
        "create",
        "tools.add",
        "tools.remove",
        "system.blocks.set",
        "revert",
        "compose",
        "fork",
      ]),
      /** `all|one` consumption widths (#1253); present only when this configure pins them. */
      settings: ConsumptionSettings.optional(),
      /** Fork ancestry (#1257); present only on a forked child's genesis configure. */
      forkedFrom: ForkedFrom.optional(),
    })
    .strict();
  export type ConfigureIntent = z.infer<typeof ConfigureIntent>;

  export const ConfigureEffect = z
    .object({
      phase: z.literal("configured"),
      snapshot: Snapshot,
    })
    .strict();
  export type ConfigureEffect = z.infer<typeof ConfigureEffect>;

  export const ConfigureRevert = z
    .object({
      generation: z.number().int().nonnegative(),
    })
    .strict();
  export type ConfigureRevert = z.infer<typeof ConfigureRevert>;

  export const ConfigureReceipt = z
    .object({
      generation: z.number().int().positive(),
      revertTo: z.number().int().nonnegative(),
    })
    .strict();
  export type ConfigureReceipt = z.infer<typeof ConfigureReceipt>;

  export const ConfigureError = NamedError.create(
    "SessionConfigureError",
    z
      .object({
        code: z.enum(["duplicate_tool", "duplicate_block", "denied", "stale"]),
        message: z.string().min(1),
      })
      .strict(),
  );
  export type ConfigureError = InstanceType<typeof ConfigureError>;
}

export namespace SessionTurn {
  export const Boundary = z.enum(["before_llm", "after_llm", "after_tools"]);
  export type Boundary = z.infer<typeof Boundary>;

  export const Message = z
    .object({
      role: z.enum(["user", "assistant"]),
      text: z.string(),
    })
    .strict();
  export type Message = z.infer<typeof Message>;

  const PinnedGeneration = z
    .object({
      toolsGeneration: z.number().int().positive(),
      toolsHash: z.string().min(1),
      systemHash: z.string().min(1),
      policyGeneration: z.number().int().nonnegative(),
    })
    .strict();

  export const Context = z
    .object({
      snapshotActionId: Identifier,
      sourceRevision: z.number().int().nonnegative(),
      foldVersion: z.literal(1),
      projectionHash: z.string().min(1),
      messageIds: z.array(Identifier),
      successorActionId: NullableIdentifier,
      projection: z.array(ModelMessage.WithParts),
    })
    .strict();
  export type Context = z.infer<typeof Context>;

  export const HistoricalIntent = PinnedGeneration.extend({
    phase: z.literal("intent"),
    resultId: Identifier,
    deliveryIds: z.array(Identifier),
    /** #1256 H-3: stale `action` inputs (after < compaction head) closed by this turn WITHOUT execution. */
    consumedStale: z.array(Identifier).optional(),
    resumeCount: z.number().int().nonnegative(),
    boundaryActionId: NullableIdentifier,
  }).strict();
  export const Intent = HistoricalIntent.extend({ context: Context }).strict();
  export type Intent = z.infer<typeof Intent>;
  export const DecodeIntent = z.union([Intent, HistoricalIntent]);
  export type DecodeIntent = z.infer<typeof DecodeIntent>;

  export const HistoricalResume = PinnedGeneration.extend({
    phase: z.literal("resume"),
    turnId: Identifier,
    resultId: Identifier,
    resumeCount: z.number().int().positive(),
    boundaryActionId: NullableIdentifier,
  }).strict();
  export const Resume = HistoricalResume.extend({ context: Context }).strict();
  export type Resume = z.infer<typeof Resume>;
  export const DecodeResume = z.union([Resume, HistoricalResume]);
  export type DecodeResume = z.infer<typeof DecodeResume>;

  export const Checkpoint = z
    .object({
      phase: z.literal("checkpoint"),
      turnId: Identifier,
      resultId: Identifier,
      resumeCount: z.number().int().nonnegative(),
      boundaryActionId: NullableIdentifier,
      boundary: Boundary,
    })
    .strict();
  export type Checkpoint = z.infer<typeof Checkpoint>;

  export const TerminalIntent = z
    .object({
      phase: z.literal("terminal"),
      turnId: Identifier,
    })
    .strict();
  export type TerminalIntent = z.infer<typeof TerminalIntent>;

  export const TerminalKind = z.enum(["result", "interrupted", "error", "waiting"]);
  export type TerminalKind = z.infer<typeof TerminalKind>;

  export const Terminal = z
    .object({
      phase: z.literal("terminal"),
      turnId: Identifier,
      kind: TerminalKind,
      reason: z.literal("live_wait").optional(),
      alarmIds: z.array(Identifier).min(1).optional(),
      text: z.string(),
      boundaryActionId: NullableIdentifier,
      resumeCount: z.number().int().nonnegative(),
    })
    .strict()
    .superRefine((terminal, context) => {
      if (
        terminal.kind === "waiting" &&
        (terminal.reason !== "live_wait" || terminal.alarmIds === undefined)
      ) {
        context.addIssue({
          code: "custom",
          path: ["alarmIds"],
          message: "waiting requires live alarm identities",
        });
      }
      if (
        terminal.kind !== "waiting" &&
        (terminal.reason !== undefined || terminal.alarmIds !== undefined)
      ) {
        context.addIssue({
          code: "custom",
          path: ["kind"],
          message: "only waiting carries live-wait evidence",
        });
      }
    });
  export type Terminal = z.infer<typeof Terminal>;

  export const Delivery = z
    .object({
      phase: z.literal("delivery"),
      turnId: Identifier,
      deliveryId: Identifier,
      kind: InputKind,
      content: z.string(),
      origin: EncodedPayload,
      /** Loop-consumption width (#1252); absent means the `followUp` default. */
      delivery: z.enum(["steer", "followUp"]).optional(),
      boundary: Boundary,
    })
    .strict();
  export type Delivery = z.infer<typeof Delivery>;

  export const Pending = z
    .object({
      phase: z.literal("pending"),
    })
    .strict();
  export type Pending = z.infer<typeof Pending>;

  export const Tail = z
    .object({
      turnId: Identifier,
      state: LedgerSession.State,
      startedAt: EpochMs,
      terminal: z
        .object({
          kind: TerminalKind,
          actionId: Identifier,
          at: EpochMs,
        })
        .strict()
        .optional(),
      messages: z.array(Message),
    })
    .strict();
  export type Tail = z.infer<typeof Tail>;

  export const Snapshot = z
    .object({
      id: Identifier,
      parentId: NullableIdentifier,
      role: LedgerSession.Role,
      revision: z.number().int().nonnegative(),
      state: LedgerSession.State,
      lease: z
        .object({
          owner: NullableIdentifier,
          fence: z.number().int().nonnegative(),
        })
        .strict(),
      toolsGeneration: z.number().int().nonnegative(),
      systemHash: z.string(),
      policyGeneration: z.number().int().nonnegative(),
      openTurnId: Identifier.optional(),
      turns: z.array(Tail),
    })
    .strict();
  export type Snapshot = z.infer<typeof Snapshot>;

  export interface Watch {
    readonly snapshot: Snapshot;
    readonly subscribe: (handler: (observation: Observation) => void) => () => void;
    readonly unsubscribe: () => void;
  }

  export const Observation = z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("revision"),
        sessionId: Identifier,
        revision: z.number().int().positive(),
        actionId: Identifier,
        actionKind: LedgerAction.Kind,
      })
      .strict(),
    z
      .object({
        kind: z.literal("gap"),
        sessionId: Identifier,
        from: z.number().int().nonnegative(),
        to: z.number().int().positive(),
      })
      .strict(),
  ]);
  export type Observation = z.infer<typeof Observation>;
}

export namespace Delivery {
  export const ReplyOrigin = z
    .object({
      kind: z.enum(["child_terminal", "external_reply"]),
      messageId: Identifier,
      sourceActionId: Identifier,
      replyTo: Identifier,
      childSessionId: Identifier.optional(),
      terminalKind: SessionTurn.TerminalKind.optional(),
    })
    .strict();
  export type ReplyOrigin = z.infer<typeof ReplyOrigin>;

  export const MessageOrigin = z
    .object({
      kind: z.literal("message"),
      messageId: Identifier,
      senderSessionId: Identifier,
      replyTo: Identifier.optional(),
      deadline: EpochMs.optional(),
      sourceActionId: Identifier,
    })
    .strict();
  export type MessageOrigin = z.infer<typeof MessageOrigin>;

  export const Kind = InputKind;
  export type Kind = z.infer<typeof Kind>;

  export const Status = z.enum(["pending", "consumed"]);
  export type Status = z.infer<typeof Status>;

  export const Row = z
    .object({
      id: Identifier,
      sessionId: Identifier,
      kind: Kind,
      content: z.string(),
      origin: EncodedPayload,
      /** Loop-consumption mode (#1253): `steer` drains at tool.post boundaries, `followUp` only at turn end. Absent folds to `followUp`. */
      delivery: DeliveryWidth.optional(),
      /** #1256 H-3 (`action` inputs): the journal ordinal the deferred payload was computed against; older than the compaction head means stale. */
      after: z.number().int().nonnegative().optional(),
      status: Status,
      consumedBy: NullableIdentifier,
      consumedAt: EpochMs.nullable(),
      createdAt: EpochMs,
      ordinal: z.number().int().positive(),
    })
    .strict();
  export type Row = z.infer<typeof Row>;
  export type Origin = EncodedPayload;

  export const Commit = Row.omit({
    status: true,
    consumedBy: true,
    consumedAt: true,
    ordinal: true,
  })
    .extend({
      parentActionId: NullableIdentifier.default(null),
      sender: z
        .object({
          sessionId: Identifier,
          owner: Identifier,
          fence: z.number().int().positive(),
        })
        .strict()
        .optional(),
      createSession: LedgerSession.Materialize.optional(),
      limits: z
        .object({ fanout: z.number().int().nonnegative(), depth: z.number().int().nonnegative() })
        .strict()
        .optional(),
    })
    .refine(
      (row) =>
        row.createSession === undefined ||
        row.createSession.row.parentId === null ||
        row.limits !== undefined,
      {
        path: ["limits"],
        message: "child materialization requires pinned admission limits",
      },
    );
  export type Commit = z.infer<typeof Commit>;

  export interface Port {
    commit(row: Commit): Row;
  }
}

export namespace Alarm {
  const Lifetime = {
    persistent: z.literal(true).optional(),
    timeout_ms: z.number().int().positive().optional(),
  };
  export const Watch = z
    .union([
      z
        .object({
          command: z.string().min(1),
          filter: z.string().optional(),
          description: z.string().min(1),
          ...Lifetime,
        })
        .strict(),
      z
        .object({
          path: z.string().min(1),
          event: z.enum(["create", "modify"]),
          description: z.string().min(1),
          ...Lifetime,
        })
        .strict(),
      z
        .object({
          machine: z.string().min(1),
          session: z.string().min(1),
          filter: z.string().optional(),
          description: z.string().min(1),
          ...Lifetime,
        })
        .strict(),
    ])
    .refine((spec) => (spec.persistent === true) !== (spec.timeout_ms !== undefined), {
      message: "exactly one of persistent and timeout_ms is required",
    })
    .superRefine((spec, context) => {
      if ("path" in spec && !spec.path.startsWith("/"))
        context.addIssue({ code: "custom", path: ["path"], message: "path must be absolute" });
      if ("filter" in spec && spec.filter !== undefined) {
        try {
          new RegExp(spec.filter);
        } catch {
          context.addIssue({
            code: "custom",
            path: ["filter"],
            message: "invalid regular expression",
          });
        }
      }
    });
  export type Watch = z.infer<typeof Watch>;

  export const WatchSpec = z
    .object({
      watch: Watch,
      policyGeneration: z.number().int().positive(),
      notificationLimit: z.number().int().positive(),
    })
    .strict();
  export type WatchSpec = z.infer<typeof WatchSpec>;

  /**
   * Durable retry schedule carried by a kind `at` alarm. The `alarm` row
   * (intent `op: arm`) committing this spec IS the retry.scheduled fact: boot recovery
   * consumes it exactly once (fenced cancel CAS) and wakes the session so the
   * open turn re-runs the model attempt.
   */
  export const RetrySchedule = z
    .object({
      kind: z.literal("retry.scheduled"),
      attempt: z.number().int().positive(),
      reason: z.string().min(1),
      notBefore: EpochMs,
    })
    .strict();
  export type RetrySchedule = z.infer<typeof RetrySchedule>;

  /**
   * Deterministic committed occurrence identity (#1254): minted from the arm
   * row's journal sequence inside the same session transaction. `sessionId`
   * keeps a fork from accepting its parent's key; `sourceKey` is the short
   * fixed scheduling-source identifier (`retry`, `deadline`, `cron`, ...).
   */
  export function occurrenceId(
    sessionId: string,
    alarmId: string,
    armSeq: number,
    sourceKey: string,
  ): string {
    return canonicalDigest(["alarm.occurrence", sessionId, alarmId, armSeq, sourceKey]);
  }
}

export namespace L0Observation {
  export const ActionCommitted = z
    .object({
      id: Identifier,
      sessionId: Identifier,
      revision: z.number().int().positive(),
      kind: LedgerAction.Kind,
    })
    .strict();
  export type ActionCommitted = z.infer<typeof ActionCommitted>;

  export const ActionCommittedEvent = BusEvent.define("ledger.action.committed", ActionCommitted, {
    visibility: "ephemeral",
  });
}

export namespace PolicyRow {
  export const Phase = z.enum(["pre", "post"]);
  export type Phase = z.infer<typeof Phase>;

  export const Row = z
    .object({
      name: Identifier,
      kind: Identifier,
      phase: Phase,
      match: EncodedPayload,
      verdict: EncodedPayload,
      priority: z.number().int(),
      generation: z.number().int().positive(),
    })
    .strict();
  export type Row = z.infer<typeof Row>;
}
