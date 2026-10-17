import { Effect } from "effect";
import type { CommandRunner } from "../../src/commands";
import type { PtyControl, PtyControlFactory } from "../../src/pty-control";

/**
 * Scripted tmux control server shared by the adapter fault suites and the
 * daemon-level pty tests: no tmux binary, no sockets. `facts` answers
 * `display-message` (the #1510 pane facts); every issued command line is
 * recorded in `lines`; `faults` exposes the adapter's control hooks so a test
 * can inject malformed records or a server exit.
 */
export function scriptedTmux(facts: readonly string[] = []) {
  const names: string[] = [];
  const lines: string[] = [];
  let hooks: Parameters<PtyControlFactory>[0] | undefined;
  const server: PtyControl = {
    command: (line) =>
      Effect.sync(() => {
        lines.push(line);
        if (line.startsWith("list-sessions")) return [...names];
        if (line.startsWith("new-session")) {
          names.push(line.split(" ")[3] ?? "");
          return [];
        }
        if (line.startsWith("list-panes")) return ["@9 %9"];
        if (line.startsWith("capture-pane")) return ["snapshot"];
        if (line.startsWith("display-message")) return [...facts];
        if (line.startsWith("kill-session")) {
          names.length = 0;
          return [];
        }
        return [];
      }),
    close: () => Effect.void,
  };
  const control: PtyControlFactory = (options) => {
    hooks = options;
    return Effect.succeed(server);
  };
  /** Answers the attach-time `tmux -V` probe without a tmux binary. */
  const runner: CommandRunner = { run: () => Effect.succeed({ exitCode: 0, stdout: "tmux 3.7c", stderr: "" }) };
  const faults = () => {
    if (hooks === undefined) throw new Error("control client never started");
    return hooks;
  };
  return { control, runner, lines, faults };
}
