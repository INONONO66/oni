import { z } from "zod";
import { JsonShapedValueSchema } from "../json.js";
import { Machine } from "../machine/index.js";

const baseMessage = z.object({
  v: z.literal(2),
  id: z.string().optional(),
});

const requestSchema = baseMessage.extend({
  type: z.literal("request"),
  id: z.string(),
  method: z.string(),
  params: z.record(z.string(), JsonShapedValueSchema).optional(),
});

const responseSchema = baseMessage.extend({
  type: z.literal("response"),
  id: z.string(),
  result: JsonShapedValueSchema.optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: JsonShapedValueSchema.optional(),
    })
    .optional(),
});

const notificationSchema = baseMessage.extend({
  type: z.literal("notification"),
  method: z.string(),
  params: z.record(z.string(), JsonShapedValueSchema).optional(),
});

/**
 * Same-version internal method parameter contracts.
 *
 * The generic request envelope above intentionally stays permissive; these
 * method schemas document and test the canonical params expected by current
 * machine hosts/daemons.
 */
const methods = {
  /**
   * Machine daemon → machine host (docs/machines-and-delegation.md §2):
   * the daemon offers its capability set, the host answers with the
   * enrollment∩offer effective set or a typed refusal. The localhost slice
   * carries no auth token — the Unix socket is the trust boundary; remote
   * transports add authentication as an additive field when they land.
   */
  [Machine.WireMethod.Attach]: {
    params: Machine.Offer,
    result: Machine.AttachResult,
  },
  /**
   * Machine daemon → machine host (#1555): one load heartbeat per report
   * interval on the attached connection. The host answers `accepted` or a
   * typed refusal (`machine_not_attached` | `machine_mismatch`) and keeps
   * only the latest accepted report; staleness is the host clock's call.
   */
  [Machine.WireMethod.Report]: {
    params: Machine.Report,
    result: Machine.ReportResult,
  },
  [Machine.WireMethod.Ping]: {
    params: z.object({}).strict(),
    result: Machine.PingResult,
  },
  [Machine.WireMethod.Exec]: { params: Machine.ExecRequest, result: Machine.ExecResult },
  [Machine.WireMethod.CancelCode]: { params: Machine.CancelCode, result: Machine.CancelResult },
  /** Machine host → machine daemon: a live cell's output so far, for `eval peek`. */
  [Machine.WireMethod.PeekCode]: { params: Machine.PeekCode, result: Machine.PeekAnswer },
  [Machine.WireMethod.RunCode]: {
    params: Machine.CellRequest,
    result: Machine.CellResult,
  },
  /**
   * Machine daemon → machine host, made from inside a running cell
   * (docs/machines-and-delegation.md §2.2): the reverse direction of RunCode,
   * on the same attachment, so one cell can batch what would otherwise be N
   * tool round trips.
   */
  [Machine.WireMethod.CallTool]: {
    params: Machine.ToolCall,
    result: Machine.ToolCallResult,
  },
  /**
   * Machine host → machine daemon: one filesystem op against a named export.
   * The host translates real absolute paths; the daemon checks the negotiated
   * capability/export ceilings and its own offer, then confines the operation.
   */
  [Machine.WireMethod.FsOp]: {
    params: Machine.FsRequest,
    result: Machine.FsResult,
  },
  [Machine.WireMethod.FsStream]: {
    params: Machine.FsStreamRequest,
    result: Machine.FsStreamResult,
  },
  /**
   * Machine host → machine daemon (#1274): one bounded screen capture, and
   * guarded input actions tied to the latest successful capture id.
   */
  [Machine.WireMethod.ScreenRead]: {
    params: Machine.ScreenReadRequest,
    result: Machine.ScreenReadResult,
  },
  [Machine.WireMethod.InputWrite]: {
    params: Machine.InputWriteRequest,
    result: Machine.InputWriteResult,
  },
  /**
   * Machine host → machine daemon (#1273): persistent named terminals over
   * tmux. `pty_read` is the authoritative pull; `machine.pty_output` is a
   * notification (no reply), so it has no entry in this request table.
   */
  [Machine.WireMethod.PtyOpen]: { params: Machine.PtyOpenRequest, result: Machine.PtyOpenResult },
  [Machine.WireMethod.PtyWrite]: { params: Machine.PtyWriteRequest, result: Machine.PtyWriteResult },
  [Machine.WireMethod.PtyRead]: {
    params: Machine.PtyReadParams,
    result: z.union([Machine.PtyReadResult, Machine.PtyScreenResult]),
  },
  [Machine.WireMethod.PtyResize]: {
    params: Machine.PtyResizeRequest,
    result: Machine.PtyResizeResult,
  },
  [Machine.WireMethod.PtyClose]: { params: Machine.PtyCloseRequest, result: Machine.PtyCloseResult },
  [Machine.WireMethod.PtyList]: { params: Machine.PtyListRequest, result: Machine.PtyListResult },
  [Machine.WireMethod.AgentSessionList]: {
    params: Machine.AgentSessionListRequest, result: Machine.AgentSessionListResult,
  },
  [Machine.WireMethod.AgentSessionOpen]: {
    params: Machine.AgentSessionOpenRequest, result: Machine.AgentSessionOpenResult,
  },
  [Machine.WireMethod.AgentSessionTail]: {
    params: Machine.AgentSessionTailRequest, result: Machine.AgentSessionTailResult,
  },
  [Machine.WireMethod.AgentSessionSend]: {
    params: Machine.AgentSessionSendRequest, result: Machine.AgentSessionSendResult,
  },
  [Machine.WireMethod.AgentSessionStop]: {
    params: Machine.AgentSessionStopRequest, result: Machine.AgentSessionStopResult,
  },
  [Machine.WireMethod.AgentPermission]: {
    params: Machine.AgentPermissionRequest, result: Machine.AgentPermissionDecision,
  },
  /**
   * Computer use (#1662), all gated by `computer.use` in the effective set.
   * Host → peer: screen list/capture, typed input (answered with the legacy
   * `InputWriteResult` vocabulary), stream open and cdp open. Either
   * direction: stream signal/close and cdp chunk/close, so both sides share
   * one entry per method.
   */
  [Machine.WireMethod.ScreenList]: { params: Machine.ScreenListRequest, result: Machine.ScreenListResult },
  [Machine.WireMethod.ScreenCapture]: {
    params: Machine.ScreenCaptureRequest,
    result: Machine.ScreenCaptureResult,
  },
  [Machine.WireMethod.InputPointer]: { params: Machine.InputPointerRequest, result: Machine.InputWriteResult },
  [Machine.WireMethod.InputKey]: { params: Machine.InputKeyRequest, result: Machine.InputWriteResult },
  [Machine.WireMethod.InputText]: { params: Machine.InputTextRequest, result: Machine.InputWriteResult },
  [Machine.WireMethod.InputStatus]: { params: Machine.InputStatusRequest, result: Machine.InputStatusResult },
  [Machine.WireMethod.AppLaunch]: { params: Machine.AppLaunchRequest, result: Machine.AppLaunchResult },
  [Machine.WireMethod.AppQuit]: { params: Machine.AppQuitRequest, result: Machine.AppQuitResult },
  [Machine.WireMethod.WindowClose]: { params: Machine.WindowCloseRequest, result: Machine.WindowCloseResult },
  [Machine.WireMethod.WindowPark]: { params: Machine.WindowParkRequest, result: Machine.WindowParkResult },
  [Machine.WireMethod.StreamOpen]: { params: Machine.StreamOpenRequest, result: Machine.StreamOpenResult },
  [Machine.WireMethod.StreamSignal]: {
    params: Machine.StreamSignalRequest,
    result: Machine.StreamSignalResult,
  },
  [Machine.WireMethod.StreamClose]: { params: Machine.StreamCloseRequest, result: Machine.StreamCloseResult },
  [Machine.WireMethod.CdpOpen]: { params: Machine.CdpOpenRequest, result: Machine.CdpOpenResult },
  [Machine.WireMethod.CdpChunk]: { params: Machine.CdpChunk, result: Machine.CdpChunkResult },
  [Machine.WireMethod.CdpClose]: { params: Machine.CdpCloseRequest, result: Machine.CdpCloseResult },
  [Machine.WireMethod.ScreenObserve]: {
    params: Machine.ScreenObserveRequest,
    result: Machine.ScreenObserveResult,
  },
  [Machine.WireMethod.ScreenSettle]: { params: Machine.ScreenSettleRequest, result: Machine.ScreenSettleResult },
  [Machine.WireMethod.InputAction]: { params: Machine.InputActionRequest, result: Machine.InputWriteResult },
  [Machine.WireMethod.EventPrivate]: {
    params: Machine.PrivateEvent,
    result: z.discriminatedUnion("status", [
      z.object({ status: z.literal("accepted") }).strict(),
      z.object({
        status: z.literal("refused"),
        reason: z.enum(["machine_not_attached", "machine_mismatch"]),
      }).strict(),
    ]),
  },
};

export namespace Ipc {
  export const Request = requestSchema;
  export const Response = responseSchema;
  export const Notification = notificationSchema;
  export const Methods = methods;

  export type Request = z.infer<typeof requestSchema>;
  export type Response = z.infer<typeof responseSchema>;
  export type Notification = z.infer<typeof notificationSchema>;

  const version = 2;

  export function createRequest(
    id: string,
    method: string,
    params?: Request["params"],
  ): Request {
    return { v: version, type: "request", id, method, params };
  }

  export function createResponse(id: string, result: Response["result"]): Response {
    return { v: version, type: "response", id, result };
  }

  export function createErrorResponse(id: string, code: number, message: string): Response {
    return { v: version, type: "response", id, error: { code, message } };
  }

  export function createNotification(
    method: string,
    params?: Notification["params"],
  ): Notification {
    return { v: version, type: "notification", method, params };
  }
}
