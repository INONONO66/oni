import { z } from "zod";
import { AttachmentRefused } from "../errors";
import type { AttachmentBounds } from "../types";
import { ThrownError } from "./thrown";

export async function attachmentDownload<T>(
  bounds: AttachmentBounds,
  download: () => Promise<T>,
): Promise<T> {
  const Failure = z.union([
    z
      .object({ code: z.enum(["too_large", "aborted"]) })
      .transform(({ code }) => new AttachmentRefused({ reason: code, maxBytes: bounds.maxBytes })),
    ThrownError,
  ]);
  const outcome = await Promise.resolve().then(download).then((value) => ({ value }), Failure.parse);
  if (outcome instanceof Error) throw outcome;
  return outcome.value;
}
