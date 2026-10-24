/** The inbound attachment kind a platform's MIME type names; anything unrecognized is a file. */
export function kindOfMime(mime: string | undefined): "image" | "audio" | "video" | "file" {
  if (mime?.startsWith("image/")) return "image";
  if (mime?.startsWith("audio/")) return "audio";
  return mime?.startsWith("video/") ? "video" : "file";
}
