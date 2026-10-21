import type { LiveConfigInput } from "../pack.js";

/**
 * The hook events the pack decodes as observations (`live.ts`), wired to the
 * installed hook command. `PermissionRequest` is deliberately absent: a
 * logging-only PermissionRequest hook is an immediate denial on a headless
 * child (verify-claude-permissionrequest-headless.md), and permission control
 * is not part of this increment.
 */
const WIRED_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"] as const;

export function liveConfig(input: LiveConfigInput): string {
  const hooks = Object.fromEntries(
    WIRED_EVENTS.map((event) => [
      event,
      [{ hooks: [{ type: "command", command: `${input.hookCommand} ${event}` }] }],
    ]),
  );
  return `${JSON.stringify({ hooks }, null, 2)}\n`;
}
