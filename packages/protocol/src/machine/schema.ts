import { z } from "zod";
import { EpochMs } from "../time.js";
import { PlainValueSchema } from "../json.js";
import { sha256Hex } from "../sha256.js";

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
      reason: z.enum(["machine_not_attached", "machine_mismatch"]),
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
/** Machine host → machine daemon: the output a live cell has produced so far. */
export const PeekCode = z.object({ cellId: z.string().min(1) }).strict();
export const PeekResult = z.object({ running: z.boolean(), output: CellOutput }).strict();
/**
 * `machine.peek_code` refusal when the daemon has no code runner at all
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
      ]),
      /** Human-readable detail, e.g. which display a refused anchor captured. */
      message: z.string().min(1).max(256).optional(),
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
