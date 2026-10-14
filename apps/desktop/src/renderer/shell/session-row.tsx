import { StatusGlyph, Text, TreeRow } from "@openomni/ui";
import type { ComponentProps } from "react";
import { formatRelative } from "../attention/reason";
import type { Session } from "../state/store";
import { sessionGlyphProps } from "./session-glyph";
import { SessionSecondary } from "./session-secondary";

export function SessionRow({
  session,
  now,
  project,
  ...props
}: Omit<ComponentProps<typeof TreeRow>, "secondary" | "trailing"> & {
  readonly session: Session;
  readonly now: number;
  readonly project?: string;
}) {
  return (
    <TreeRow
      {...props}
      leading={<StatusGlyph {...sessionGlyphProps(session.phase)} />}
      secondary={
        <SessionSecondary
          session={session}
          now={now}
          {...(project === undefined ? {} : { project })}
        />
      }
      trailing={
        <Text level="meta" tone="faint">
          <time dateTime={new Date(session.lastActivityAt).toISOString()}>
            {formatRelative(now, session.lastActivityAt)}
          </time>
        </Text>
      }
    />
  );
}
