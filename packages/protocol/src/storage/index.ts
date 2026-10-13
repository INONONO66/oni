// Type-only storage contract vocabulary: the sub-adapter surfaces a ledger
// adapter implements, grouped by semantic domain.
import type { Actor } from "../actor/index.js";
import type { DecisionFact } from "../ledger/index.js";
import type { Gateway } from "../gateway/index.js";
import type { Provisioning } from "../provisioning/index.js";
import type { LedgerAction, LedgerSession, PolicyRow } from "../ledger/l0.js";

export namespace Storage {
  export interface ActionSubAdapter {
    append(input: LedgerAction.Append, expectedRevision: number): LedgerAction.Receipt | undefined;
    actionById(id: string): LedgerAction.Node | undefined;
    latestAction(sessionId: string, throughRevision: number): LedgerAction.Node | undefined;
    latestFoldCheckpoint(sessionId: string, throughRevision: number): LedgerAction.Node | undefined;
    /** Payload bytes (intent + effect + revert JSON) of the rows after `afterRevision` through `throughRevision`. */
    payloadBytes(sessionId: string, afterRevision: number, throughRevision: number): number;
    priorModelAttempt(sessionId: string, turnId: string): LedgerAction.Node | undefined;
    generationFor(sessionId: string, generation: number): LedgerAction.Node | undefined;
    turnTerminalFor(sessionId: string, turnId: string): LedgerAction.Node | undefined;
    latestTurnTerminal(sessionId: string): LedgerAction.Node | undefined;
    latestTurnUpdate(sessionId: string, turnId: string): LedgerAction.Node | undefined;
    turnIntentsPage(sessionId: string, beforeRevision: number, limit: number): LedgerAction.Node[];
    /** Ordinal of the turn intent preceding the newest `count` intents before `beforeRevision`, else 0. */
    turnWindowStart(sessionId: string, beforeRevision: number, count: number): number;
    /** `turn` and delivery (`prompt`/`signal`/`action`) actions after `cursor`, ascending: one window feeds every tail. */
    turnTailPage(sessionId: string, cursor: number, limit: number): LedgerAction.Node[];
    openTurnsPage(sessionId: string, cursor: number, limit: number): LedgerAction.Node[];
    resultFor(sessionId: string, parentId: string): LedgerAction.Node | undefined;
    requestInputById(sessionId: string, inputId: string): LedgerAction.Node | undefined;
    requestStateById(requestId: string): LedgerAction.Node | undefined;
    requestStatesPage(
      sessionId: string | undefined,
      cursor: string,
      limit: number,
    ): LedgerAction.Node[];
    outboundStatesPage(sessionId: string, cursor: string, limit: number): LedgerAction.Node[];
    guardedOperationsPage(
      sessionId: string,
      turnId: string,
      cursor: number,
      limit: number,
    ): LedgerAction.Node[];
    openOperationsPage(
      sessionId: string,
      turnId: string,
      cursor: number,
      limit: number,
    ): LedgerAction.Node[];
    operationChildrenPage(
      sessionId: string,
      parentId: string,
      cursor: number,
      limit: number,
    ): LedgerAction.Node[];
    configurationActions(sessionId: string, beforeRevision: number): LedgerAction.Node[];
    policyDecisionRuleIds(sessionId: string, inputHash: string): string[] | undefined;
    messageActionByPlatformId(sessionId: string, messageId: string): LedgerAction.Node | undefined;
    outboundReceipt(
      destinationSessionId: string,
      messageId: string,
    ): LedgerAction.Receipt | undefined;
    verifyChain(sessionId: string): LedgerAction.ChainVerdict;
    /** Revision-ordered actions with `ordinal > afterRevision`, at most `limit` of them. */
    range(sessionId: string, afterRevision: number, limit: number): LedgerAction.Node[];
    /**
     * Chain-fold pending projection (W5.2): `prompt`/`signal` actions with an
     * delivered-input payload that no later delivery row references, in chain order.
     */
    pendingMessages(sessionId: string): LedgerAction.Node[];
    /** The latest EXECUTED `compaction` row — the staleness horizon for deferred `action` inputs (#1256 H-3). */
    latestCompaction(sessionId: string): LedgerAction.Node | undefined;
    /** Every input action (rows carrying a deliveryKind effect), consumed or not (#1257). */
    inputMessages(sessionId: string): LedgerAction.Node[];
  }

  export interface SessionSubAdapter {
    create(row: LedgerSession.Row): boolean;
    materialize(input: LedgerSession.Materialize): LedgerSession.MaterializeResult | undefined;
    get(id: string): LedgerSession.Row | undefined;
    list(): LedgerSession.Row[];
    /** True when the fence advanced (or already sits at exactly this owner+fence). */
    adoptFence(input: LedgerSession.AdoptFence): boolean;
    commit(input: LedgerSession.Commit): LedgerSession.CommitResult | undefined;
  }

  export interface PolicyRowSubAdapter {
    append(row: PolicyRow.Row): boolean;
    rows(generation?: number): PolicyRow.Row[];
    /** Select latest, derive its successor and append every row in one transaction.
     * Return undefined from derive to keep the current generation unchanged.
     * Empty generations and refused rows throw and roll back the whole write unit.
     */
    appendGeneration(
      derive: (
        current: readonly PolicyRow.Row[],
      ) => readonly Omit<PolicyRow.Row, "generation">[] | undefined,
    ): number;
  }

  export interface ActorRegistrySubAdapter {
    getIdentity(id: string): Actor.Identity | undefined;
    setIdentity(identity: Actor.Identity): void;
    removeIdentity(id: string): boolean;
    getEndpoint(id: string): Actor.Endpoint | undefined;
    setEndpoint(endpoint: Actor.Endpoint): void;
    findEndpoint(
      channel: string,
      externalId: string,
      workspace: string | undefined,
    ): Actor.Endpoint | undefined;
    listEndpoints(actorId?: string, workspace?: string): Actor.Endpoint[];
    removeEndpoint(id: string): boolean;
    /**
     * #P3 mint-volume bound (§8.12): provisional identities whose endpoint
     * sits on this channel(+workspace) minted at or after `since`.
     */
    countProvisionalSince(channel: string, workspace: string | undefined, since: number): number;
  }

  export interface BlacklistSubAdapter {
    get(id: string): Actor.BlacklistEntry | undefined;
    set(entry: Actor.BlacklistEntry): void;
    list(): Actor.BlacklistEntry[];
    remove(id: string): boolean;
  }

  export interface ChannelGrantSubAdapter {
    get(id: string): Actor.ChannelGrant | undefined;
    set(grant: Actor.ChannelGrant): void;
    list(): Actor.ChannelGrant[];
    remove(id: string): boolean;
  }

  /** Current projection of committed admissions, not another admission ledger. */
  export interface ReplyGrantSubAdapter {
    /** Expiry, first-contact deduplication and the rule cap share one write lock. */
    claim(
      grant: Gateway.SenderTargetGrant & {
        readonly ruleId: string;
        readonly expiresAt: number;
        readonly replyScope: NonNullable<Gateway.SenderTargetGrant["replyScope"]>;
      },
      bound: { readonly at: number; readonly maxLiveInstances: number },
    ): "claimed" | "existing" | "capacity";
    /** Indexed current view; no history reads or boot replay. Expiry is inclusive. */
    listLive(at: number): Gateway.SenderTargetGrant[];
  }

  /**
   * Provisioning declarations (docs/provisioning-and-providers.md §3):
   * Person manifests, ChannelInstance declarations, and vault Secret rows.
   * Sole-owner and vault laws live in the ledger stores, not here.
   */
  export interface ProvisioningSubAdapter {
    getPerson(id: string): Provisioning.Person | undefined;
    setPerson(person: Provisioning.Person): void;
    listPersons(): Provisioning.Person[];
    removePerson(id: string): boolean;
    getChannelInstance(id: string): Provisioning.ChannelInstance | undefined;
    setChannelInstance(instance: Provisioning.ChannelInstance): void;
    listChannelInstances(): Provisioning.ChannelInstance[];
    removeChannelInstance(id: string): boolean;
    getSecret(id: string): Provisioning.Secret | undefined;
    setSecret(secret: Provisioning.Secret): void;
    listSecrets(): Provisioning.Secret[];
    removeSecret(id: string): boolean;
  }

  /** First-writer-wins facts on the adapter's shared transaction connection. */
  export interface DecisionFactSubAdapter {
    record(input: DecisionFact.Record): DecisionFact.Outcome;
    head(key: string): DecisionFact.Recorded | undefined;
  }

  /**
   * Surface-key map rows (perimeter surface, #707): the N:1 surfaceKey →
   * sessionId claim table. `claim` is compare-and-swap shaped — with
   * `expectedSessionId` it replaces only while the current owner still equals
   * it, without it it inserts only when the key is absent — and always returns
   * the sessionId that owns the key after the attempt. The key format codec
   * stays `Channel.SurfaceKey`; this is the row surface only.
   */
  export interface SurfaceKeySubAdapter {
    claim(key: string, sessionId: string, expectedSessionId?: string): string;
    lookup(key: string): string | undefined;
    listBySession(sessionId: string): string[];
  }

  /**
   * Active-egress debit ledger (#219, perimeter domain): a per-(senderId,
   * targetActorId) append-only log of ADMITTED proactive sends. The gateway
   * router is the sole writer (same isolation as the wait store — the brain
   * never reaches it). `claim` atomically folds the projection, asks the
   * perimeter evaluator whether the row fits, and appends only when admitted.
   * Retrying the same row id is idempotently `claimed`.
   */
  export interface EgressBudgetSubAdapter {
    read(senderId: string, targetActorId: string, windowStartAt: number): Gateway.EgressDebitState;
    claim(
      row: Gateway.EgressDebitRow,
      windowStartAt: number,
      canClaim: (state: Gateway.EgressDebitState) => boolean,
    ): "claimed" | "refused";
  }
}
