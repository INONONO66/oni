import { Core } from "@openomni/agent";
import { Provisioning } from "@openomni/protocol";
import { Effect } from "effect";
import { channelDomainRevisions, executeChannelDeclare, type ProvisionPort } from "../bundles/provision/channels";

const ToolRefused = Core.ToolRefused;

function refused(
  request: Provisioning.ChannelDeclareRequest,
  reason: Provisioning.ChannelDeclareRefused["reason"],
  detail: string,
): Provisioning.ChannelDeclareResponse {
  return { type: "channel_add_refused", requestId: request.requestId, reason, detail };
}

/**
 * The Owner's channel declaration over the ws wire (#1569 lane 5b): the
 * same `channel_add` the provision tool runs, with the Owner as the caller,
 * so an Owner instance's consent is given by the call itself — the
 * declaration is bound to the instance revision the Owner saw, exactly as
 * an approved tool invocation is. Any other socket is refused: the
 * Resident's path stays the tool, under the gate.
 */
export function channelWire(port: ProvisionPort | undefined, now: () => number) {
  return (
    request: Provisioning.ChannelDeclareRequest,
    caller: "owner" | `session:${string}`,
  ): Effect.Effect<Provisioning.ChannelDeclareResponse> =>
    Effect.promise(async () => {
      if (caller !== "owner") return refused(request, "owner_only", "only the Owner's socket declares a channel");
      if (port === undefined) return refused(request, "store_unconfigured", "provisioning is not composed");
      const { type: _type, requestId, enabled, ...declaration } = request;
      try {
        const declared = await executeChannelDeclare(port, now)(
          { ...declaration, enabled: enabled ?? true },
          channelDomainRevisions(port.instances, request.id),
          "owner",
        );
        return Provisioning.ChannelDeclareResponse.parse({
          type: "channel_declared",
          requestId,
          id: declared.id,
          statuses: declared.statuses.map((status) => ({
            id: status.id,
            surface: status.surface,
            state: status.state,
            ...(status.detail === undefined ? {} : { detail: status.detail }),
          })),
        });
      } catch (error) {
        if (error instanceof ToolRefused) return refused(request, "refused", error.message);
        return refused(request, "refused", error instanceof Error ? error.message : String(error));
      }
    });
}
