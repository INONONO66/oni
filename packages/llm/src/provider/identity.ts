import { arch, platform, release } from "node:os";

/**
 * A constant, not a package.json read: `src/` and `dist/` resolve a relative manifest path
 * differently. The identity test pins it against the manifest.
 */
const VERSION = "0.1.0";

/** `pi/<version> (<platform> <kernelRelease>; <arch>)`: the one owner of every SDK `user-agent`. */
export function clientIdentity(): string {
  return `pi/${VERSION} (${platform()} ${release()}; ${arch()})`;
}

/** The reported version, exposed so the manifest-sync gate can pin it. */
clientIdentity.version = VERSION;
