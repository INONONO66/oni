import { z } from "zod";
import type { Located } from "../pack.js";

/** The one live event whose payload names the transcript file the session appends to. */
const SESSION_START = "SessionStart";
const StartLine = z.object({
  event: z.literal(SESSION_START),
  payload: z.object({ hook_event_name: z.literal(SESSION_START), transcript_path: z.string().min(1) }),
});

/** A spool line that is not a well-formed SessionStart locates nothing; the decoder owns malformed refusals. */
export function locate(line: string): Located {
  let start: ReturnType<typeof StartLine.safeParse>;
  try {
    start = StartLine.safeParse(JSON.parse(line));
  } catch (error) {
    if (error instanceof SyntaxError) return {};
    throw error;
  }
  return start.success ? { transcriptPath: start.data.payload.transcript_path } : {};
}
