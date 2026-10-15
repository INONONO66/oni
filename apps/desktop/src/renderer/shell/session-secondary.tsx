import { isOriginSurface, OriginMark } from "@openomni/ui";
import { formatRelative, hasActiveState, sessionReason } from "../attention/reason";
import type { Session } from "../state/store";

/**
 * The brand mark for the surface a session's key names, if it is one we draw.
 * The key's grammar is `<surface>:<surface-specific-path>`, owned by
 * `Channel.SurfaceKey` in `packages/protocol/src/channel/index.ts`; only the
 * prefix is read here because the protocol barrel is not loadable in the
 * renderer (it reaches `node:crypto` at module load).
 */
function originMark(surfaceKey: string | undefined) {
  if (surfaceKey === undefined) return null;
  const surface = surfaceKey.slice(0, surfaceKey.indexOf(":"));
  return isOriginSurface(surface) ? <OriginMark surface={surface} /> : null;
}

/**
 * The row's second line: what the session is doing, or — when it is doing
 * nothing the Owner needs to know about — when it last moved. Then the mark
 * of the surface it came in from; a session started here carries no mark.
 */
export function SessionSecondary({
  session,
  now,
  project,
}: {
  readonly session: Session;
  readonly now: number;
  readonly project?: string;
}) {
  const timestamp = session.lastActivityAt;
  const mark = originMark(session.surfaceKey);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {project !== undefined && <span className="max-w-24 truncate">{project}</span>}
      {hasActiveState(session) ? (
        <span className="truncate">{sessionReason(session, now)}</span>
      ) : (
        <time className="truncate" dateTime={new Date(timestamp).toISOString()}>
          {formatRelative(now, timestamp)}
        </time>
      )}
      {mark !== null && (
        <>
          <span aria-hidden="true">·</span>
          {mark}
        </>
      )}
    </span>
  );
}
