/**
 * `tool` (capability) — one tool execution: admitted intent and terminal
 * effect. Single writer: the tool capability executor
 * (`packages/agent/src/core/loop/executor.ts` tool dispatch).
 */
import { RowBody, declare } from "../declaration.js";

export const tool = declare("tool", RowBody);
