import { RenderLimitExceeded } from "../errors.js";

/** Platform field limits are checked while planning, before any physical send. */
export function bounded(text: string, kind: RenderLimitExceeded["kind"], limit: number): string {
  if (text.length < 1 || text.length > limit)
    throw new RenderLimitExceeded({ kind, count: text.length, limit });
  return text;
}
