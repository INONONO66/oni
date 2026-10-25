import { posix } from "node:path";

/**
 * ONE canonical export-root spelling (#1312): normalized, no trailing slash,
 * with the filesystem root staying "/". Host routing and daemon execution
 * both normalize through here, so the two sides can never disagree about a
 * double slash or a trailing slash on the same configured export.
 */
export function normalizeExportRoot(path: string): string {
  // `posix.normalize` leaves at most one trailing slash, so one slice drops it
  // in linear time where a `/\/+$/` replace backtracks on long slash runs.
  const normalized = posix.normalize(path);
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

/**
 * ONE containment predicate shared by host routing and daemon execution: a
 * normalized absolute candidate is inside `root` when it IS the root or a
 * strict descendant of it.
 */
export function isContained(root: string, candidate: string): boolean {
  const canonical = normalizeExportRoot(root);
  return candidate === canonical || candidate.startsWith(canonical === "/" ? "/" : `${canonical}/`);
}
