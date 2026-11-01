import { z } from "zod";
import { EpochMs } from "../time.js";
import { PlainValueSchema } from "../json.js";
import { sha256Hex } from "../sha256.js";
import { WindowTarget } from "./target.js";
import { HumanInput, Session, TransportFacts } from "./facts.js";
import { InputRequestId } from "./dispatch.js";
import { Screen } from "./probe.js";

/**
 * Capability id grammar: two-plus dot-separated lowercase segments —
 * `fs.read`, `shell.exec`, `kernel.py`, `screen.read`, `input.write`.
 * The vocabulary is open (drivers introduce ids as they earn them); the
 * GRAMMAR is owned here so the enrollment writer, the daemon's offer, and
 * the tool catalog's `requires` can never drift into three spellings.
 */
export const CapabilityId = z
  .string()
  .max(128, { message: "capability id must be at most 128 characters" })
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, {
    message: "capability id must be dot-namespaced lowercase (e.g. fs.read)",
  });
export type CapabilityId = z.infer<typeof CapabilityId>;

/** Capability ids whose behavior is defined by the machine protocol. */
export const WellKnownCapability = {
  pythonKernel: "kernel.py",
  /**
   * ONE capability gates the whole read-only fs surface (read|list|stat).
   * Splitting it per-op would let an Owner grant `list` while believing they
   * withheld `read`, when a listing already leaks the names it enumerates.
   */
  fsRead: "fs.read",
  fsWrite: "fs.write",
  shellExec: "shell.exec",
  /** Bounded screen capture + accessibility tree (#1274); macOS adapter first. */
  screenRead: "screen.read",
  /** Guarded pointer/keyboard actions tied to the latest capture (#1274). */
  inputWrite: "input.write",
  /** Persistent named terminals over tmux (#1273); offered only when tmux resolves at attach. */
  ptySession: "pty.session",
  /**
   * Computer use (#1662), the wire spelling of the issue shorthand
   * `computer_use`. ONE id gates every `machine.screen.*`, `machine.input.*`,
   * `machine.stream.*` and `machine.cdp.*` method: the Owner grants it in
   * `Enrollment.allowedCapabilities`, the peer offers it only while it runs
   * with a display session, and only the effective set (enrollment ∩ offer)
   * admits a call. It neither implies nor is implied by `screen.read` /
   * `input.write`, which keep gating the legacy single-call methods.
   */
  computerUse: "computer.use",
} as const satisfies Record<string, CapabilityId>;

/**
 * Export name grammar: a daemon-local confinement root identifier.
 * Flat and lowercase so a name can never be confused with a path (no dot, no
 * slash, no leading dash that an argv parser would eat) and so the Owner's
 * enrollment spelling matches the daemon's offer byte for byte.
 */
export const ExportName = z
  .string()
  .max(64, { message: "export name must be at most 64 characters" })
  .regex(/^[a-z][a-z0-9_-]*$/, {
    message: "export name must be lowercase alphanumeric with - or _ (e.g. notes)",
  });
export type ExportName = z.infer<typeof ExportName>;

export const AbsolutePath = z
  .string()
  .refine(
    (path) => path.startsWith("/") && !path.includes("\0") && !path.split("/").includes(".."),
    { message: "expected an absolute path without NUL or .. segments" },
  );

export const MachineId = z.string().min(1);
export type MachineId = z.infer<typeof MachineId>;

/**
 * Canonical textual form of a TLS public-key pin (#1270): exactly the 64
 * lowercase hex characters of sha256(SubjectPublicKeyInfo DER). One spelling
 * owned here so the Owner's enrollment, the daemon's pinned host key, and the
 * transport's extracted peer key can never drift into case or encoding skew.
 */
export const KeyFingerprint = z.string().regex(/^[0-9a-f]{64}$/, {
  message: "key fingerprint must be 64 lowercase hex chars of sha256(SPKI DER)",
});
export type KeyFingerprint = z.infer<typeof KeyFingerprint>;

/** The ONE pin computation: sha256 over the SubjectPublicKeyInfo DER bytes. */
export function fingerprintOf(spkiDer: Uint8Array): KeyFingerprint {
  return sha256Hex(spkiDer);
}

/** One owner for the frozen machine wire method names used by both peers. */
export const WireMethod = {
  Attach: "machine.attach",
  /** Daemon → host heartbeat (#1555); answered with `ReportResult`. */
  Report: "machine.report",
  EventHumanInput: "machine.event.human_input",
  Ping: "machine.ping",
  RunCode: "machine.run_code",
  CancelCode: "machine.cancel_code",
  PeekCode: "machine.peek_code",
  Exec: "machine.exec",
  CallTool: "machine.call_tool",
  FsOp: "machine.fs_op",
  FsStream: "machine.fs_stream",
  ScreenRead: "machine.screen_read",
  InputWrite: "machine.input_write",
  PtyOpen: "machine.pty_open",
  PtyWrite: "machine.pty_write",
  PtyRead: "machine.pty_read",
  PtyResize: "machine.pty_resize",
  PtyClose: "machine.pty_close",
  PtyList: "machine.pty_list",
  /** Daemon → host wake-up; carries no authoritative output state (#1273). */
  PtyOutput: "machine.pty_output",
  AgentSessionList: "agent.session.list",
  AgentSessionOpen: "agent.session.open",
  AgentSessionTail: "agent.session.tail",
  AgentSessionSend: "agent.session.send",
  AgentSessionStop: "agent.session.stop",
  /** Machine → host; the correlated response is the host's tool.pre decision. */
  AgentPermission: "agent.session.permission",
  /** Computer use (#1662): every method below is gated by `computer.use`. */
  ScreenList: "machine.screen.list",
  ScreenCapture: "machine.screen.capture",
  ClipboardRead: "machine.clipboard.read",
  ClipboardWrite: "machine.clipboard.write",
  InputPointer: "machine.input.pointer",
  InputKey: "machine.input.key",
  InputText: "machine.input.text",
  InputStatus: "machine.input.status",
  AppLaunch: "machine.app.launch",
  AppQuit: "machine.app.quit",
  WindowClose: "machine.window.close",
  WindowPark: "machine.window.park",
  StreamOpen: "machine.stream.open",
  /** Either direction: one typed SDP/ICE/data record of an open stream. */
  StreamSignal: "machine.stream.signal",
  StreamClose: "machine.stream.close",
  CdpOpen: "machine.cdp.open",
  /** Either direction: one bounded opaque chunk of an open debugging channel. */
  CdpChunk: "machine.cdp.chunk",
  CdpClose: "machine.cdp.close",
  /** Window-bound observation (#1689), gated by `computer.use`. */
  ScreenObserve: "machine.screen.observe",
  ScreenSettle: "machine.screen.settle",
  InputAction: "machine.input.action",
  /** Client → host before any attach (#1696); answered with `ReleaseResult`. */
  Release: "machine.release",
  /** Daemon → host edge when a window enters or leaves private focus. */
  EventPrivate: "machine.event.private",
  ComputerClose: "machine.computer.close",
} as const;

/** Shared by Enrollment/Offer arrays and the machine.attached event payload. */
export function uniqueCapabilities(capabilities: string[], ctx: z.RefinementCtx): void {
  if (new Set(capabilities).size !== capabilities.length) {
    ctx.addIssue({ code: "custom", message: "capabilities must be unique" });
  }
}

/** Shared by the enrollment allowlist, the offer, and the attach result. */
function uniqueExports(names: string[], ctx: z.RefinementCtx): void {
  if (new Set(names).size !== names.length) {
    ctx.addIssue({ code: "custom", message: "export names must be unique" });
  }
}

/**
 * Owner-side admission record: what this machine is ALLOWED to do.
 * One half of the effective-capability fold (`fold.ts`) — the other half is
 * the daemon's `Offer`. An enrollment with no capability is a contradiction
 * (there would be nothing to attach for), hence `.min(1)`.
 */
export const Enrollment = z
  .object({
    machineId: MachineId,
    name: z.string().min(1),
    tags: z.array(z.string().min(1)).optional(),
    allowedCapabilities: z.array(CapabilityId).min(1).superRefine(uniqueCapabilities),
    /**
     * Which exports the fs surface may reach. Absence grants no exports.
     */
    allowedExports: z.array(ExportName).superRefine(uniqueExports).optional(),
    /** Pinned daemon TLS public key; TCP attach is refused unless the peer presents it. */
    publicKey: KeyFingerprint,
    enrolledAt: EpochMs,
  })
  .strict();
export type Enrollment = z.infer<typeof Enrollment>;

/**
 * Static capacity facts a daemon states at attach (#1555). Observations,
 * never policy: absent means unknown and the host does not default them.
 */
export const Resources = z
  .object({
    cpus: z.number().int().positive(),
    memoryBytes: z.number().int().positive(),
  })
  .strict();
export type Resources = z.infer<typeof Resources>;

const CapacityFields = {
  slots: z.number().int().positive().optional(),
  memReserveBytes: z.number().int().nonnegative().optional(),
  classCosts: z.object({
    exec: z.literal(1),
    eval: z.literal(1),
    pty: z.literal(1),
    job: z.number().positive(),
  }).strict().optional(),
};
export const CapacityRow = z.union([
  z.object({ machineId: MachineId, ...CapacityFields }).strict(),
  z.object({ tag: z.string().min(1), ...CapacityFields }).strict(),
]);
export type CapacityRow = z.infer<typeof CapacityRow>;
export const CapacityRows = z.array(CapacityRow).superRefine((rows, ctx) => {
  const selectors = rows.map((row) => "machineId" in row ? `id:${row.machineId}` : `tag:${row.tag}`);
  if (new Set(selectors).size !== selectors.length)
    ctx.addIssue({ code: "custom", message: "capacity selectors must be unique" });
});
export const LeaseRefusal = z.object({
  machineId: MachineId,
  reason: z.enum(["slots", "memory"]),
  /** Null means no slot count was offered or configured. */
  slots: z.number().int().positive().nullable(),
  inFlight: z.number().nonnegative(),
  memoryAvailableBytes: z.number().int().nonnegative().optional(),
  memReserveBytes: z.number().int().nonnegative().optional(),
}).strict();
export type LeaseRefusal = z.infer<typeof LeaseRefusal>;

/**
 * Which kind of peer offers the attachment and which machine contract version
 * it speaks. The host admits only versions it supports.
 */
export const Peer = z
  .object({
    kind: z.enum(["daemon", "client"]),
    contractVersion: z.number().int().min(1),
  })
  .strict();

/**
 * Host-minted attach generation: grows by one on every fresh attach of a
 * machine id, so a superseded attachment is fenced by its older value.
 */
export const AttachGeneration = z.number().int().min(1);

/**
 * Daemon-side attach report: what this machine CAN do right now.
 * May be empty — a daemon is allowed to attach before any capability module
 * is ready; it simply yields an empty effective set until it re-offers.
 */
export const Offer = z
  .object({
    machineId: MachineId,
    offeredCapabilities: z.array(CapabilityId).superRefine(uniqueCapabilities),
    capabilities: z.array(z.string().min(1)).superRefine(uniqueCapabilities).optional(),
    resources: Resources.optional(),
    /**
     * Real absolute roots used to translate consumer paths into confined wire
     * requests. Longest matching root wins; equal roots are ambiguous.
     */
    exports: z
      .array(z.object({ name: ExportName, path: AbsolutePath }).strict())
      .superRefine((entries, ctx) => {
        uniqueExports(
          entries.map((entry) => entry.name),
          ctx,
        );
      })
      .optional(),
    daemonVersion: z.string().min(1),
    /** e.g. "darwin-arm64" — display/diagnostic fact, never a matching key. */
    platform: z.string().min(1),
    offeredAt: EpochMs,
    peer: Peer,
    /**
     * The last generation the host accepted, presented on reconnect. Absent
     * on a fresh attach, which mints a new generation.
     */
    generation: AttachGeneration.optional(),
  })
  .strict();
export type Offer = z.infer<typeof Offer>;

/**
 * Live stream bounds (#1662), owned here because `machine.report` carries
 * per-stream observations and the stream contracts quote the same numbers.
 */
export const STREAM_MAX_FPS = 60;
/** Open streams per attachment; also bounds the observations one report carries. */
export const STREAM_MAX_CONCURRENT = 4;
export const STREAM_ENCODE_MAX_MS = 60_000;

/** Host-minted id of one live stream, unique within its attachment. */
export const StreamId = z.string().min(1).max(128);
export type StreamId = z.infer<typeof StreamId>;

/**
 * One open stream's encoder facts at report time (#1662): measured rates
 * over the report interval, never targets. `retainedBytes` is the frame-pool
 * memory the stream holds, so the host can see the bounded pool working.
 */
export const StreamObservation = z
  .object({
    streamId: StreamId,
    private: z.boolean(),
    fps: z.number().nonnegative().max(STREAM_MAX_FPS),
    bytesPerSecond: z.number().int().nonnegative(),
    encodeMs: z.number().nonnegative().max(STREAM_ENCODE_MAX_MS),
    droppedFrames: z.number().int().nonnegative(),
    retainedBytes: z.number().int().nonnegative(),
  })
  .strict();
export type StreamObservation = z.infer<typeof StreamObservation>;

/** Live load facts carried by one `machine.report` heartbeat (#1555). */
export const Load = z
  .object({
    /** One-minute load average as the daemon's OS reports it. */
    loadAvg1: z.number().nonnegative(),
    memoryAvailableBytes: z.number().int().nonnegative(),
    /** Cells the daemon is executing at report time. */
    inFlight: z.number().int().nonnegative(),
  })
  .strict();
export type Load = z.infer<typeof Load>;

/**
 * Daemon → host heartbeat (#1555): one per report interval after attach.
 * The host stores only the latest report per attachment and derives
 * staleness from its own clock; nothing here is extrapolated.
 */
export const Report = z
  .object({
    machineId: MachineId,
    reportedAt: EpochMs,
    load: Load,
    /** Absent from clients predating the screen fact; the host treats it as unknown. */
    screen: Screen.optional(),
    humanInput: HumanInput.optional(),
    session: Session.optional(),
    transport: TransportFacts.optional(),
    /**
     * Open live streams at report time (#1662). Absent when none is open; a
     * peer only has streams after the host opened them, so a host that never
     * calls `machine.stream.open` never receives this field.
     */
    streams: z.array(StreamObservation).max(STREAM_MAX_CONCURRENT).optional(),
  })
  .strict();
export type Report = z.infer<typeof Report>;


/**
 * Host reply to `machine.report`. A refusal is a typed outcome: the report
 * came over a connection with no attachment, or named another machine; the
 * host keeps nothing from it.
 */
export const ReportResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("accepted") }).strict(),
  z
    .object({
      status: z.literal("refused"),
      reason: z.enum(["machine_not_attached", "machine_mismatch", "invalid_report"]),
    })
    .strict(),
]);
export type ReportResult = z.infer<typeof ReportResult>;

/**
 * Host reply to a daemon's `machine.attach` wire call. `refused` is a typed
 * outcome, not a transport error: the connection stays open and the daemon
 * may re-offer after the Owner fixes the enrollment.
 */
export const AttachResult = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("attached"),
      effectiveCapabilities: z.array(CapabilityId).superRefine(uniqueCapabilities),
      effectiveExports: z.array(ExportName).superRefine(uniqueExports),
      /** The generation this attachment holds; present it on reconnect. */
      generation: AttachGeneration,
    })
    .strict(),
  z
    .object({
      status: z.literal("refused"),
      reason: z.enum([
        "machine_not_enrolled",
        "machine_mismatch",
        "peer_key_mismatch",
        "disconnected",
        // #1271: the id has a live attachment the host refuses to supersede
        // (the brain's own `self` daemon must never be hijacked by a reattach).
        "already_attached",
        // The offered peer speaks a contract version the host does not support.
        "unsupported_contract",
        // The presented generation is not the one the host holds for the id.
        "stale_generation",
      ]),
    })
    .strict(),
]);
export type AttachResult = z.infer<typeof AttachResult>;

export const CellRequest = z
  .object({
    cellId: z.string().min(1),
    code: z.string(),
    timeoutMs: z.number().int().positive(),
    /**
     * Which tenant's interpreter runs the cell. One attachment can serve
     * several sessions, and a Python interpreter offers no in-process
     * isolation — state, and any thread a cell leaves behind, are reachable
     * by whatever runs in that process next. The daemon therefore keeps one
     * interpreter per tenant so a cell can only ever share a process with
     * cells of the same session. Absent on the wire reads as "default".
     */
    tenant: z.string().min(1).optional(),
  })
  .strict();
export type CellRequest = z.infer<typeof CellRequest>;

/** Maximum retained UTF-8 prefix bytes per cell output stream. */
export const CELL_OUTPUT_MAX_BYTES = 65_536;
const TruncatedStream = z.object({ originalBytes: z.number().int().nonnegative() }).strict();
export const CellOutput = z
  .object({
    stdout: z.string(),
    stderr: z.string(),
    truncated: z.object({ stdout: TruncatedStream.optional(), stderr: TruncatedStream.optional() }).strict().optional(),
  })
  .strict()
  .superRefine((output, context) => {
    for (const stream of ["stdout", "stderr"] as const) {
      const bytes = new TextEncoder().encode(output[stream]).length;
      // A truncated stream retains its bounded prefix and a short visible marker.
      if (bytes > CELL_OUTPUT_MAX_BYTES + (output.truncated?.[stream] ? 96 : 0))
        context.addIssue({ code: "custom", path: [stream], message: "cell output exceeds its per-stream byte bound" });
    }
  });
export type CellOutput = z.infer<typeof CellOutput>;

/**
 * A `tool.<name>(...)` call made from inside a running cell, travelling back to
 * the host over the same attachment (docs/machines-and-delegation.md §5.5).
 * This is what makes a cell worth more than N tool round trips.
 */
export const ToolCall = z
  .object({
    cellId: z.string().min(1),
    name: z.string().min(1),
    arguments: z.record(z.string(), PlainValueSchema),
  })
  .strict();
export type ToolCall = z.infer<typeof ToolCall>;

/**
 * Two arms because the cell can only do two things with the answer: use the
 * value, or see an exception. A refused tool is a `failed` whose message says
 * so — the host's tool port owns that judgment, not this contract.
 */
export const ToolCallResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), value: PlainValueSchema.optional() }).strict(),
  z.object({ status: z.literal("failed"), error: z.string().min(1) }).strict(),
]);
export type ToolCallResult = z.infer<typeof ToolCallResult>;

/**
 * The cell's `completion(prompt, {model?, system?, schema?})` call as it reaches
 * the host: one prompt, an optional model id on the brain's configured
 * provider, an optional system instruction, and an optional JSON Schema the
 * answer must satisfy (the host returns the validated JSON text).
 */
export const CompletionRequest = z
  .object({
    prompt: z.string().min(1).describe("One complete instruction for a stateless sub-model call."),
    model: z
      .string()
      .min(1)
      .optional()
      .describe("A model id on the configured provider; the default model when omitted."),
    system: z.string().min(1).optional().describe("System text for the sub-model call."),
    // z.json(), not PlainValueSchema: this object is also the tool's wire input schema.
    schema: z
      .record(z.string(), z.json())
      .optional()
      .describe("A JSON Schema the answer must satisfy; the validated JSON text is returned."),
  })
  .strict();
export type CompletionRequest = z.infer<typeof CompletionRequest>;

/**
 * Honest Python cell terminals: deadline expiry is never collapsed into a
 * raise, and an interrupted cell still reports the output it produced first.
 */
export const CellResult = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("completed"),
      cellId: z.string().min(1),
      output: CellOutput,
      value: z.string().optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("raised"),
      cellId: z.string().min(1),
      output: CellOutput,
      error: z.string(),
    })
    .strict(),
  z
    .object({ status: z.literal("timed_out"), cellId: z.string().min(1), output: CellOutput })
    .strict(),
  z
    .object({ status: z.literal("cancelled"), cellId: z.string().min(1), output: CellOutput })
    .strict(),
  z
    .object({
      status: z.literal("refused"),
      reason: z.enum(["machine_not_attached", "kernel_not_available"]),
    })
    .strict(),
]);
export type CellResult = z.infer<typeof CellResult>;

/**
 * What a cell looks like from the outside: settled, or still running with the
 * output it has produced so far. `eval run` answers with this once its wait
 * elapses; `eval peek`/`eval stop` answer with it by cell id.
 */
export const CellState = z.discriminatedUnion("status", [
  ...CellResult.options,
  z
    .object({ status: z.literal("running"), cellId: z.string().min(1), output: CellOutput })
    .strict(),
]);
export type CellState = z.infer<typeof CellState>;

/**
 * Ceilings for one fs op, owned here so host, daemon, and tool surface quote
 * the same number. The daemon ENFORCES them (it is the only side holding the
 * bytes); the contract only names them and reports `truncated` when they bite.
 */
export const FS_READ_MAX_BYTES = 262_144;
export const FS_WRITE_MAX_BYTES = 262_144;
export const EXEC_MAX_BYTES = 262_144;
export const EXEC_TIMEOUT_MS = 30_000;
const Base64 = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
export const FS_LIST_MAX_ENTRIES = 1000;

/**
 * A path INSIDE an export: `""` is the export root, otherwise slash-separated
 * relative segments. The schema refuses the three shapes that turn a relative
 * path into an escape — a leading `/` (re-anchors at the real filesystem root),
 * any `..` segment (climbs out before any realpath check runs), and an embedded
 * NUL (truncates the path in a C syscall past whatever we validated). This is a
 * cheap first gate, not the confinement boundary: the daemon still resolves and
 * re-checks containment against its own export root.
 */
const FsPath = z
  .string()
  .refine(
    (value) =>
      !(value.startsWith("/") || value.includes("\u0000")) &&
      !value.split("/").some((segment) => segment === ".."),
    { message: "path must be relative to the export root, with no .. segment or NUL" },
  );

/** Export-relative requests; the daemon owns the final confinement check. */
export const FsRequest = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("read"),
      export: ExportName,
      path: FsPath,
      /** Byte window into the file; absent reads from the start, up to the cap. */
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().optional(),
    })
    .strict(),
  z.object({ op: z.literal("write"), export: ExportName, path: FsPath, data: Base64, create: z.literal("exclusive").optional() }).strict(),
  z.object({ op: z.literal("list"), export: ExportName, path: FsPath }).strict(),
  z.object({ op: z.literal("stat"), export: ExportName, path: FsPath }).strict(),
]);
export type FsRequest = z.infer<typeof FsRequest>;

/**
 * What a path IS, coarsely. `symlink` stays visible rather than being resolved
 * away, because a link is exactly the entry whose target may sit outside the
 * export; `other` covers sockets/devices the read surface will not open.
 */
const FsEntryKind = z.enum(["file", "dir", "symlink", "other"]);

/** Answer shapes keyed by the op that asked, so a reply can never be mismatched. */
const FsValue = z.discriminatedUnion("op", [
  z.object({ op: z.literal("write"), bytesWritten: z.number().int().nonnegative() }).strict(),
  z
    .object({
      op: z.literal("read"),
      /**
       * Lossless base64 bytes on JSON wire; consumer handles decode to bytes.
       */
      data: Base64,
      bytesRead: z.number().int().nonnegative(),
      /** Full file size, so a truncated read still reports what it missed. */
      size: z.number().int().nonnegative(),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      op: z.literal("list"),
      entries: z.array(
        z
          .object({
            name: z.string().min(1),
            kind: FsEntryKind,
            size: z.number().int().nonnegative().optional(),
          })
          .strict(),
      ),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      op: z.literal("stat"),
      kind: FsEntryKind,
      size: z.number().int().nonnegative(),
      mtimeMs: z.number(),
    })
    .strict(),
]);
export type FsValue = z.infer<typeof FsValue>;

/**
 * `refused` is a typed outcome, not a transport error: the attachment survives
 * and the model learns WHY. The reasons stay coarse on purpose —
 * `path_escapes_export` and `export_not_available` say a boundary held, without
 * disclosing whether the target exists behind it.
 */
export const FsResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), value: FsValue }).strict(),
  z
    .object({
      status: z.literal("refused"),
      reason: z.enum([
        "export_not_available",
        "path_escapes_export",
        "not_found",
        "already_exists",
        "wrong_kind",
        "io_error",
        "too_large",
        "ambiguous_export",
        "machine_not_attached",
        "fs_not_available",
      ]),
      message: z.string().min(1),
    })
    .strict(),
]);
export type FsResult = z.infer<typeof FsResult>;

const TransferId = z.string().min(1).max(128);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const TransferSeq = z.number().int().nonnegative();
const FsChunk = Base64.max(Math.ceil(FS_WRITE_MAX_BYTES / 3) * 4);
export const FsStreamRequest = z.discriminatedUnion("op", [
  z.object({ op: z.literal("begin"), transferId: TransferId, mode: z.enum(["read", "write"]), export: ExportName, path: FsPath, offset: TransferSeq.optional(), limit: z.number().int().positive().optional(), create: z.literal("exclusive").optional() }).strict(),
  z.object({ op: z.literal("read"), transferId: TransferId, seq: TransferSeq }).strict(),
  z.object({ op: z.literal("write"), transferId: TransferId, seq: TransferSeq, data: FsChunk, last: z.boolean(), digest: Digest.optional() }).strict(),
  z.object({ op: z.literal("finish"), transferId: TransferId }).strict(),
  z.object({ op: z.literal("abort"), transferId: TransferId }).strict(),
]);
export type FsStreamRequest = z.infer<typeof FsStreamRequest>;

export const FsStreamResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("begun"), seq: TransferSeq, size: TransferSeq }).strict(),
  z.object({ status: z.literal("chunk"), seq: TransferSeq, data: FsChunk, last: z.boolean(), digest: Digest.optional() }).strict(),
  z.object({ status: z.literal("written"), seq: TransferSeq, bytesWritten: TransferSeq, last: z.boolean() }).strict(),
  z.object({ status: z.literal("finished") }).strict(),
  z.object({ status: z.literal("refused"), reason: z.enum(["export_not_available", "path_escapes_export", "not_found", "already_exists", "wrong_kind", "io_error", "too_large", "fs_not_available", "machine_not_attached", "ambiguous_export", "transfer_not_found", "invalid_sequence", "digest_mismatch"]), message: z.string().min(1) }).strict(),
]);
export type FsStreamResult = z.infer<typeof FsStreamResult>;

export const ExecRequest = z.object({ cmd: z.string().min(1), cwd: AbsolutePath }).strict();
export type ExecRequest = z.infer<typeof ExecRequest>;
export const ExecResult = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("completed"),
      stdout: Base64,
      stderr: Base64,
      exitCode: z.number().int().nullable(),
      signal: z.string().nullable(),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      status: z.literal("refused"),
      reason: z.enum([
        "machine_not_attached",
        "exec_not_available",
        "path_escapes_export",
        "io_error",
      ]),
    })
    .strict(),
  z.object({ status: z.enum(["timed_out", "cancelled"]) }).strict(),
]);
export type ExecResult = z.infer<typeof ExecResult>;
export const CancelCode = z.object({ cellId: z.string().min(1) }).strict();
export const CancelResult = z.object({ cancelled: z.boolean() }).strict();
/** Machine host → machine client: the output a live cell has produced so far. */
export const PeekCode = z.object({ cellId: z.string().min(1) }).strict();
export const PeekResult = z.object({ running: z.boolean(), output: CellOutput }).strict();
/**
 * `machine.peek_code` refusal when the client has no code runner at all
 * (#1312) — never fabricated empty output. `PeekResult` keeps its shape; the
 * wire answer is the union `PeekAnswer`.
 */
export const PeekRefused = z.object({ status: z.literal("refused"), reason: z.literal("kernel_not_available") }).strict();
export const PeekAnswer = z.union([PeekResult, PeekRefused]);

/**
 * Computer use (#1274): bounded screen captures and guarded input actions.
 * Ceilings are protocol-owned so host, daemon, and handles quote the same
 * numbers; the daemon enforces them (it is the side holding the bytes).
 */
export const SCREEN_PNG_MAX_BYTES = 4_194_304;
/** Base64 length that decodes to at most SCREEN_PNG_MAX_BYTES bytes. */
const SCREEN_PNG_MAX_BASE64 = Math.ceil(SCREEN_PNG_MAX_BYTES / 3) * 4;
/** Serialized ceiling for the optional accessibility-tree JSON value. */
export const SCREEN_AX_MAX_BYTES = 262_144;
export const INPUT_MAX_ACTIONS = 32;
export const INPUT_MAX_TEXT_CHARS = 10_000;

/**
 * Display-relative points (origin at the selected display's top-left). The
 * daemon validates a region against the selected display's measured bounds
 * before invoking any capture or input command.
 */
const ScreenCoordinate = z.number().int().nonnegative();
export const ScreenRegion = z
  .object({
    x: ScreenCoordinate,
    y: ScreenCoordinate,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();
export type ScreenRegion = z.infer<typeof ScreenRegion>;

/** `display` is the 1-based display index (screencapture's -D numbering). */
export const ScreenReadRequest = z
  .object({ display: z.number().int().positive().optional(), region: ScreenRegion.optional() })
  .strict();
export type ScreenReadRequest = z.infer<typeof ScreenReadRequest>;

/**
 * The tree is plain JSON, present only when the Accessibility permission
 * probe succeeds, and bounded so one capture can never flood the wire.
 */
const BoundedAccessibilityTree = PlainValueSchema.superRefine((value, ctx) => {
  if (new TextEncoder().encode(JSON.stringify(value)).length > SCREEN_AX_MAX_BYTES) {
    ctx.addIssue({
      code: "custom",
      message: `accessibility tree exceeds ${SCREEN_AX_MAX_BYTES} serialized bytes`,
    });
  }
});

/**
 * `refused` is a typed outcome, not a transport error: `permission_denied`
 * reports a revoked TCC grant, `screen_not_available` a missing prerequisite,
 * `capture_failed` a command failure that is neither, and (#1312) the causes
 * formerly folded into those: `spawn_failed` a binary that would not start,
 * `read_failed` a capture file that could not be read back, `probe_timeout`
 * a prerequisite probe that outlived its deadline.
 * An over-cap PNG is downscaled and re-encoded, never truncated.
 */
export const ScreenReadResult = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      captureId: z.string().min(1),
      png: Base64.min(1).max(SCREEN_PNG_MAX_BASE64),
      accessibilityTree: BoundedAccessibilityTree.optional(),
      /** A per-window accessibility lookup failed; the frame is unmasked for that window. */
      accessibilityUnavailable: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("refused"),
      reason: z.enum([
        "machine_not_attached",
        "screen_not_available",
        "invalid_region",
        "permission_denied",
        "capture_failed",
        "spawn_failed",
        "read_failed",
        "probe_timeout",
      ]),
    })
    .strict(),
]);
export type ScreenReadResult = z.infer<typeof ScreenReadResult>;

/**
 * One guarded action. Coordinates are display-relative points on the display
 * of the capture the request names; `key.name` uses the adapter's key
 * vocabulary (an unknown name refuses `unsupported_action` before anything
 * executes).
 */
export const InputAction = z.union([
  z
    .object({
      click: z
        .object({
          x: ScreenCoordinate,
          y: ScreenCoordinate,
          button: z.enum(["left", "right", "middle"]).optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ type: z.object({ text: z.string().min(1).max(INPUT_MAX_TEXT_CHARS) }).strict() }).strict(),
  z.object({ key: z.object({ name: z.string().min(1).max(64) }).strict() }).strict(),
  z.object({ move: z.object({ x: ScreenCoordinate, y: ScreenCoordinate }).strict() }).strict(),
  z
    .object({
      scroll: z
        .object({ deltaX: z.number().int().optional(), deltaY: z.number().int().optional() })
        .strict(),
    })
    .strict(),
]);
export type InputAction = z.infer<typeof InputAction>;

/**
 * Actions are tied to the LATEST successful capture: any other id refuses
 * `stale_capture` and executes nothing — a request never partially executes.
 * Input execution is main-display only in v1: a request anchored to a capture
 * of any other display refuses `unsupported_action` (the refusal `message`
 * names the display) rather than executing at translated global coordinates.
 */
export const InputWriteRequest = z
  .object({
    captureId: z.string().min(1),
    actions: z.array(InputAction).min(1).max(INPUT_MAX_ACTIONS),
  })
  .strict();
export type InputWriteRequest = z.infer<typeof InputWriteRequest>;

export const InputWriteResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok") }).strict(),
  z.object({
    status: z.literal("unverifiable"),
    reason: z.enum(["transport_lost", "cancelled", "detached", "driver_timeout"]),
    dispatched: z.union([z.boolean(), z.literal("unknown")]),
    hint: z.literal("re_observe"),
  }).strict(),
  z
    .object({
      status: z.literal("refused"),
      reason: z.enum([
        "machine_not_attached",
        "input_not_available",
        "stale_capture",
        "invalid_region",
        "permission_denied",
        "unsupported_action",
        "input_failed",
        "spawn_failed",
        "probe_timeout",
        "epoch_changed",
        "stale_observation",
        "ref_not_found",
        "action_not_supported",
        "not_actionable",
        "window_not_found",
        "observe_not_available",
        "foreground_required",
        "window_busy",
        "request_busy",
        "private",
        "accessibility_unavailable",
        "lease_missing", "lease_expired", "target_unbound", "app_out_of_scope",
        "foreground_not_granted", "excluded", "paused:human_input", "paused:takeover",
        "paused:private", "paused:locked", "paused:asleep", "budget_exhausted", "clipboard_not_granted",
      ]),
      /** Human-readable detail, e.g. which display a refused anchor captured. */
      message: z.string().min(1).max(256).optional(),
      humanActiveMs: z.number().int().nonnegative().optional(),
      retryAfterMs: z.number().int().nonnegative().optional(),
      resetAt: z.number().nonnegative().optional(),
    })
    .strict(),
]);
export type InputWriteResult = z.infer<typeof InputWriteResult>;

/**
 * Persistent terminals (#1273): named tmux-backed sessions on an attached
 * machine. Ceilings are protocol-owned so host, daemon, and tool surfaces
 * quote the same numbers; the daemon enforces them (it holds the bytes).
 * `machine.pty_read` is the authoritative pull contract — the optional
 * `machine.pty_output` notification is only a wake-up and carries no output.
 */
export const PTY_READ_MAX_BYTES = 262_144;
/** Terminal input is keystrokes; one write is bounded well below exec output. */
export const PTY_WRITE_MAX_BYTES = 16_384;
export const PTY_LIST_MAX_SESSIONS = 1000;
export const PTY_MAX_COLS = 1000;
export const PTY_MAX_ROWS = 1000;
/** Upper bound on the optional long-poll a read may request before answering empty. */
export const PTY_READ_WAIT_MAX_MS = 30_000;
const PTY_READ_MAX_BASE64 = Math.ceil(PTY_READ_MAX_BYTES / 3) * 4;
const PTY_WRITE_MAX_BASE64 = Math.ceil(PTY_WRITE_MAX_BYTES / 3) * 4;

/**
 * Session name grammar: a stable daemon-scoped terminal identifier. Flat and
 * lowercase like {@link ExportName}, and additionally free of `.` and `:`,
 * which tmux target syntax would re-interpret as window/pane selectors.
 */
export const PtySessionName = z
  .string()
  .max(64, { message: "session name must be at most 64 characters" })
  .regex(/^[a-z0-9][a-z0-9_-]*$/, {
    message: "session name must be lowercase alphanumeric with - or _ (e.g. build)",
  });
export type PtySessionName = z.infer<typeof PtySessionName>;

/**
 * Opaque continuation token for one terminal's output stream. Callers persist
 * only the token the daemon returned and must not derive offsets from decoded
 * text; the daemon owns its shape and guarantees monotonic advancement.
 */
export const PtyCursor = z.string().min(1).max(256);
export type PtyCursor = z.infer<typeof PtyCursor>;

export const PtyOpenRequest = z.object({ name: PtySessionName, cwd: AbsolutePath }).strict();
export type PtyOpenRequest = z.infer<typeof PtyOpenRequest>;

/**
 * `refused` is a typed outcome, not a transport error: `pty_not_available`
 * reports a missing/withdrawn effective capability (tmux absent at attach or
 * its server gone), `path_escapes_export` the same confinement rule exec uses,
 * and `pty_not_found` a name the session grammar cannot address (a guard for
 * callers that bypass request validation; the wire parse rejects it first).
 * Opening an existing name reattaches; the returned cursor always points at
 * the start of the retained stream so a first read replays scrollback.
 */
export const PtyOpenResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), cursor: PtyCursor }).strict(),
  z
    .object({
      status: z.literal("refused"),
      reason: z.enum(["machine_not_attached", "pty_not_available", "path_escapes_export", "pty_not_found"]),
    })
    .strict(),
]);
export type PtyOpenResult = z.infer<typeof PtyOpenResult>;

/** `data` is terminal input bytes as base64; the daemon sends them literally. */
export const PtyWriteRequest = z
  .object({ name: PtySessionName, data: Base64.max(PTY_WRITE_MAX_BASE64) })
  .strict();
export type PtyWriteRequest = z.infer<typeof PtyWriteRequest>;

const PtySessionRefusal = z
  .object({
    status: z.literal("refused"),
    reason: z.enum(["machine_not_attached", "pty_not_available", "pty_not_found"]),
  })
  .strict();

export const PtyWriteResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok") }).strict(),
  PtySessionRefusal,
]);
export type PtyWriteResult = z.infer<typeof PtyWriteResult>;

/**
 * Pull output after `cursor` (absent: from the start of the retained stream).
 * `waitMs` lets a caller long-poll: the daemon may hold the reply until output
 * exists after the cursor or the wait elapses, whichever is first.
 */
export const PtyReadRequest = z
  .object({
    name: PtySessionName,
    cursor: PtyCursor.optional(),
    waitMs: z.number().int().nonnegative().max(PTY_READ_WAIT_MAX_MS).optional(),
  })
  .strict();
export type PtyReadRequest = z.infer<typeof PtyReadRequest>;

/**
 * Structural screen snapshot (#1510): the rendered pane as the daemon sees it
 * right now, answered with {@link PtyScreenResult}. No cursor or wait: the
 * screen is a different representation of the same bytes, not a stream
 * position, and this request never blocks.
 */
export const PtyReadScreenRequest = z
  .object({ name: PtySessionName, source: z.literal("screen") })
  .strict();
export type PtyReadScreenRequest = z.infer<typeof PtyReadScreenRequest>;

/**
 * `machine.pty_read` params: `source` discriminates the two read modes, the
 * byte stream ({@link PtyReadRequest}, unchanged) and the screen snapshot. A
 * screen request carrying stream options (or the reverse) fails both strict
 * members and is refused at the wire parse, the one enforcement layer.
 */
export const PtyReadParams = z.union([PtyReadScreenRequest, PtyReadRequest]);
export type PtyReadParams = z.infer<typeof PtyReadParams>;

/**
 * When available output exceeds {@link PTY_READ_MAX_BYTES} the daemon returns
 * the bounded suffix with `truncated: true` and a cursor advanced past ALL
 * observed output, so repeated reads can never loop on discarded bytes.
 */
export const PtyReadResult = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      data: Base64.max(PTY_READ_MAX_BASE64),
      cursor: PtyCursor,
      truncated: z.boolean(),
    })
    .strict(),
  PtySessionRefusal,
]);
export type PtyReadResult = z.infer<typeof PtyReadResult>;

/**
 * Answer to a `source: "screen"` read (#1510): `rows` are the pane's visible
 * lines top to bottom with their escape sequences (one per pane row, so the
 * count is the pane height, bounded by {@link PTY_MAX_ROWS}); `cursor` is the
 * pane cursor in cells; `occupant` pairs two distinct tmux pane facts and must
 * be read as such: `pid` is tmux's `#{pane_pid}`, the pid of the pane's
 * initial process (the shell tmux started, the pane's root), and `command` is
 * tmux's `#{pane_current_command}`, the name of the process currently in the
 * foreground of the pane as tmux reports it. So occupant is {pid of the
 * pane's root process, name of the foreground command}; `pid` is NOT the
 * foreground process's pid (a shell running `vim` reports the shell's pid
 * with command `vim`). `null` when the pane is dead or tmux reports no pid.
 * The pid is a fact for the caller's correlation, never the terminal's
 * identity; `observedAt` is the daemon clock at capture. Idle/working/blocked
 * are not decided here.
 */
export const PtyScreenResult = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      rows: z.array(z.string()).max(PTY_MAX_ROWS),
      cursor: z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative() }).strict(),
      occupant: z.object({ pid: z.number().int().positive(), command: z.string() }).strict().nullable(),
      observedAt: EpochMs,
    })
    .strict(),
  PtySessionRefusal,
]);
export type PtyScreenResult = z.infer<typeof PtyScreenResult>;

export const PtyResizeRequest = z
  .object({
    name: PtySessionName,
    cols: z.number().int().positive().max(PTY_MAX_COLS),
    rows: z.number().int().positive().max(PTY_MAX_ROWS),
  })
  .strict();
export type PtyResizeRequest = z.infer<typeof PtyResizeRequest>;

export const PtyResizeResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok") }).strict(),
  PtySessionRefusal,
]);
export type PtyResizeResult = z.infer<typeof PtyResizeResult>;

export const PtyCloseRequest = z.object({ name: PtySessionName }).strict();
export type PtyCloseRequest = z.infer<typeof PtyCloseRequest>;

export const PtyCloseResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok") }).strict(),
  PtySessionRefusal,
]);
export type PtyCloseResult = z.infer<typeof PtyCloseResult>;

export const PtyListRequest = z.object({}).strict();
export type PtyListRequest = z.infer<typeof PtyListRequest>;

/**
 * `lost` names a tracked session whose tmux session disappeared while the
 * server lived; a whole-server loss withdraws the capability instead, so
 * every call answers `pty_not_available` until a later attach finds tmux.
 */
export const PtySessionInfo = z
  .object({ name: PtySessionName, status: z.enum(["live", "lost"]) })
  .strict();
export type PtySessionInfo = z.infer<typeof PtySessionInfo>;

export const PtyListResult = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      sessions: z.array(PtySessionInfo).max(PTY_LIST_MAX_SESSIONS),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      status: z.literal("refused"),
      reason: z.enum(["machine_not_attached", "pty_not_available"]),
    })
    .strict(),
]);
export type PtyListResult = z.infer<typeof PtyListResult>;

/** Wake-up payload only: the consumer still reads by cursor over the wire. */
export const PtyOutput = z.object({ name: PtySessionName }).strict();
export type PtyOutput = z.infer<typeof PtyOutput>;

/** Limits apply to individual wire messages, not to a session's retained history. */
export const AGENT_SESSION_MAX_RECORDS = 32;
export const AGENT_SESSION_MAX_SESSIONS = 256;
export const AGENT_SESSION_MAX_TEXT = 4096;
const AgentSessionId = z.string().min(1).max(256);
const agentProjectPattern = String.raw`^\/(?!\.\.(?:\/|$)|.*\/\.\.(?:\/|$))[^\x00]*$`;
const AgentProject = z.string().min(1).max(4096)
  .regex(new RegExp(agentProjectPattern), {
    message: "project must be an absolute path without NUL or .. segments",
  });
const AgentCli = z.enum(["claude-code", "codex", "pi", "omp"]);
const AgentText = z.string().max(AGENT_SESSION_MAX_TEXT);
const AgentRequestId = z.string().min(1).max(256);

/** The server mints this position after parsing a complete source record. */
export const AgentSessionCursor = z.object({
  sessionId: AgentSessionId,
  generation: AttachGeneration,
  byteOffset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  recordHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type AgentSessionCursor = z.infer<typeof AgentSessionCursor>;

/** A parser emits exactly one variant per record, never a guessed tool/turn hybrid. */
export const AgentTranscriptRecord = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("turn"),
    role: z.enum(["user", "assistant"]),
    text: AgentText,
  }).strict(),
  z.object({
    kind: z.literal("tool_call"),
    callId: AgentRequestId,
    name: z.string().min(1).max(128),
    input: AgentText,
  }).strict(),
  z.object({
    kind: z.literal("tool_result"),
    callId: AgentRequestId,
    output: AgentText,
    failed: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal("corrupt"),
    reason: z.enum(["invalid_encoding", "invalid_shape", "unsupported_record"]),
    excerpt: AgentText,
  }).strict(),
  z.object({
    kind: z.literal("truncated"),
    originalBytes: z.number().int().positive(),
    prefix: AgentText,
  }).strict(),
]);
export type AgentTranscriptRecord = z.infer<typeof AgentTranscriptRecord>;

export const AgentSessionInfo = z.object({
  sessionId: AgentSessionId,
  project: AgentProject,
  cli: AgentCli,
  state: z.enum(["running", "stopped"]),
}).strict();
export type AgentSessionInfo = z.infer<typeof AgentSessionInfo>;

const AgentSessionRefusal = z.object({
  status: z.literal("refused"),
  reason: z.enum([
    "machine_not_attached", "session_not_available", "session_not_found",
    "invalid_cursor", "permission_denied", "permission_timeout",
  ]),
}).strict();

export const AgentSessionListRequest = z.object({ project: AgentProject }).strict();
export type AgentSessionListRequest = z.infer<typeof AgentSessionListRequest>;
export const AgentSessionListResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    sessions: z.array(AgentSessionInfo).max(AGENT_SESSION_MAX_SESSIONS),
    truncated: z.boolean(),
  }).strict(),
  AgentSessionRefusal,
]);
export type AgentSessionListResult = z.infer<typeof AgentSessionListResult>;

export const AgentSessionOpenRequest = z.object({
  project: AgentProject,
  cli: AgentCli,
  sessionId: AgentSessionId.optional(),
}).strict();
export type AgentSessionOpenRequest = z.infer<typeof AgentSessionOpenRequest>;
export const AgentSessionOpenResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    cursor: AgentSessionCursor,
  }).strict(),
  AgentSessionRefusal,
]);
export type AgentSessionOpenResult = z.infer<typeof AgentSessionOpenResult>;

/** First pull names a session; subsequent pulls carry only the server cursor. */
export const AgentSessionTailRequest = z.union([
  z.object({ sessionId: AgentSessionId }).strict(),
  z.object({ cursor: AgentSessionCursor }).strict(),
]);
export type AgentSessionTailRequest = z.infer<typeof AgentSessionTailRequest>;
export const AgentSessionTailResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    records: z.array(AgentTranscriptRecord).max(AGENT_SESSION_MAX_RECORDS),
    cursor: AgentSessionCursor,
    hasMore: z.boolean(),
  }).strict(),
  AgentSessionRefusal,
]);
export type AgentSessionTailResult = z.infer<typeof AgentSessionTailResult>;

export const AgentSessionSendRequest = z.object({
  sessionId: AgentSessionId,
  text: AgentText.min(1),
}).strict();
export type AgentSessionSendRequest = z.infer<typeof AgentSessionSendRequest>;
export const AgentSessionSendResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok") }).strict(),
  AgentSessionRefusal,
]);
export type AgentSessionSendResult = z.infer<typeof AgentSessionSendResult>;

export const AgentSessionStopRequest = z.object({ sessionId: AgentSessionId }).strict();
export type AgentSessionStopRequest = z.infer<typeof AgentSessionStopRequest>;
export const AgentSessionStopResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok") }).strict(),
  AgentSessionRefusal,
]);
export type AgentSessionStopResult = z.infer<typeof AgentSessionStopResult>;

/** Machine-side request to the host's tool.pre gate on the same attachment. */
export const AgentPermissionRequest = z.object({
  sessionId: AgentSessionId,
  requestId: AgentRequestId,
  tool: z.string().min(1).max(128),
  description: AgentText,
}).strict();
export type AgentPermissionRequest = z.infer<typeof AgentPermissionRequest>;
export const AgentPermissionDecision = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("allowed"),
    sessionId: AgentSessionId,
    requestId: AgentRequestId,
  }).strict(),
  z.object({
    status: z.literal("refused"),
    sessionId: AgentSessionId,
    requestId: AgentRequestId,
    reason: z.enum(["denied", "timeout"]),
  }).strict(),
]);
export type AgentPermissionDecision = z.infer<typeof AgentPermissionDecision>;

/**
 * Computer use (#1662): display/window enumeration, bounded frame capture,
 * typed pointer/key/text input, a negotiated live stream and a debugging
 * channel tunnel. Every method is gated by `computer.use` in the effective
 * set. The legacy `machine.screen_read` / `machine.input_write` pair keeps
 * its callers and shapes; the methods below reuse its anchors rather than
 * restating them: captures share {@link SCREEN_PNG_MAX_BYTES} and the
 * accessibility-tree bound, input answers with {@link InputWriteResult}
 * (one refusal vocabulary), text input shares {@link INPUT_MAX_TEXT_CHARS},
 * displays keep the 1-based index of `ScreenReadRequest.display`, and the
 * screen refusal vocabulary is a strict superset of {@link ScreenReadResult}'s.
 * Mapping: `screen_read` = `screen.capture` of a display as PNG with
 * `accessibility: true`; each `input_write` action = one `input.pointer`
 * (click, move, scroll), `input.key` (key) or `input.text` (type) call.
 */

/** Pixel/point extent ceiling for every dimension and coordinate below. */
export const COMPUTER_MAX_DIMENSION = 16_384;
/** One encoded capture (PNG or JPEG) shares the legacy {@link SCREEN_PNG_MAX_BYTES} ceiling. */
const SCREEN_CAPTURE_MAX_BASE64 = SCREEN_PNG_MAX_BASE64;
export const SCREEN_LIST_MAX_DISPLAYS = 16;
export const SCREEN_LIST_MAX_WINDOWS = 512;
export const SCREEN_MAX_SCALE = 8;
export const INPUT_SCROLL_MAX_DELTA = 10_000;
export const STREAM_MAX_BITRATE_BPS = 50_000_000;
/** One encoded video frame; frames past it are dropped, never split. */
export const STREAM_FRAME_MAX_BYTES = 2_097_152;
export const STREAM_KEYFRAME_MIN_MS = 100;
export const STREAM_KEYFRAME_MAX_MS = 60_000;
export const STREAM_MAX_LIFETIME_MS = 3_600_000;
/** Signal records per stream per direction; `seq` stays below it. */
export const STREAM_MAX_SIGNALS = 256;
export const STREAM_SDP_MAX_CHARS = 65_536;
export const STREAM_CANDIDATE_MAX_CHARS = 1024;
/**
 * One relayed data-channel message. The decoded caps below are multiples of
 * 3, so the base64 length bound admits exactly that many decoded bytes.
 */
export const STREAM_DATA_MAX_BYTES = 16_383;
const STREAM_DATA_MAX_BASE64 = (STREAM_DATA_MAX_BYTES / 3) * 4;
export const CDP_CHUNK_MAX_BYTES = 262_143;
const CDP_CHUNK_MAX_BASE64 = (CDP_CHUNK_MAX_BYTES / 3) * 4;
export const CDP_MAX_LIFETIME_MS = 3_600_000;

const Coordinate = z.number().int().nonnegative().max(COMPUTER_MAX_DIMENSION);
const Extent = z.number().int().positive().max(COMPUTER_MAX_DIMENSION);
const RefusalMessage = z.string().min(1).max(256);
const CaptureId = z.string().min(1).max(128);

/** 1-based display index, the numbering of `ScreenReadRequest.display`. */
const DisplayIndex = z.number().int().positive().max(SCREEN_LIST_MAX_DISPLAYS);
/** Opaque peer-scoped window id, valid until the window closes. */
const WindowId = z.string().min(1).max(128);

/** Every legacy screen refusal plus the two targets only this surface names. */
const ScreenRefusalReason = z.enum([
  ...ScreenReadResult.options[1].shape.reason.options,
  "display_not_found",
  "window_not_found",
  "window_minimized",
  "capture_blank",
  "own_window",
  "superseded",
  "accessibility_unavailable",
]);
const ScreenRefusal = z
  .object({ status: z.literal("refused"), reason: ScreenRefusalReason, message: RefusalMessage.optional() })
  .strict();
const CaptureRefusal = z
  .object({
    status: z.literal("refused"),
    reason: z.enum([...ScreenRefusalReason.options, "private"]),
    message: RefusalMessage.optional(),
  })
  .strict();

/** `width`/`height` are display points; `scale` is pixels per point. */
export const ScreenDisplay = z
  .object({
    display: DisplayIndex,
    width: Extent,
    height: Extent,
    scale: z.number().positive().max(SCREEN_MAX_SCALE),
    primary: z.boolean(),
  })
  .strict();
export type ScreenDisplay = z.infer<typeof ScreenDisplay>;

/** The stable identity of the app that owns a window: its bundle id, if any, and its executable path (#1689). */
export const AppIdentity = z.object({ bundleId: z.string().min(1).max(256).nullable(), path: z.string().min(1).max(4096) }).strict();
export type AppIdentity = z.infer<typeof AppIdentity>;
/** An observation id as the peer mints it (#1689). */
export const ObservationId = z.string().regex(/^o\d+$/).max(32);
/** `role[i]` segments joined by `/`; `i` counts same-role siblings (#1689). */
export const ObservedRef = z.string().regex(/^[^/[\]]*\[\d+\](?:\/[^/[\]]*\[\d+\])*$/).max(256);

/**
 * A window's frame in its display's points; minimized windows report zero
 * extents. A contract-3 client adds the owning `pid` (an observation
 * target's pid) and `app` whenever its platform names them (#1689); both stay
 * optional so contract-2 rows still decode.
 */
export const ScreenWindow = z
  .object({
    windowId: WindowId,
    display: DisplayIndex,
    title: z.string().max(256),
    owner: z.string().max(256),
    pid: z.number().int().min(1).optional(),
    app: AppIdentity.optional(),
    bounds: z
      .object({
        x: z.number().int().min(-COMPUTER_MAX_DIMENSION).max(COMPUTER_MAX_DIMENSION),
        y: z.number().int().min(-COMPUTER_MAX_DIMENSION).max(COMPUTER_MAX_DIMENSION),
        width: Coordinate,
        height: Coordinate,
      })
      .strict(),
  })
  .strict();
export type ScreenWindow = z.infer<typeof ScreenWindow>;

/** `windows: true` adds window enumeration; displays are always listed. */
export const ScreenListRequest = z.object({ windows: z.boolean().optional() }).strict();
export type ScreenListRequest = z.infer<typeof ScreenListRequest>;

/** Past {@link SCREEN_LIST_MAX_WINDOWS} the list is cut and `truncated` is true. */
export const ScreenListResult = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      displays: z.array(ScreenDisplay).min(1).max(SCREEN_LIST_MAX_DISPLAYS),
      windows: z.array(ScreenWindow).max(SCREEN_LIST_MAX_WINDOWS),
      truncated: z.boolean(),
      observedAt: EpochMs,
    })
    .strict(),
  ScreenRefusal,
]);
export type ScreenListResult = z.infer<typeof ScreenListResult>;

/** What a capture or a stream shows: one display (optionally a region of it) or one window. */
const CaptureTarget = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("display"),
      display: DisplayIndex,
      region: z.object({ x: Coordinate, y: Coordinate, width: Extent, height: Extent }).strict().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("window"), windowId: WindowId }).strict(),
]);

/**
 * `maxDimension` caps the longer encoded edge and `maxBytes` the encoded
 * size (default {@link SCREEN_PNG_MAX_BYTES}); the peer downscales and
 * re-encodes to meet both and never truncates. `accessibility` asks for the
 * bounded accessibility tree of a display capture.
 */
export const ScreenCaptureRequest = z
  .object({
    target: CaptureTarget,
    encoding: z.discriminatedUnion("format", [
      z.object({ format: z.literal("png") }).strict(),
      z.object({ format: z.literal("jpeg"), quality: z.number().int().min(1).max(100) }).strict(),
    ]),
    maxDimension: Extent.optional(),
    maxBytes: z.number().int().positive().max(SCREEN_PNG_MAX_BYTES).optional(),
    accessibility: z.boolean().optional(),
  })
  .strict();
export type ScreenCaptureRequest = z.infer<typeof ScreenCaptureRequest>;

/**
 * A captured frame is a typed wire payload, never a file on the host.
 * `width`/`height` are the encoded pixels; `captureId` is the anchor every
 * `machine.input.*` call names, and only the latest one is accepted.
 */
export const ScreenCaptureResult = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      captureId: CaptureId,
      display: DisplayIndex,
      format: z.enum(["png", "jpeg"]),
      data: Base64.min(1).max(SCREEN_CAPTURE_MAX_BASE64),
      width: Extent,
      height: Extent,
      downscaled: z.boolean(),
      observedAt: EpochMs,
      accessibilityTree: BoundedAccessibilityTree.optional(),
      /** A per-window accessibility lookup failed; the frame is unmasked for that window. */
      accessibilityUnavailable: z.boolean().optional(),
    })
    .strict(),
  CaptureRefusal,
]);
export type ScreenCaptureResult = z.infer<typeof ScreenCaptureResult>;

const ClipboardFormat = z.enum(["text", "html", "image"]);
const ClipboardImage = Base64.min(1).max(SCREEN_CAPTURE_MAX_BASE64);
export const ClipboardReadRequest = z.object({
  formats: z.array(ClipboardFormat).min(1).max(3).optional(),
}).strict();
export type ClipboardReadRequest = z.infer<typeof ClipboardReadRequest>;
export const ClipboardReadResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    text: z.string().max(SCREEN_PNG_MAX_BYTES).optional(),
    html: z.string().max(SCREEN_PNG_MAX_BYTES).optional(),
    image: ClipboardImage.optional(),
    changeCount: z.number().int().nonnegative(),
  }).strict(),
  z.object({ status: z.literal("refused"), reason: z.enum(["machine_not_attached", "permission_denied", "clipboard_not_available", "clipboard_not_granted", "private", "clipboard_too_large"]) }).strict(),
]);
export type ClipboardReadResult = z.infer<typeof ClipboardReadResult>;
export const ClipboardWriteRequest = z.union([
  z.object({ text: z.string().max(SCREEN_PNG_MAX_BYTES) }).strict(),
  z.object({ html: z.string().max(SCREEN_PNG_MAX_BYTES) }).strict(),
  z.object({ image: ClipboardImage }).strict(),
]);
export type ClipboardWriteRequest = z.infer<typeof ClipboardWriteRequest>;
export const ClipboardWriteResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    changeCount: z.number().int().nonnegative(),
    previous: z.object({
      changeCount: z.number().int().nonnegative(),
      formats: z.array(z.string().min(1)),
      bytes: z.number().int().nonnegative(),
    }).strict(),
  }).strict(),
  z.object({ status: z.literal("refused"), reason: z.enum(["machine_not_attached", "permission_denied", "clipboard_not_available", "clipboard_too_large"]) }).strict(),
]);
export type ClipboardWriteResult = z.infer<typeof ClipboardWriteResult>;

/**
 * Pointer input `at` either a point of the display `captureId` captured or
 * the center of element `ref` of observation `observationId` (#1689). A
 * stale anchor refuses `stale_capture` (`stale_observation`, `epoch_changed`,
 * `ref_not_found`, `window_not_found` for the element form) and nothing
 * executes; the answer is {@link InputWriteResult}.
 */
const PointerButton = z.enum(["left", "right", "middle"]);
const PointerAt = {
  requestId: InputRequestId,
  delivery: z.enum(["background", "foreground"]).default("background"),
  at: z.union([
    z.object({ captureId: CaptureId, x: Coordinate, y: Coordinate }).strict(),
    z
      .object({
        observationId: ObservationId,
        ref: ObservedRef,
      })
      .strict(),
  ]),
};
const ScrollDelta = z.number().int().min(-INPUT_SCROLL_MAX_DELTA).max(INPUT_SCROLL_MAX_DELTA);
export const InputPointerRequest = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("move"), ...PointerAt }).strict(),
  z
    .object({ kind: z.literal("click"), ...PointerAt, button: PointerButton, count: z.number().int().min(1).max(3) })
    .strict(),
  z
    .object({ kind: z.literal("button"), ...PointerAt, button: PointerButton, state: z.enum(["down", "up"]) })
    .strict(),
  z.object({ kind: z.literal("scroll"), ...PointerAt, deltaX: ScrollDelta, deltaY: ScrollDelta }).strict(),
]);
export type InputPointerRequest = z.input<typeof InputPointerRequest>;

/** `key` uses the peer's key vocabulary; an unknown name refuses `unsupported_action`. */
export const InputKeyRequest = z
  .object({
    requestId: InputRequestId,
    captureId: CaptureId,
    delivery: z.enum(["background", "foreground"]).default("background"),
    target: WindowTarget.optional(),
    key: z.string().min(1).max(64),
    action: z.enum(["press", "down", "up"]),
    modifiers: z
      .object({
        shift: z.boolean().optional(),
        control: z.boolean().optional(),
        alt: z.boolean().optional(),
        meta: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type InputKeyRequest = z.input<typeof InputKeyRequest>;

export const InputTextRequest = z
  .object({
    requestId: InputRequestId,
    captureId: CaptureId,
    text: z.string().min(1).max(INPUT_MAX_TEXT_CHARS),
    delivery: z.enum(["background", "foreground"]).default("background"),
    target: WindowTarget.optional(),
  })
  .strict();
export type InputTextRequest = z.input<typeof InputTextRequest>;

/**
 * Host → peer: start encoding `source` under a bounded frame budget. The
 * peer adapts quality under congestion but never exceeds a bound, and closes
 * the stream itself at `lifetimeMs` (`machine.stream.close` reason `expired`).
 */
export const StreamOpenRequest = z
  .object({
    streamId: StreamId,
    source: CaptureTarget,
    video: z
      .object({
        maxFps: z.number().int().min(1).max(STREAM_MAX_FPS),
        keyframeIntervalMs: z.number().int().min(STREAM_KEYFRAME_MIN_MS).max(STREAM_KEYFRAME_MAX_MS),
        maxBitrateBps: z.number().int().positive().max(STREAM_MAX_BITRATE_BPS),
        /** A video frame needs even sides, so the smallest representable cap is 2. */
        maxDimension: Extent.min(2),
        maxFrameBytes: z.number().int().positive().max(STREAM_FRAME_MAX_BYTES),
      })
      .strict(),
    dataChannel: z.boolean(),
    lifetimeMs: z.number().int().positive().max(STREAM_MAX_LIFETIME_MS),
  })
  .strict();
export type StreamOpenRequest = z.infer<typeof StreamOpenRequest>;

export const StreamOpenResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("opened"), streamId: StreamId, expiresAt: EpochMs }).strict(),
  z
    .object({
      status: z.literal("refused"),
      reason: z.enum([
        "machine_not_attached",
        "stream_not_available",
        "display_not_found",
        "window_not_found",
        "permission_denied",
        "stream_limit",
        "already_open",
        "encoder_failed",
      ]),
      message: RefusalMessage.optional(),
    })
    .strict(),
]);
export type StreamOpenResult = z.infer<typeof StreamOpenResult>;

/**
 * Either direction: one negotiation record of an open stream. `seq` starts at
 * 0 per stream and direction and grows by one; a repeat of the last accepted
 * seq is idempotent, any other gap refuses `invalid_sequence`, and seq
 * {@link STREAM_MAX_SIGNALS} refuses `signal_limit`. `data` relays one
 * data-channel message while the peer connection is not yet carrying it.
 */
export const StreamSignalRequest = z
  .object({
    streamId: StreamId,
    seq: z.number().int().nonnegative().max(STREAM_MAX_SIGNALS - 1),
    signal: z.discriminatedUnion("type", [
      z.object({ type: z.literal("offer"), sdp: z.string().min(1).max(STREAM_SDP_MAX_CHARS) }).strict(),
      z.object({ type: z.literal("answer"), sdp: z.string().min(1).max(STREAM_SDP_MAX_CHARS) }).strict(),
      z
        .object({
          type: z.literal("candidate"),
          candidate: z.string().min(1).max(STREAM_CANDIDATE_MAX_CHARS),
          sdpMid: z.string().min(1).max(64).optional(),
          sdpMLineIndex: z.number().int().nonnegative().max(255).optional(),
        })
        .strict(),
      z.object({ type: z.literal("end_of_candidates") }).strict(),
      z
        .object({
          type: z.literal("data"),
          label: z.string().min(1).max(64),
          data: Base64.min(1).max(STREAM_DATA_MAX_BASE64),
        })
        .strict(),
    ]),
  })
  .strict();
export type StreamSignalRequest = z.infer<typeof StreamSignalRequest>;

/** The accepted branch shared by both per-direction sequenced results. */
const SequenceAccepted = z.object({ status: z.literal("accepted"), seq: z.number().int().nonnegative() }).strict();

export const StreamSignalResult = z.discriminatedUnion("status", [
  SequenceAccepted,
  z
    .object({
      status: z.literal("refused"),
      reason: z.enum([
        "machine_not_attached",
        "stream_not_found",
        "stream_expired",
        "invalid_sequence",
        "signal_limit",
        "invalid_signal",
      ]),
      message: RefusalMessage.optional(),
    })
    .strict(),
]);
export type StreamSignalResult = z.infer<typeof StreamSignalResult>;

/** Either direction: the host closes on request, the peer on expiry or failure. */
export const StreamCloseRequest = z
  .object({ streamId: StreamId, reason: z.enum(["requested", "expired", "failed"]) })
  .strict();
export type StreamCloseRequest = z.infer<typeof StreamCloseRequest>;

export const StreamCloseResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("closed"), streamId: StreamId }).strict(),
  z
    .object({ status: z.literal("refused"), reason: z.enum(["machine_not_attached", "stream_not_found"]) })
    .strict(),
]);
export type StreamCloseResult = z.infer<typeof StreamCloseResult>;

/** Host-minted id of one debugging channel, unique within its attachment. */
const CdpChannelId = z.string().min(1).max(128);

/**
 * Host → peer: open a browser debugging-protocol (CDP) channel. `discover`
 * attaches to an endpoint already listening on the peer; `launch` starts
 * one from the named launch manifest the peer's dialect module owns. The
 * wire never names a browser vendor.
 */
export const CdpOpenRequest = z
  .object({
    channelId: CdpChannelId,
    endpoint: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("discover") }).strict(),
      z
        .object({
          kind: z.literal("launch"),
          manifest: z.string().max(64).regex(/^[a-z][a-z0-9_-]*$/, {
            message: "manifest name must be lowercase alphanumeric with - or _",
          }),
        })
        .strict(),
    ]),
    lifetimeMs: z.number().int().positive().max(CDP_MAX_LIFETIME_MS),
  })
  .strict();
export type CdpOpenRequest = z.infer<typeof CdpOpenRequest>;

export const CdpOpenResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("opened"), channelId: CdpChannelId, expiresAt: EpochMs }).strict(),
  z
    .object({
      status: z.literal("refused"),
      reason: z.enum([
        "machine_not_attached",
        "cdp_not_available",
        "endpoint_not_found",
        "manifest_not_found",
        "launch_failed",
        "channel_limit",
        "already_open",
      ]),
      message: RefusalMessage.optional(),
    })
    .strict(),
]);
export type CdpOpenResult = z.infer<typeof CdpOpenResult>;

/**
 * Either direction: bytes of the channel, opaque to the wire. Chunk
 * boundaries carry no meaning; `seq` follows the stream signal rule (start
 * at 0 per direction, grow by one, repeat of the last is idempotent).
 */
export const CdpChunk = z
  .object({
    channelId: CdpChannelId,
    seq: z.number().int().nonnegative(),
    data: Base64.min(1).max(CDP_CHUNK_MAX_BASE64),
  })
  .strict();
export type CdpChunk = z.infer<typeof CdpChunk>;

export const CdpChunkResult = z.discriminatedUnion("status", [
  SequenceAccepted,
  z
    .object({
      status: z.literal("refused"),
      reason: z.enum(["machine_not_attached", "channel_not_found", "channel_closed", "invalid_sequence"]),
    })
    .strict(),
]);
export type CdpChunkResult = z.infer<typeof CdpChunkResult>;

/** Either direction: the host closes on request, the peer on expiry or endpoint loss. */
export const CdpCloseRequest = z
  .object({ channelId: CdpChannelId, reason: z.enum(["requested", "expired", "endpoint_closed", "failed"]) })
  .strict();
export type CdpCloseRequest = z.infer<typeof CdpCloseRequest>;

export const CdpCloseResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("closed"), channelId: CdpChannelId }).strict(),
  z
    .object({ status: z.literal("refused"), reason: z.enum(["machine_not_attached", "channel_not_found"]) })
    .strict(),
]);
export type CdpCloseResult = z.infer<typeof CdpCloseResult>;
