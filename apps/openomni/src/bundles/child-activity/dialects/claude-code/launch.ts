import type { Launch } from "../pack.js";

export function launch(sessionId: string, hooksConfigPath: string): Launch {
  return {
    argv: ["claude", "--session-id", sessionId, "--settings", hooksConfigPath],
    env: {},
  };
}
