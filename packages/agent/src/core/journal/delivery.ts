import { JournalKind, type ConsumptionSettings, type ConsumptionWidth, type Delivery, type LedgerAction, type SessionTurn } from "@oni/protocol";
import type { SessionKernel } from "../session/entity";

export function internalOrigin(sessionId: string): Delivery.Origin {
  return { encodingVersion: 1, value: { kind: "session", id: sessionId } };
}

/**
 * The journal row kind one delivered input lands as (): `prompt` and
 * `action` inputs are rows of their own kind; interrupt/resume control is a
 * `signal` row. The single mapping both the admission constructor and the
 * delivery constructor share.
 */
export function inputRowKind(kind: Delivery.Kind): "prompt" | "signal" | "action" {
  return kind === "prompt" || kind === "action" ? kind : "signal";
}

export function deliveryActions(
  items: readonly Delivery.Row[],
  target: { readonly kind: "turn"; readonly turnId: string } | { readonly kind: "pending" },
  boundary: SessionTurn.Boundary,
  parentId: string | null,
): LedgerAction.Append[] {
  let parent = parentId;
  return items.map((item) => {
    const action: LedgerAction.Append = {
      id: `${item.id}:delivery`,
      parentId: parent,
      sessionId: item.sessionId,
      // : a delivered input is a journal row of its own kind — `prompt`
      // for turn inputs, `signal` for interrupt/resume control. The retired
      // input-queue delivery kind had one writer here; this constructor keeps it.
      kind: inputRowKind(item.kind),
      intent: {
        encodingVersion: 1,
        value:
          item.kind === "interrupt" || item.kind === "resume" || item.kind === "cancel"
            ? { deliveryId: item.id, control: item.kind }
            : { deliveryId: item.id, delivery: item.delivery ?? JournalKind.DEFAULT_DELIVERY },
      },
      effect: {
        encodingVersion: 1,
        value: {
          phase: "delivery",
          turnId: target.kind === "turn" ? target.turnId : item.id,
          deliveryId: item.id,
          kind: item.kind,
          content: item.content,
          origin: item.origin,
          boundary,
        },
      },
      irreversible: true,
      ts: item.createdAt,
    };
    parent = action.id;
    return action;
  });
}

/** The durable chain action for one received message: the chain itself is the input queue. */
export function receivedMessageAction(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: Delivery.Kind;
  readonly content: string;
  readonly origin: Delivery.Origin;
  readonly parentActionId: string | null;
  readonly at: number;
  /** Loop-consumption delivery the input row carries (); absent folds to the `followUp` default. */
  readonly delivery?: JournalKind.Delivery;
}): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentActionId,
    sessionId: input.sessionId,
    // : control inputs (interrupt/resume) are signal rows; prompts are prompt rows.
    kind: inputRowKind(input.kind),
    intent: input.origin,
    effect: {
      encodingVersion: 1,
      value: {
        deliveryKind: input.kind,
        content: input.content,
        ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
      },
    },
    irreversible: true,
    ts: input.at,
  };
}

/**  H-3: the staleness split a turn start applies to its backlog. A */
export function staleActionBacklog(
  backlog: readonly Delivery.Row[],
  compactionHead: number,
): { readonly live: Delivery.Row[]; readonly stale: Delivery.Row[] } {
  const live: Delivery.Row[] = [];
  const stale: Delivery.Row[] = [];
  for (const row of backlog) {
    const isStale = row.kind === "action" && row.after !== undefined && row.after < compactionHead;
    (isStale ? stale : live).push(row);
  }
  return { live, stale };
}

/** Current behavior when no configure row pins widths: every boundary consumes all eligible rows. */
export const DEFAULT_CONSUMPTION: ConsumptionSettings = { steering: "all", followUp: "all" };

/**
 * The `all|one` consumption widths (): settings data folded from the
 * latest `session.configure` row carrying `intent.settings`, not code.
 */
export function consumptionSettings(kernel: SessionKernel, sessionId: string): ConsumptionSettings {
  return kernel.latestSettings(sessionId) ?? DEFAULT_CONSUMPTION;
}

/** The loop boundary consumption rule (): control signals */
export function boundaryConsumption(
  backlog: readonly Delivery.Row[],
  boundary: SessionTurn.Boundary | "turn_end",
  settings: ConsumptionSettings,
  /**  H-1 (r3): the latest executed compaction's ordinal; EVERY boundary closes stale actions, not just turn start. */
  compactionHead: number,
): { readonly consumed: Delivery.Row[]; readonly stale: Delivery.Row[] } {
  const { live, stale } = staleActionBacklog(backlog, compactionHead);
  const width = (rows: readonly Delivery.Row[], mode: ConsumptionWidth) =>
    mode === "one" ? rows.slice(0, 1) : rows;
  const inputs = live.filter((item) => item.kind === "prompt" || item.kind === "action");
  const steer = inputs.filter(
    (item) => (item.delivery ?? JournalKind.DEFAULT_DELIVERY) === "steer",
  );
  const followUp = inputs.filter(
    (item) => (item.delivery ?? JournalKind.DEFAULT_DELIVERY) === "followUp",
  );
  const chosen = new Set(
    [
      ...live.filter(
        (item) => item.kind === "interrupt" || item.kind === "cancel" || item.kind === "resume",
      ),
      ...(boundary === "after_tools" || boundary === "turn_end"
        ? width(steer, settings.steering)
        : []),
      ...(boundary === "turn_end" ? width(followUp, settings.followUp) : []),
    ].map((item) => item.id),
  );
  return { consumed: live.filter((item) => chosen.has(item.id)), stale };
}
