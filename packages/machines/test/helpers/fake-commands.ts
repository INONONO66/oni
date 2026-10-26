import { writeFileSync } from "node:fs";
import { Effect } from "effect";
import type { CommandResult, CommandRunner } from "../../src/commands";
import { SpawnFailure } from "../../src/errors";

export const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A syntactically valid-enough PNG: real magic bytes plus filler payload. */
function png(size: number): Buffer {
  return Buffer.concat([PNG_MAGIC, Buffer.alloc(Math.max(0, size - PNG_MAGIC.length), 1)]);
}

/** `sips -g` stdout for a display measured at the given pixel size and dpi. */
function sipsBounds(pixelWidth: number, pixelHeight: number, dpiWidth: number): string {
  return `/tmp/x.png\n  pixelWidth: ${pixelWidth}\n  pixelHeight: ${pixelHeight}\n  dpiWidth: ${dpiWidth.toFixed(3)}\n`;
}

export interface FakeMacBehavior {
  captureExitCode: number;
  captureStderr: string;
  /** When true the screencapture binary itself spawn-fails (vanished). */
  captureMissing: boolean;
  /** When true the capture exits 0 but never writes its file (unreadable). */
  captureFileMissing: boolean;
  capturePng: Buffer;
  /** `which cliclick` answer; undefined reports "not installed". */
  cliclickPath: string | undefined;
  /** When true the resolved cliclick binary spawn-fails (binary disappeared). */
  cliclickMissing: boolean;
  cliclickExitCode: number;
  cliclickStderr: string;
  accessibilityExitCode: number;
  treeExitCode: number;
  treeStdout: string;
  /** Keyed by the display index of the LAST capture; display 1 is the main display. */
  boundsByDisplay: Record<number, string>;
  /** What `sips -Z` re-encodes; undefined keeps re-writing the original capture. */
  scaledPng: Buffer | undefined;
  croppedPng: Buffer | undefined;
  sipsExitCode: number;
}

export interface FakeMac {
  readonly calls: string[][];
  readonly behavior: FakeMacBehavior;
  readonly runner: CommandRunner;
  /** Recorded argv lists for one binary, matched on the executable basename. */
  invocations(binary: string): string[][];
}

const completed = (partial: Partial<CommandResult>): Effect.Effect<CommandResult, SpawnFailure> =>
  Effect.succeed({ exitCode: 0, stdout: "", stderr: "", ...partial });

/** A fake macOS shell surface: records argv, writes capture files, never spawns. */
export function fakeMac(overrides: Partial<FakeMacBehavior> = {}): FakeMac {
  const behavior: FakeMacBehavior = {
    captureExitCode: 0,
    captureStderr: "",
    captureMissing: false,
    captureFileMissing: false,
    capturePng: png(4096),
    cliclickPath: "/opt/homebrew/bin/cliclick",
    cliclickMissing: false,
    cliclickExitCode: 0,
    cliclickStderr: "",
    accessibilityExitCode: 0,
    treeExitCode: 0,
    treeStdout: JSON.stringify([{ app: "TextEdit", windows: [] }]),
    boundsByDisplay: {
      1: sipsBounds(2000, 1000, 144),
      2: sipsBounds(800, 600, 72),
    },
    scaledPng: undefined,
    croppedPng: undefined,
    sipsExitCode: 0,
    ...overrides,
  };
  const calls: string[][] = [];
  let lastDisplay = 1;
  function serveCapture(argv: readonly string[]): Effect.Effect<CommandResult, SpawnFailure> {
    if (behavior.captureMissing) {
      return Effect.fail(new SpawnFailure({ operation: "command.spawn", message: "ENOENT", cause: "ENOENT" }));
    }
    const flag = argv.indexOf("-D");
    lastDisplay = flag === -1 ? 1 : Number(argv[flag + 1]);
    const path = argv[argv.length - 1];
    if (behavior.captureExitCode === 0 && !behavior.captureFileMissing && path !== undefined) writeFileSync(path, behavior.capturePng);
    return completed({ exitCode: behavior.captureExitCode, stderr: behavior.captureStderr });
  }
  function serveSips(argv: readonly string[]): Effect.Effect<CommandResult, SpawnFailure> {
    const path = argv[argv.length - 1];
    if (argv[1] === "-g") {
      return completed({
        exitCode: behavior.sipsExitCode,
        stdout: behavior.boundsByDisplay[lastDisplay] ?? "",
      });
    }
    if (behavior.sipsExitCode === 0 && path !== undefined) {
      writeFileSync(path, (argv[1] === "-Z" ? behavior.scaledPng : behavior.croppedPng) ?? behavior.capturePng);
    }
    return completed({ exitCode: behavior.sipsExitCode });
  }
  function serveOsascript(argv: readonly string[]): Effect.Effect<CommandResult, SpawnFailure> {
    if (argv[1] === "-l") return completed({ exitCode: behavior.treeExitCode, stdout: behavior.treeStdout });
    return completed({ exitCode: behavior.accessibilityExitCode });
  }
  function serveCliclick(): Effect.Effect<CommandResult, SpawnFailure> {
    if (behavior.cliclickMissing) {
      return Effect.fail(new SpawnFailure({ operation: "command.spawn", message: "ENOENT", cause: "ENOENT" }));
    }
    return completed({ exitCode: behavior.cliclickExitCode, stderr: behavior.cliclickStderr });
  }
  const runner: CommandRunner = {
    run: (argv) =>
      Effect.suspend(() => {
        calls.push([...argv]);
        const binary = argv[0];
        if (binary.endsWith("/which")) {
          return behavior.cliclickPath === undefined
            ? completed({ exitCode: 1 })
            : completed({ stdout: `${behavior.cliclickPath}\n` });
        }
        if (binary.endsWith("/screencapture")) return serveCapture(argv);
        if (binary.endsWith("/sips")) return serveSips(argv);
        if (binary.endsWith("/osascript")) return serveOsascript(argv);
        if (binary.endsWith("/cliclick")) return serveCliclick();
        return completed({ exitCode: 127, stderr: `unexpected binary: ${binary}` });
      }),
  };
  return {
    calls,
    behavior,
    runner,
    invocations: (binary) => calls.filter((argv) => argv[0]?.endsWith(`/${binary}`)),
  };
}
