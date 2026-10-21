import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Machine } from "@oni/protocol";
import { Effect } from "effect";
import { z } from "zod";
import type { CommandResult, CommandRunner } from "./commands";
import type { MachineError } from "./errors";
import { decodeMachineFailure } from "./failure";

/**
 * macOS computer-use adapter (#1274): bounded `screen.read` captures via
 * `screencapture` + `sips`, accessibility-tree JSON via `osascript` (JXA),
 * and guarded `input.write` actions via `cliclick`. Every shell-out travels
 * through the injected {@link CommandRunner}, so unit tests never touch the
 * real screen or TCC prompts. The adapter owns the attach-time probes, the
 * per-display bounds cache, and the latest-capture registry that makes any
 * other capture id refuse `stale_capture` before executing anything.
 */
const SCREENCAPTURE = "/usr/sbin/screencapture";
const SIPS = "/usr/bin/sips";
const OSASCRIPT = "/usr/bin/osascript";
const WHICH = "/usr/bin/which";
const CLICLICK = "cliclick";

/** Accessibility probe: System Events refuses this without the TCC grant. */
const ACCESSIBILITY_PROBE = 'tell application "System Events" to count processes';
/** JXA so the tree is emitted as JSON without hand-built AppleScript strings. */
const ACCESSIBILITY_TREE_SCRIPT = `(() => {
  const systemEvents = Application("System Events");
  const front = systemEvents.applicationProcesses.whose({ frontmost: true })();
  const tree = front.map((process) => ({
    app: process.name(),
    windows: process.windows().map((window) => ({
      name: window.name(),
      position: window.position(),
      size: window.size(),
    })),
  }));
  return JSON.stringify(tree);
})()`;

/** cliclick 5.1 `kp:` vocabulary; an unknown key refuses before execution. */
const PRESSABLE_KEYS = new Set([
  "arrow-down", "arrow-left", "arrow-right", "arrow-up", "brightness-down", "brightness-up",
  "delete", "end", "enter", "esc", "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10",
  "f11", "f12", "f13", "f14", "f15", "f16", "fwd-delete", "home", "keys-light-down",
  "keys-light-toggle", "keys-light-up", "mute", "num-0", "num-1", "num-2", "num-3", "num-4",
  "num-5", "num-6", "num-7", "num-8", "num-9", "num-clear", "num-divide", "num-enter",
  "num-equals", "num-minus", "num-multiply", "num-plus", "page-down", "page-up", "play-next",
  "play-pause", "play-previous", "return", "space", "tab", "volume-down", "volume-up",
]);

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Downscale passes are bounded so a pathological encoder can never loop forever. */
const DOWNSCALE_MAX_PASSES = 6;
/** Shrink slightly past the square-root estimate so one pass usually fits. */
const DOWNSCALE_HEADROOM = 0.9;
const POINTS_PER_INCH = 72;
/** Attach runs the probes; a hung probe binary must never stall daemon attach. */
const PROBE_TIMEOUT_MS = 10_000;

type ScreenRefusal = Extract<Machine.ScreenReadResult, { status: "refused" }>["reason"];
type InputRefusal = Extract<Machine.InputWriteResult, { status: "refused" }>["reason"];

/** One display's measured geometry: points for validation, pixels for sips. */
interface DisplayBounds {
  readonly pointWidth: number;
  readonly pointHeight: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
}
interface PixelSize {
  readonly width: number;
  readonly height: number;
}

const AccessibilityTree = z.json();

const refusedScreen = (reason: ScreenRefusal): Machine.ScreenReadResult => ({ status: "refused", reason });
const refusedInput = (reason: InputRefusal): Machine.InputWriteResult => ({ status: "refused", reason });

function hasPngMagic(bytes: Buffer): boolean {
  return bytes.length > PNG_MAGIC.length && bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);
}

/** `sips -g` output, e.g. "  pixelWidth: 3456"; dpi falls back to 1x (72). */
function parseBounds(stdout: string): DisplayBounds | undefined {
  const dimension = (key: string) => {
    const match = stdout.match(new RegExp(`${key}:\\s*([0-9.]+)`));
    return match?.[1] === undefined ? undefined : Number(match[1]);
  };
  const pixelWidth = dimension("pixelWidth");
  const pixelHeight = dimension("pixelHeight");
  if (!pixelWidth || !pixelHeight) return undefined;
  const dpi = dimension("dpiWidth");
  const scale = dpi !== undefined && dpi > 0 ? dpi / POINTS_PER_INCH : 1;
  return {
    pixelWidth,
    pixelHeight,
    pointWidth: Math.round(pixelWidth / scale),
    pointHeight: Math.round(pixelHeight / scale),
  };
}

function regionInside(region: Machine.ScreenRegion, bounds: DisplayBounds): boolean {
  return (
    region.x + region.width <= bounds.pointWidth && region.y + region.height <= bounds.pointHeight
  );
}

function pointInside(x: number, y: number, bounds: DisplayBounds): boolean {
  return x < bounds.pointWidth && y < bounds.pointHeight;
}

type MappedAction = { readonly command: string } | { readonly refusal: InputRefusal };
type MappedActions = { readonly commands: string[] } | { readonly refusal: InputRefusal };

function mapClick(
  click: { x: number; y: number; button?: "left" | "right" | "middle" },
  bounds: DisplayBounds,
): MappedAction {
  if (click.button === "middle") return { refusal: "unsupported_action" };
  if (!pointInside(click.x, click.y, bounds)) return { refusal: "invalid_region" };
  return { command: `${click.button === "right" ? "rc" : "c"}:${click.x},${click.y}` };
}

/** cliclick 5.1 has no middle-click and no scroll command; both refuse typed. */
function mapAction(action: Machine.InputAction, bounds: DisplayBounds): MappedAction {
  if ("click" in action) return mapClick(action.click, bounds);
  if ("type" in action) return { command: `t:${action.type.text}` };
  if ("key" in action) {
    return PRESSABLE_KEYS.has(action.key.name)
      ? { command: `kp:${action.key.name}` }
      : { refusal: "unsupported_action" };
  }
  if ("move" in action) {
    return pointInside(action.move.x, action.move.y, bounds)
      ? { command: `m:${action.move.x},${action.move.y}` }
      : { refusal: "invalid_region" };
  }
  return { refusal: "unsupported_action" };
}

/** The whole list maps before anything executes, so a refusal runs nothing. */
function mapActions(actions: readonly Machine.InputAction[], bounds: DisplayBounds): MappedActions {
  const commands: string[] = [];
  for (const action of actions) {
    const mapped = mapAction(action, bounds);
    if ("refusal" in mapped) return mapped;
    commands.push(mapped.command);
  }
  return { commands };
}

interface ComputerUseOptions {
  readonly runner: CommandRunner;
  /** Injected entropy (#1245): capture ids and temp-file names. */
  readonly id: () => string;
  readonly tempDir?: string;
  /** Probe deadline override; tests shrink it to prove the bound. */
  readonly probeTimeoutMs?: number;
}

export interface ComputerUse {
  /** Attach-time gate: each computer-use capability is offered only with complete prerequisites. */
  offeredCapabilities(requested: readonly string[]): Effect.Effect<string[], MachineError>;
  screenRead(request: Machine.ScreenReadRequest): Effect.Effect<Machine.ScreenReadResult, MachineError>;
  inputWrite(request: Machine.InputWriteRequest): Effect.Effect<Machine.InputWriteResult, MachineError>;
}

export function createComputerUse(options: ComputerUseOptions): ComputerUse {
  const temp = options.tempDir ?? tmpdir();
  const state = {
    screen: false,
    input: false,
    accessibility: false,
    cliclick: undefined as string | undefined,
    bounds: new Map<number, DisplayBounds>(),
    latest: undefined as { captureId: string; display: number; bounds: DisplayBounds } | undefined,
  };

  /** Raw run: a sips/osascript spawn failure keeps its typed `SpawnFailure`. */
  const run = (argv: readonly [string, ...string[]]) => options.runner.run(argv);
  /**
   * #1312: where a refusal is the right answer, a spawn failure becomes
   * `undefined` HERE and the caller names its own distinct reason — never a
   * blanket swallow that makes a missing binary look like a failed command.
   */
  const spawned = (argv: readonly [string, ...string[]]) =>
    run(argv).pipe(
      Effect.map((result): CommandResult | undefined => result),
      Effect.catchTag("SpawnFailure", () => Effect.succeed(undefined)),
    );
  /** Raw read: an unreadable capture file keeps its typed failure. */
  const readBytes = (path: string) =>
    Effect.try({ try: () => readFileSync(path), catch: decodeMachineFailure("computer.read") });
  /** #1312: callers of this variant answer a read failure with `read_failed`. */
  const readOrUndefined = (path: string) =>
    readBytes(path).pipe(
      Effect.map((bytes): Buffer | undefined => bytes),
      Effect.catch(() => Effect.succeed(undefined)),
    );
  const remove = (path: string) =>
    Effect.try({
      try: () => rmSync(path, { force: true }),
      catch: decodeMachineFailure("computer.cleanup"),
    }).pipe(Effect.orDie);

  const measure = (path: string) =>
    Effect.map(
      run([SIPS, "-g", "pixelWidth", "-g", "pixelHeight", "-g", "dpiWidth", path]),
      (result) => (result.exitCode !== 0 ? undefined : parseBounds(result.stdout)),
    );

  const probeTimeout = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  /** A probe that outlives its deadline reports the fallback refusal instead of hanging. */
  const deadline = <A>(effect: Effect.Effect<A, MachineError>, fallback: A) =>
    effect.pipe(
      Effect.timeoutOption(probeTimeout),
      Effect.map((result) => (result._tag === "None" ? fallback : result.value)),
    );

  /** One full-screen probe capture proves both the binary and the TCC grant. */
  type ScreenProbe =
    | { readonly refusal: "screen_not_available" | "permission_denied" | "read_failed" | "probe_timeout" }
    | { readonly refusal: undefined; readonly bounds: DisplayBounds };
  const probeScreen = deadline<ScreenProbe>(Effect.gen(function* () {
    const path = join(temp, `om-screen-probe-${options.id()}.png`);
    return yield* Effect.gen(function* () {
      const captured = yield* spawned([SCREENCAPTURE, "-x", "-t", "png", path]);
      if (captured === undefined) return { refusal: "screen_not_available" as const };
      if (captured.exitCode !== 0) return { refusal: "permission_denied" as const };
      const bytes = yield* readOrUndefined(path);
      if (bytes === undefined) return { refusal: "read_failed" as const };
      if (!hasPngMagic(bytes)) return { refusal: "permission_denied" as const };
      const bounds = yield* measure(path);
      if (bounds === undefined) return { refusal: "permission_denied" as const };
      return { refusal: undefined, bounds };
    }).pipe(Effect.ensuring(remove(path)));
  }), { refusal: "probe_timeout" as const });

  const probeAccessibility = deadline(
    Effect.map(
      spawned([OSASCRIPT, "-e", ACCESSIBILITY_PROBE]),
      (result) => result !== undefined && result.exitCode === 0,
    ),
    false,
  );

  type InputProbe =
    | { readonly refusal: "input_not_available" | "permission_denied" | "probe_timeout" }
    | { readonly refusal: undefined; readonly cliclick: string };
  const probeInput = deadline<InputProbe>(Effect.gen(function* () {
    const located = yield* spawned([WHICH, CLICLICK]);
    if (located === undefined || located.exitCode !== 0 || located.stdout.trim() === "") {
      return { refusal: "input_not_available" as const };
    }
    if (!(yield* probeAccessibility)) return { refusal: "permission_denied" as const };
    return { refusal: undefined, cliclick: located.stdout.trim() };
  }), { refusal: "probe_timeout" as const });

  const reprobeScreen = Effect.gen(function* () {
    const probe = yield* probeScreen;
    state.screen = probe.refusal === undefined;
    if (probe.refusal === undefined) state.bounds.set(1, probe.bounds);
  });

  const reprobeInput = Effect.gen(function* () {
    const probe = yield* probeInput;
    state.input = probe.refusal === undefined;
    if (probe.refusal === undefined) state.cliclick = probe.cliclick;
  });

  /** A refused command re-probes, and the capability stays withdrawn while the probe fails. */
  const ensureScreen = Effect.gen(function* () {
    if (state.screen) return undefined;
    const probe = yield* probeScreen;
    if (probe.refusal !== undefined) return probe.refusal;
    state.screen = true;
    state.bounds.set(1, probe.bounds);
    return undefined;
  });

  const ensureInput = Effect.gen(function* () {
    if (state.input) return undefined;
    const probe = yield* probeInput;
    if (probe.refusal !== undefined) return probe.refusal;
    state.input = true;
    state.cliclick = probe.cliclick;
    return undefined;
  });

  const capture = (display: number | undefined, path: string) =>
    Effect.gen(function* () {
      const argv: readonly [string, ...string[]] =
        display === undefined
          ? [SCREENCAPTURE, "-x", "-t", "png", path]
          : [SCREENCAPTURE, "-x", "-t", "png", "-D", String(display), path];
      const result = yield* spawned(argv);
      if (result === undefined) {
        yield* reprobeScreen;
        return "spawn_failed" as const;
      }
      if (result.exitCode !== 0) {
        if (result.stderr.toLowerCase().includes("invalid display")) return "invalid_region" as const;
        yield* reprobeScreen;
        return "permission_denied" as const;
      }
      return undefined;
    });

  const crop = (path: string, region: Machine.ScreenRegion, bounds: DisplayBounds) =>
    Effect.gen(function* () {
      const scale = bounds.pixelWidth / bounds.pointWidth;
      // Offsets and extents round independently, so clamp both to the pixel
      // image: offset + extent must never exceed what the capture contains.
      const offsetX = Math.min(Math.round(region.x * scale), bounds.pixelWidth - 1);
      const offsetY = Math.min(Math.round(region.y * scale), bounds.pixelHeight - 1);
      const pixels: PixelSize = {
        width: Math.max(1, Math.min(Math.round(region.width * scale), bounds.pixelWidth - offsetX)),
        height: Math.max(1, Math.min(Math.round(region.height * scale), bounds.pixelHeight - offsetY)),
      };
      const result = yield* run([
        SIPS,
        "--cropOffset", String(offsetY), String(offsetX),
        "-c", String(pixels.height), String(pixels.width),
        path,
      ]);
      return result.exitCode === 0 ? pixels : undefined;
    });

  const downscaleOnce = (path: string, length: number, longest: number) =>
    Effect.gen(function* () {
      const estimate = Math.floor(
        longest * Math.sqrt(Machine.SCREEN_PNG_MAX_BYTES / length) * DOWNSCALE_HEADROOM,
      );
      const target = Math.min(longest - 1, estimate);
      if (target < 1) return undefined;
      const scaled = yield* run([SIPS, "-Z", String(target), path]);
      if (scaled.exitCode !== 0) return undefined;
      const reread = yield* readBytes(path);
      return { bytes: reread, longest: target };
    });

  /** Over-cap captures are downscaled and re-encoded with sips, never truncated. */
  const fitToCap = (path: string, first: Buffer, size: PixelSize) =>
    Effect.gen(function* () {
      let current = { bytes: first, longest: Math.max(size.width, size.height) };
      for (let pass = 0; pass < DOWNSCALE_MAX_PASSES; pass += 1) {
        if (current.bytes.length <= Machine.SCREEN_PNG_MAX_BYTES) return current.bytes;
        const next = yield* downscaleOnce(path, current.bytes.length, current.longest);
        if (next === undefined) return undefined;
        current = next;
      }
      return current.bytes.length <= Machine.SCREEN_PNG_MAX_BYTES ? current.bytes : undefined;
    });

  /** Absent permission simply omits the tree; it never fails the capture. */
  const accessibilityTree = Effect.gen(function* () {
    if (!state.accessibility) return undefined;
    const result = yield* spawned([OSASCRIPT, "-l", "JavaScript", "-e", ACCESSIBILITY_TREE_SCRIPT]);
    if (result === undefined || result.exitCode !== 0) {
      state.accessibility = false;
      return undefined;
    }
    const text = result.stdout.trim();
    if (text.length === 0 || Buffer.byteLength(text, "utf8") > Machine.SCREEN_AX_MAX_BYTES) return undefined;
    const parsed = yield* Effect.try({
      try: () => AccessibilityTree.parse(JSON.parse(text)),
      catch: decodeMachineFailure("computer.tree"),
    }).pipe(Effect.catch(() => Effect.succeed(undefined)));
    return parsed;
  });

  const finishRead = (request: Machine.ScreenReadRequest, display: number, path: string) =>
    Effect.gen(function* () {
      const bounds = yield* measure(path);
      if (bounds === undefined) return refusedScreen("capture_failed");
      state.bounds.set(display, bounds);
      let size: PixelSize = { width: bounds.pixelWidth, height: bounds.pixelHeight };
      if (request.region !== undefined) {
        if (!regionInside(request.region, bounds)) return refusedScreen("invalid_region");
        const cropped = yield* crop(path, request.region, bounds);
        if (cropped === undefined) return refusedScreen("capture_failed");
        size = cropped;
      }
      const bytes = yield* readOrUndefined(path);
      if (bytes === undefined) return refusedScreen("read_failed");
      const fitted = yield* fitToCap(path, bytes, size);
      if (fitted === undefined) return refusedScreen("capture_failed");
      const tree = yield* accessibilityTree;
      const captureId = options.id();
      state.latest = { captureId, display, bounds };
      return yield* Effect.try({
        try: () =>
          Machine.ScreenReadResult.parse({
            status: "ok",
            captureId,
            png: fitted.toString("base64"),
            ...(tree === undefined ? {} : { accessibilityTree: tree }),
          }),
        catch: decodeMachineFailure("computer.screen"),
      });
    });

  function screenRead(request: Machine.ScreenReadRequest): Effect.Effect<Machine.ScreenReadResult, MachineError> {
    return Effect.gen(function* () {
      const unavailable = yield* ensureScreen;
      if (unavailable !== undefined) return refusedScreen(unavailable);
      const display = request.display ?? 1;
      const cached = state.bounds.get(display);
      // Known bounds refuse an out-of-display region BEFORE any command runs.
      if (request.region !== undefined && cached !== undefined && !regionInside(request.region, cached)) {
        return refusedScreen("invalid_region");
      }
      const path = join(temp, `om-screen-${options.id()}.png`);
      return yield* Effect.gen(function* () {
        const refusal = yield* capture(request.display, path);
        if (refusal !== undefined) return refusedScreen(refusal);
        return yield* finishRead(request, display, path);
      }).pipe(Effect.ensuring(remove(path)));
    });
  }

  const performInput = (cliclick: string, commands: readonly string[]) =>
    Effect.gen(function* () {
      const result = yield* spawned([cliclick, ...commands]);
      if (result === undefined) {
        yield* reprobeInput;
        return refusedInput("spawn_failed");
      }
      if (result.exitCode !== 0) {
        // Only a FAILED run maps stderr: a zero-exit run already executed, and
        // reporting it permission_denied would be a refusal that lies.
        if (/accessibility|assistive access/i.test(result.stderr)) {
          yield* reprobeInput;
          return refusedInput("permission_denied");
        }
        return refusedInput("input_failed");
      }
      return { status: "ok" } as const;
    });

  function inputWrite(request: Machine.InputWriteRequest): Effect.Effect<Machine.InputWriteResult, MachineError> {
    return Effect.gen(function* () {
      const unavailable = yield* ensureInput;
      if (unavailable !== undefined) return refusedInput(unavailable);
      const latest = state.latest;
      // The latest successful capture is the only valid anchor; everything else
      // refuses before ANY action executes — a request never partially runs.
      if (latest === undefined || latest.captureId !== request.captureId) {
        return refusedInput("stale_capture");
      }
      // cliclick takes GLOBAL (main-display-origin) coordinates; a capture of
      // any other display would silently mistarget, so v1 refuses it typed.
      if (latest.display !== 1) {
        return {
          status: "refused",
          reason: "unsupported_action",
          message: `input execution is main-display only in v1; the anchoring capture is of display ${latest.display}`,
        } as const;
      }
      const mapped = mapActions(request.actions, latest.bounds);
      if ("refusal" in mapped) return refusedInput(mapped.refusal);
      const cliclick = state.cliclick;
      if (cliclick === undefined) return refusedInput("input_not_available");
      return yield* performInput(cliclick, mapped.commands);
    });
  }

  const probeCapability = (capability: string) =>
    Effect.gen(function* () {
      if (capability === Machine.WellKnownCapability.screenRead) {
        yield* reprobeScreen;
        state.accessibility = yield* probeAccessibility;
        return state.screen;
      }
      if (capability === Machine.WellKnownCapability.inputWrite) {
        yield* reprobeInput;
        state.accessibility = state.input || (yield* probeAccessibility);
        return state.input;
      }
      return true;
    });

  function offeredCapabilities(requested: readonly string[]): Effect.Effect<string[], MachineError> {
    return Effect.gen(function* () {
      const offered: string[] = [];
      for (const capability of requested) {
        if (yield* probeCapability(capability)) offered.push(capability);
      }
      return offered;
    });
  }

  return { offeredCapabilities, screenRead, inputWrite };
}
