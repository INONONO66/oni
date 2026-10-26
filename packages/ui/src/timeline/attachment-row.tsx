import { Paperclip } from "lucide-react";
import { UI_NAMES } from "../names";
import type { TranscriptAttachment } from "./model";
import { Voice } from "./voice";

export function AttachmentRow({ attachment }: { readonly attachment: TranscriptAttachment }) {
  return (
    <div
      className="inline-flex max-w-full items-start gap-2 rounded-md border border-line px-2 py-1"
      data-ui={UI_NAMES.AttachmentRow}
      title={attachment.ref}
    >
      <Paperclip aria-hidden className="mt-0.5 size-3 shrink-0 text-fg-muted" />
      <div className="min-w-0">
        <Voice as="div" className="break-all text-fg" voice="meta">
          {attachment.name}
        </Voice>
        <Voice as="div" className="break-all" voice="meta">
          {attachment.mediaType}
        </Voice>
      </div>
    </div>
  );
}
