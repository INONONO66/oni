import { Effect } from "effect";
import { createChannelStores } from "@openomni/channels";
import { Core } from "@openomni/agent";
import { configureAuthority } from "../../src/composition/generation-layers";
import { channelRequests, channelStoreSource } from "../../src/gateway";
import { APPROVAL_POLICY } from "../../src/composition/policy";

type AppLedgerPlane = Parameters<typeof channelStoreSource>[0];

/**
 * The required gateway composition ports (#1312): `createResidentGateway` no
 * longer fills in `requests` or `stores`, so tests wire the same real
 * implementations the production composition passes in `src/index.ts`.
 */
export function residentGatewayPorts(plane: AppLedgerPlane, now: () => number) {
  return Effect.gen(function* () {
    const requests = channelRequests(
      yield* Core.createSessionRequests({
        approvalPolicy: APPROVAL_POLICY,
        authorizeConfigure: configureAuthority(yield* Core.GenerationLayers, plane.openKernel),
        openKernel: plane.openKernel,
        listSessions: plane.listSessions,
      }),
    );
    return { requests, stores: createChannelStores(channelStoreSource(plane, now)) };
  });
}
