import { isOriginSurface, OriginMark } from "@openomni/ui";
import { hasActiveState, sessionReason } from "../attention/reason";
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
 * The row's second line: the project when given, then what the session is
 * doing — nothing when it is doing nothing the Owner needs to know about —
 * then the mark of the surface it came in from; a session started here
 * carries no mark. When it last moved is the row's trailing cell, not this line.
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
  const mark = originMark(session.surfaceKey);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {project !== undefined && <span className="max-w-24 truncate">{project}</span>}
      {hasActiveState(session) && (
        <span className="truncate">{sessionReason(session, now)}</span>
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
