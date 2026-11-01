import { z } from "zod";
import { WindowTarget } from "./target.js";
import { InputRequestId } from "./dispatch.js";
import { ComputerCancelled } from "./lease.js";
export { WindowTarget } from "./target.js";
import { AppIdentity, COMPUTER_MAX_DIMENSION, MachineId, ObservationId, ObservedRef, SCREEN_AX_MAX_BYTES, SCREEN_PNG_MAX_BYTES } from "./schema.js";

/**
 * Window-bound observation (#1689): one window's accessibility elements,
 * each addressed by a ref minted from its role path, and the ref-targeted
 * action that names the observation it read. `epoch` counts recreations of
 * the window the peer has seen since attach; an action naming an older
 * epoch, or any observation but the window's latest, executes nothing.
 */
export const OBSERVE_MAX_ELEMENTS = 2000;
export const OBSERVE_MAX_VISITS = 5000;
export const OBSERVE_BUDGET_MS = 2500;
export const OBSERVE_MAX_VALUE_CHARS = 4096;
export const OBSERVE_MAX_LABEL_CHARS = 1024;
export const OBSERVE_MAX_ACTIONS = 16;
export const ACTION_MAX_VALUE_CHARS = 65_536;
const ACTION_WAIT_MAX_MS = 10_000;

/** An unaddressable role is empty; see {@link ObservedRef}. */
const Ref = ObservedRef;
const Lineage = z.string().regex(/^w\d+-\d+-\d+$/).max(64);
const ActionName = z.string().min(1).max(64);
const RefusalMessage = z.string().min(1).max(256);
const Position = z.number().int().min(-COMPUTER_MAX_DIMENSION).max(COMPUTER_MAX_DIMENSION);
const Extent = z.number().int().nonnegative().max(COMPUTER_MAX_DIMENSION);
const Base64 = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);

/** `frame` is in window-local points; an element whose role is empty has `ref: null` and no actions. */
export const ObservedElement = z
  .object({
    ref: Ref.nullable(),
    role: z.string().max(128),
    label: z.string().max(OBSERVE_MAX_LABEL_CHARS).optional(),
    id: z.string().max(256).optional(),
    value: z.string().max(OBSERVE_MAX_VALUE_CHARS).optional(),
    actions: z.array(ActionName).max(OBSERVE_MAX_ACTIONS),
    frame: z.object({ x: Position, y: Position, width: Extent, height: Extent }).strict(),
    parent: Ref.optional(),
    secure: z.boolean(),
    enabled: z.boolean().nullable().optional(),
    selected: z.boolean().nullable().optional(),
    checked: z.boolean().nullable().optional(),
    expanded: z.boolean().nullable().optional(),
    /** Null means the child read failed; a count is reserved for the next observer revision. */
    children: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();
export type ObservedElement = z.infer<typeof ObservedElement>;

function boundedBytes(elements: readonly ObservedElement[], ctx: z.RefinementCtx): void {
  if (new TextEncoder().encode(JSON.stringify(elements)).length > SCREEN_AX_MAX_BYTES) {
    ctx.addIssue({ code: "custom", message: `elements exceed ${SCREEN_AX_MAX_BYTES} serialized bytes` });
  }
}
const Elements = z.array(ObservedElement).max(OBSERVE_MAX_ELEMENTS).superRefine(boundedBytes);

/**
 * `since` names the lineage's latest observation and asks for a diff against
 * it. Full-refresh exception: when either snapshot holds an element without a
 * ref (an empty role, an ambiguous sibling or its descendants, a path too
 * deep, or an incomplete walk), a diff by ref cannot express its change or
 * removal, so the answer carries `elements` instead of `diff`.
 */
export const ScreenObserveRequest = z
  .object({
    target: WindowTarget,
    since: ObservationId.optional(),
    screenshot: z.boolean(),
    maxElements: z.number().int().min(1).max(OBSERVE_MAX_ELEMENTS).optional(),
  })
  .strict();
export type ScreenObserveRequest = z.infer<typeof ScreenObserveRequest>;

const Observed = z.object({
  status: z.literal("ok"),
  observationId: ObservationId,
  lineage: Lineage,
  target: WindowTarget.required({ epoch: true }),
  window: z
    .object({ pid: z.number().int().min(1), windowId: z.number().int().nonnegative(), epoch: z.number().int().nonnegative(), title: z.string().max(256), app: AppIdentity })
    .strict(),
  complete: z.boolean(),
  private: z.literal(false),
  focused: Ref.optional(),
  screenshot: z
    .object({
      captureId: z.string().min(1).max(128),
      format: z.enum(["png", "jpeg"]),
      width: Extent.min(1),
      height: Extent.min(1),
      data: Base64.min(1).max(Math.ceil(SCREEN_PNG_MAX_BYTES / 3) * 4),
    })
    .strict()
    .optional(),
});

/**
 * A full observation carries `elements`, a diff carries `diff` (`added` and
 * `changed` whole, `removed` by ref); `complete: false` when a bound cut the
 * walk, and then no element carries a ref (sibling identity is unknown past the
 * cut). `private` is reserved and always false here.
 */
export const ScreenObserveResult = z.xor([
  ComputerCancelled,
  Observed.extend({ elements: Elements }).strict(),
  Observed.extend({
    diff: z
      .object({ since: ObservationId, added: Elements, changed: Elements, removed: z.array(Ref).max(OBSERVE_MAX_ELEMENTS) })
      .strict(),
  }).strict(),
  Observed.pick({
    status: true,
    observationId: true,
    lineage: true,
    target: true,
    window: true,
  }).extend({
    complete: z.literal(true),
    private: z.literal(true),
    elements: z.array(z.never()).max(0),
  }).strict(),
  z
    .object({
      status: z.literal("refused"),
      reason: z.enum([
        "machine_not_attached",
        "permission_denied",
        "observe_not_available",
        "window_not_found",
        "epoch_changed",
        "stale_observation",
        "observe_failed",
        "lease_missing", "lease_expired", "target_unbound", "app_out_of_scope",
        "foreground_not_granted", "excluded", "stale_capture", "paused:human_input", "paused:takeover",
        "paused:private", "paused:locked", "paused:asleep", "budget_exhausted", "private", "clipboard_not_granted",
      ]),
      message: RefusalMessage.optional(),
      humanActiveMs: z.number().int().nonnegative().optional(),
      retryAfterMs: z.number().int().nonnegative().optional(),
      resetAt: z.number().nonnegative().optional(),
    })
    .strict(),
]);
export type ScreenObserveResult = z.infer<typeof ScreenObserveResult>;

/**
 * `press` the element, `setValue` its value to `value`, or `perform` the
 * named action it listed. The answer is `InputWriteResult`.
 */
export const InputActionRequest = z
  .object({
    requestId: InputRequestId,
    observationId: ObservationId,
    target: WindowTarget.required({ epoch: true }),
    ref: Ref,
    action: z.enum(["press", "setValue", "perform"]),
    value: z.string().max(ACTION_MAX_VALUE_CHARS).optional(),
    name: ActionName.optional(),
    /** Wait for a blocked target to become actionable; absent defaults to 2000 ms. */
    waitMs: z.number().int().min(0).max(ACTION_WAIT_MAX_MS).optional(),
  })
  .strict();
export type InputActionRequest = z.infer<typeof InputActionRequest>;

/** A target window crossed the private-focus boundary. */
export const PrivateEvent = z
  .object({
    machineId: MachineId,
    target: WindowTarget.required({ epoch: true }),
    state: z.enum(["entered", "left"]),
  })
  .strict();
export type PrivateEvent = z.infer<typeof PrivateEvent>;
