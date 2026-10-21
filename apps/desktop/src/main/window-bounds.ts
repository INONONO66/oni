import { parseJson } from "@oni/protocol";
import { z } from "zod";

/**
 * The window's last size and place, kept across launches. Parsed HERE at the
 * file boundary: a missing or malformed file is the default window, never a
 * window with `NaN` for a width.
 */

export const WINDOW_MIN = { width: 400, height: 600 } as const;
export const WINDOW_DEFAULT = { width: 1280, height: 800 } as const;

const BoundsSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().min(WINDOW_MIN.width),
  height: z.number().int().min(WINDOW_MIN.height),
});

type WindowBounds = z.infer<typeof BoundsSchema>;

/** Position is optional: with none stored, the OS places the window. */
type WindowPlacement = Partial<Pick<WindowBounds, "x" | "y">> &
  Pick<WindowBounds, "width" | "height">;

export function parseWindowBounds(text: string | null): WindowPlacement {
  return text === null ? WINDOW_DEFAULT : (parseJson(BoundsSchema, text) ?? WINDOW_DEFAULT);
}

export function serializeWindowBounds(bounds: WindowBounds): string {
  return JSON.stringify(BoundsSchema.parse(bounds));
}

/** Debounce persisting a moving window: the last bounds win, 500ms after the last move. */
export const BOUNDS_WRITE_DELAY_MS = 500;
