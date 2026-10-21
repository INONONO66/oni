import type { Launch, LaunchInput } from "../pack.js";

export function launch(input: LaunchInput): Launch {
  return {
    argv: [
      "claude",
      "--session-id",
      input.sessionId,
      ...(input.liveConfigPath === undefined ? [] : ["--settings", input.liveConfigPath]),
    ],
    env: {},
  };
}
