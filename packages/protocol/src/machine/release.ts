import { z } from "zod";

/**
 * One packaged client archive (#1696): `bytes` and `sha256` describe the
 * archive file itself; `url` is absolute, or relative to the release record.
 */
export const ReleaseArtifact = z
  .object({
    name: z.string().min(1),
    bytes: z.number().int().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, { message: "sha256 must be 64 lowercase hex chars" }),
    url: z.string().min(1),
  })
  .strict();
export type ReleaseArtifact = z.infer<typeof ReleaseArtifact>;

export const releasePlatforms = ["darwin-universal", "linux-x86_64", "linux-arm64"] as const;
export type ReleasePlatform = (typeof releasePlatforms)[number];

/**
 * The client release a host pins (#1696): one version and contract version,
 * one archive per packaged platform. A local build packages only the
 * platforms it built, so every platform entry is optional.
 */
export const Release = z
  .object({
    version: z.string().min(1),
    contractVersion: z.number().int().min(1),
    artifacts: z
      .object({
        "darwin-universal": ReleaseArtifact.optional(),
        "linux-x86_64": ReleaseArtifact.optional(),
        "linux-arm64": ReleaseArtifact.optional(),
      })
      .strict(),
  })
  .strict();
export type Release = z.infer<typeof Release>;

/** Answer to `machine.release`, which the host serves before any attach. */
export const ReleaseResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("available"), release: Release }).strict(),
  z.object({ status: z.literal("refused"), reason: z.literal("release_unavailable") }).strict(),
]);
export type ReleaseResult = z.infer<typeof ReleaseResult>;
