import { z } from "zod";
import { AttachmentRefused } from "../errors";
import type { AttachmentBounds } from "../types";

const Refusal = z.object({ code: z.enum(["too_large", "aborted"]) });

export async function attachmentDownload<T>(
  bounds: AttachmentBounds,
  download: () => Promise<T>,
): Promise<T> {
  try {
    return await download();
  } catch (error) {
    const refusal = Refusal.safeParse(error);
    if (refusal.success)
      throw new AttachmentRefused({ reason: refusal.data.code, maxBytes: bounds.maxBytes });
    throw error;
  }
}
