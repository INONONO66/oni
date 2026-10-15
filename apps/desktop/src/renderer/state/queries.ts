import type { SessionRead } from "@openomni/protocol";
import { GatewayUnavailableError } from "../errors";
import { queryOptions, useQueries, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { GatewayChatTransport } from "../chat/gateway-transport";
import type { LocalSession, Session } from "./store";
import type { GatewayEndpoint } from "../../preload/api";
import { gatewayEndpointSchema } from "../../preload/validation";
import { desktopBridge } from "./desktop-bridge";

/**
 * The renderer's SERVER state: everything a process outside this window
 * answers for, read through TanStack Query so loading, error, and caching are
 * one mechanism instead of one `useEffect` per fact.
 *
 * Every key is minted here. A component that spelled its own key would be a
 * second place for the same fact to be cached under a different name.
 *
 * Local session handles only bind views and drafts. Lifecycle state comes from
 * the app-owned session_read pages keyed by the admitted durable identity.
 */
export const queryKeys = {
  gatewayEndpoint: ["gateway", "endpoint"] as const,
  session: (sessionId: string) => ["gateway", "session", sessionId] as const,
};

/**
 * Reject delayed pages so a sealed terminal cannot become running again, and
 * keep the populated page when a same-epoch refetch at the same head returns
 * an empty continuation: no new actions is not new authority, and replacing
 * the cached slice would erase the authoritative last-activity timestamp.
 * Catalog-derived fork children are the one exception (#1257 r4 H-1): a fork
 * writes no parent action, so the gateway's post-fork refresh arrives as a
 * same-head empty page whose `children` must still land in the cache.
 */
function newerPage(previous: SessionRead.Page | undefined, page: SessionRead.Page): SessionRead.Page {
  if (previous === undefined || page.epoch > previous.epoch) return page;
  if (page.epoch < previous.epoch || page.headRevision < previous.headRevision) return previous;
  if (page.headRevision === previous.headRevision &&
    (page.afterRevision < previous.afterRevision || page.actions.length === 0)) {
    return page.children === undefined ? previous : { ...previous, children: page.children };
  }
  return page;
}

export function sessionReadOptions(client: QueryClient, transport: GatewayChatTransport | null, sessionId: string) {
  return queryOptions({
    queryKey: queryKeys.session(sessionId),
    enabled: transport !== null,
    queryFn: async () => {
      if (transport === null) throw new GatewayUnavailableError("gateway not configured");
      const prior = client.getQueryData<SessionRead.Page>(queryKeys.session(sessionId));
      const page = await transport.readSession(sessionId, prior === undefined ? undefined : {
        revision: prior.actions[prior.actions.length - 1]?.revision ?? prior.afterRevision,
        epoch: prior.epoch,
      });
      return newerPage(client.getQueryData<SessionRead.Page>(queryKeys.session(sessionId)), page);
    },
    retry: false,
  });
}

export function subscribeSessionReads(client: QueryClient, transport: GatewayChatTransport): () => void {
  return transport.subscribeSession((page) => {
    client.setQueryData<SessionRead.Page>(queryKeys.session(page.sessionId), (prior) => newerPage(prior, page));
  });
}

export function sessionReadModel(session: LocalSession, page: SessionRead.Page | undefined): Session {
  const authoritative = page?.sessionId === session.durableSessionId ? page : undefined;
  // Newest boundary anchor; a reverse scan because the desktop lib target predates `findLast`.
  const latestForkAnchor = [...(authoritative?.actions ?? [])]
    .reverse()
    .find((action) => action.forkAnchor !== undefined)?.forkAnchor;
  return {
    ...session,
    phase: authoritative?.phase ?? null,
    phaseSince: authoritative?.phaseSince ?? session.createdAt,
    ...(authoritative?.ancestry?.aside == null ? {} : { forkAside: authoritative.ancestry.aside }),
    ...(authoritative?.ancestry === undefined ? {} : { ancestry: authoritative.ancestry }),
    ...(authoritative?.children === undefined ? {} : { forkChildren: authoritative.children }),
    ...(latestForkAnchor === undefined ? {} : { latestForkAnchor }),
    lastActivityAt: authoritative?.actions[authoritative.actions.length - 1]?.at ?? session.lastActivityAt,
  };
}

export function useSessionReadModels(sessions: readonly LocalSession[], transport: GatewayChatTransport | null) {
  const client = useQueryClient();
  useEffect(() => transport === null ? undefined : subscribeSessionReads(client, transport), [client, transport]);
  const ids = [...new Set(sessions.flatMap((session) => session.durableSessionId === undefined ? [] : [session.durableSessionId]))];
  const reads = useQueries({
    queries: ids.map((id) => sessionReadOptions(client, transport, id)),
  });
  return sessions.map((session) => sessionReadModel(session,
    reads[ids.indexOf(session.durableSessionId ?? "")]?.data));
}

/**
 * Where the gateway is, asked of Electron main over the preload bridge.
 *
 * `null` is a real answer, not a failure: the bridge is absent whenever this
 * bundle runs outside Electron (a test, a plain HTTP preview), and a build
 * with no gateway configured answers the same way. Both leave the composer
 * disabled rather than talking to anything fabricated.
 *
 * A REJECTED invoke — the main process has no handler, an older shell around a
 * newer renderer — is left as the query's error so the surface can print it.
 * Never retried: the answer comes from an environment read once at boot, and
 * the second ask would get the same one.
 */
export function useGatewayEndpoint() {
  return useQuery({
    queryKey: queryKeys.gatewayEndpoint,
    queryFn: fetchGatewayEndpoint,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

export async function fetchGatewayEndpoint(): Promise<GatewayEndpoint | null> {
  const bridge = desktopBridge();
  if (bridge === undefined) return null;
  return gatewayEndpointSchema.parse(await bridge.gateway()) ?? null;
}
