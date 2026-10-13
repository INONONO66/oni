import { runEffect } from "./effect";
import type { startOpenOmni } from "../../src/index";

type RunningApp = Awaited<ReturnType<typeof startOpenOmni>>;

/** The owner's opening DM on the ws surface: the ingress event every resident boot starts from. */
export function ownerStart(app: Pick<RunningApp, "gateway">, eventId: string) {
  return runEffect(app.gateway.ingest(
    { kind: "external", surface: "ws", externalId: "owner" },
    {
      eventId,
      surface: "ws",
      channelId: "owner",
      addressees: [],
      dm: true,
      payload: {},
      render: "start",
    },
  ));
}
