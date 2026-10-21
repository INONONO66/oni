import { canonicalDigest, ConsumptionSettings, type ConfigureDisabled, type LedgerAction, type LedgerSession, SessionGeneration, type Storage as ProtocolStorage } from "@oni/protocol";
import { z } from "zod";
import { GATE_ROW_WRITER_VERSION } from "../ports/gate-rows";
import { LedgerInvariant } from "./errors";

interface GenerationSeed {
  readonly tools: readonly SessionGeneration.Tool[];
  readonly bundles?: readonly string[];
  readonly system: {
    readonly preset: string;
    readonly blocks: readonly SessionGeneration.SystemBlock[];
  };
  readonly policyGeneration: number;
  readonly manifestHash?: string;
}

export interface MaterializeInput extends GenerationSeed {
  readonly id: string;
  readonly parentId: string | null;
  readonly role: LedgerSession.Role;
  /** Pinned at genesis: widths and fork copy cap. */
  readonly settings?: ConsumptionSettings;
  readonly actionId: string;
  readonly at: number;
}

export type ConfigureAuthority = (input: {
  readonly sessionId: string;
  readonly role: LedgerSession.Role;
  readonly operation: SessionGeneration.ConfigureIntent["operation"];
  readonly generation: number;
}) => boolean | Promise<boolean>;

export function materializationSeed(
  input: {
    readonly id: string;
    readonly parentId: string | null;
    readonly role: LedgerSession.Role;
    readonly actionId: string;
    readonly at: number;
    readonly settings?: ConsumptionSettings;
  },
  snapshot: SessionGeneration.Snapshot,
): LedgerSession.Materialize {
  return {
    row: {
      id: input.id,
      parentId: input.parentId,
      role: input.role,
      fenceOwner: null,
      fence: 0,
      revision: 0,
      state: "idle",
      toolsGeneration: snapshot.generation,
      systemHash: snapshot.systemHash,
      policyGeneration: snapshot.policyGeneration,
    },
    initialAction: configureAction({
      id: input.actionId,
      sessionId: input.id,
      parentId: null,
      operation: "create",
      snapshot,
      ...(input.settings === undefined ? {} : { settings: input.settings }),
      at: input.at,
    }),
  };
}

export function latestGenerationForIn(
  actions: ProtocolStorage.ActionSubAdapter,
  sessionId: string,
): SessionGeneration.Snapshot {
  let cursor = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const action = actions.configurationActions(sessionId, cursor)[0];
    if (action === undefined)
      throw new LedgerInvariant({
        operation: "session.generation",
        message: "session has no configured generation",
      });
    const snapshot = configurationSnapshot(action);
    if (snapshot !== undefined) return snapshot;
    cursor = action.ordinal;
  }
}

/** `session.configure.settings` carrier; any configure row may pin the settings. */
const ConfigureSettingsIntent = z.object({ settings: ConsumptionSettings });

/** Latest configure row with parseable `intent.settings`, newest-first over the index (read per batch). */
export function latestSettingsIn(
  actions: ProtocolStorage.ActionSubAdapter,
  sessionId: string,
): ConsumptionSettings | undefined {
  let cursor = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const action = actions.configurationActions(sessionId, cursor)[0];
    if (action === undefined) return undefined;
    const parsed = ConfigureSettingsIntent.safeParse(action.intent.value);
    if (parsed.success) return parsed.data.settings;
    cursor = action.ordinal;
  }
}

export function latestGeneration(
  actions: readonly LedgerAction.Node[],
): SessionGeneration.Snapshot {
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const snapshot = configurationSnapshot(actions[index]);
    if (snapshot !== undefined) return snapshot;
  }
  throw new LedgerInvariant({
    operation: "session.generation",
    message: "session has no configured generation",
  });
}

export function generationByNumber(
  actions: readonly LedgerAction.Node[],
  generation: number,
): SessionGeneration.Snapshot | undefined {
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const snapshot = configurationSnapshot(actions[index]);
    if (snapshot?.generation === generation) return snapshot;
  }
  return undefined;
}

export function generationSnapshot(input: GenerationSeed & {
  readonly generation: number;
  readonly revertTo: number;
}): SessionGeneration.Snapshot {
  assertUniqueTools(input.tools);
  assertUniqueBlocks(input.system.blocks);
  const tools = [...input.tools].sort((left, right) => left.name.localeCompare(right.name));
  const blocks = [...input.system.blocks];
  return SessionGeneration.Snapshot.parse({
    generation: input.generation,
    revertTo: input.revertTo,
    tools,
    toolsHash: canonicalDigest(tools),
    bundles: [...(input.bundles ?? [])].sort(),
    systemPreset: input.system.preset,
    systemBlocks: blocks,
    systemValue: [input.system.preset, ...blocks.map((block) => block.content)]
      .filter((value) => value.length > 0)
      .join("\n\n"),
    systemHash: canonicalDigest(blocks),
    policyGeneration: input.policyGeneration,
    // Snapshots persisted before the cutover stay versionless.
    rowsVersion: GATE_ROW_WRITER_VERSION,
    ...(input.manifestHash === undefined ? {} : { manifestHash: input.manifestHash }),
  });
}

export function configureAction(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly parentId: string | null;
  readonly operation: SessionGeneration.ConfigureIntent["operation"];
  readonly snapshot: SessionGeneration.Snapshot;
  /** Present only when the configure pins them. */
  readonly settings?: ConsumptionSettings;
  /** Present only on a forked child's genesis configure. */
  readonly forkedFrom?: SessionGeneration.ForkAncestry;
  /** Present only when a manifest composed. */
  readonly disabled?: ConfigureDisabled;
  readonly at: number;
}): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: "session.configure",
    intent: {
      encodingVersion: 1,
      value: {
        operation: input.operation,
        ...(input.settings === undefined ? {} : { settings: input.settings }),
        ...(input.forkedFrom === undefined ? {} : { forkedFrom: input.forkedFrom }),
        ...(input.disabled === undefined ? {} : { disabled: input.disabled.map((entry) => ({ ...entry })) }),
      },
    },
    effect: {
      encodingVersion: 1,
      value: {
        phase: "configured",
        snapshot: { ...input.snapshot, bundles: [...input.snapshot.bundles] },
      },
    },
    revert: {
      encodingVersion: 1,
      value: { generation: input.snapshot.revertTo },
    },
    ts: input.at,
  };
}


export function configurationSnapshot(
  action: LedgerAction.Node | undefined,
): SessionGeneration.Snapshot | undefined {
  if (action?.kind !== "session.configure") return undefined;
  const effect = SessionGeneration.ConfigureEffect.safeParse(action.effect.value);
  return effect.success ? effect.data.snapshot : undefined;
}


function assertUniqueTools(tools: readonly SessionGeneration.Tool[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new SessionGeneration.ConfigureError({
        code: "duplicate_tool",
        message: `duplicate tool name: ${tool.name}`,
      });
    }
    seen.add(tool.name);
  }
}

function assertUniqueBlocks(blocks: readonly SessionGeneration.SystemBlock[]): void {
  const seen = new Set<string>();
  for (const block of blocks) {
    if (seen.has(block.id)) {
      throw new SessionGeneration.ConfigureError({
        code: "duplicate_block",
        message: `duplicate system block id: ${block.id}`,
      });
    }
    seen.add(block.id);
  }
}
