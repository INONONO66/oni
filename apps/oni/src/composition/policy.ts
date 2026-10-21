import { readFileSync } from "node:fs";
import { type Bundle, Core } from "@oni/agent";
import {
  Gateway,
  PlainValueSchema,
  PointId,
  type PlainValue,
  type PolicyRow,
  type Storage as ProtocolStorage,
} from "@oni/protocol";
import { z } from "zod";
import { legacyPolicyAddress } from "../bundles/core-policy/index";
import { ADMISSION_DEPTH_MAX, DELEGATION_GUARD_REFS, SPAWN_DEPTH_REF } from "../bundles/delegation-policy/index";
import { SECRETS_GUARD_REF } from "../bundles/hooks-json/index";
import { AppInvariantError } from "../invariant";
import shippedPolicy from "../../policy/owner-policy.json";
import { composedPointTable } from "./point-table";

const { SEEDED_POLICY_ROWS, assertPointGenerationRows, POINT_GENERATION_ROW, translateLegacyPolicyRow } = Core;

type SeedRow = Omit<PolicyRow.Row, "generation">;

const Positive = z.number().int().positive();

/**
 * One Owner policy row (#1572): a point, an order, the match, and EITHER a
 * constant verdict (seeded straight into the policy plane) OR a named handler
 * a bundle implements (composed as that bundle's gate row).
 */
const PolicyFileRow = z
  .strictObject({
    id: z.string().min(1),
    point: z.string().min(1),
    order: z.number().int(),
    when: z.record(z.string(), PlainValueSchema),
    verdict: z
      .strictObject({
        type: z.enum(["allow", "deny", "require_approval"]),
        reason: z.string().min(1).optional(),
      })
      .optional(),
    handler: z.string().min(1).optional(),
    params: PlainValueSchema.optional(),
    fields: z.array(z.string().min(1)).min(1).optional(),
  })
  .refine((row) => (row.verdict === undefined) !== (row.handler === undefined), {
    message: "a row carries exactly one of verdict or handler",
  })
  .refine((row) => row.handler !== undefined || row.params === undefined, {
    message: "params ride only handler rows",
  })
  .refine((row) => row.handler !== undefined || row.fields === undefined, {
    message: "fields ride only handler rows",
  });
type PolicyFileRow = z.infer<typeof PolicyFileRow>;

const PolicyFile = z.strictObject({
  approval: z.strictObject({
    responders: z.array(z.string().min(1)).min(1),
    recentOpen: z.strictObject({ limit: Positive, windowMs: Positive }),
    defaultExpiryMs: Positive,
    defaultBudget: z.strictObject({
      maxTurns: Positive,
      maxToolCalls: Positive,
      maxWallTimeMs: Positive,
      maxToolRuntimeMs: Positive,
    }),
  }),
  rows: z.array(PolicyFileRow),
});

const MessageRule = z.union([Gateway.RuleTableA, Gateway.RuleTableB]);

type HandlerKind = "guard" | "transformer";

/**
 * Names are derived from the app bundles that implement them. A policy file
 * can select behavior, but cannot invent executable code.
 */
const OWNER_POLICY_HANDLER_REGISTRY: ReadonlyMap<string, HandlerKind> = new Map([
  ...DELEGATION_GUARD_REFS.map((name) => [name, "guard"] as const),
  [SECRETS_GUARD_REF, "transformer"],
]);

/** The compiled Owner policy: approval values, seeded rows, and the delegation bundle's guard rows. */
export interface OwnerPolicy {
  readonly approval: Core.ApprovalPolicy;
  readonly rows: readonly SeedRow[];
  readonly delegationRows: readonly Bundle.BundleGateRow[];
  readonly rowSet: readonly { readonly id: string; readonly point: string }[];
}

function refuse(source: string, code: string, detail: string): never {
  throw new AppInvariantError(`owner policy ${source}: ${detail}`, code);
}

/** The depth cap a row declares, if it is one of the two depth-cap shapes. */
function depthCap(row: PolicyFileRow): number | undefined {
  if (row.handler === SPAWN_DEPTH_REF) {
    const params = row.params;
    if (params === null || typeof params !== "object" || Array.isArray(params)) return undefined;
    return typeof params.limit === "number" ? params.limit : undefined;
  }
  const rule = MessageRule.safeParse(row.when.message);
  return rule.success && rule.data.table === "B" && rule.data.check.kind === "depth" ? rule.data.check.max : undefined;
}

function compileHandlerRow(
  row: PolicyFileRow & { readonly handler: string },
  point: Bundle.BundleGateRow["on"],
  source: string,
): Bundle.BundleGateRow {
  const kind = OWNER_POLICY_HANDLER_REGISTRY.get(row.handler);
  if (kind === undefined)
    refuse(
      source,
      "unknown_handler",
      `row ${row.id} names unknown handler ${row.handler}; known: ${[...OWNER_POLICY_HANDLER_REGISTRY.keys()].join(", ")}`,
    );
  if (kind === "transformer") {
    if (row.fields === undefined)
      refuse(source, "invalid_policy_file", `transformer row ${row.id} must declare fields`);
    return {
      id: row.id,
      on: point,
      when: row.when,
      do: "rewrite",
      how: {
        ref: row.handler,
        fields: [...row.fields],
        ...(row.params === undefined ? {} : { params: row.params }),
      },
      order: row.order,
    };
  }
  if (row.fields !== undefined)
    refuse(source, "invalid_policy_file", `guard row ${row.id} cannot declare fields`);
  return {
    id: row.id,
    on: point,
    when: row.when,
    do: "gate",
    how: { ref: row.handler, ...(row.params === undefined ? {} : { params: row.params }) },
    order: row.order,
  };
}

function compileRow(row: PolicyFileRow, source: string): SeedRow | Bundle.BundleGateRow {
  const point = PointId.safeParse(row.point);
  if (!point.success) refuse(source, "unknown_point", `row ${row.id} targets unknown point ${row.point}`);
  const address = legacyPolicyAddress(point.data);
  if (address === undefined) refuse(source, "unknown_point", `row ${row.id} targets unsupported point ${row.point}`);
  const message = row.point === "message.pre" ? MessageRule.safeParse(row.when.message) : undefined;
  if (message !== undefined && !message.success)
    refuse(source, "invalid_policy_file", `row ${row.id} carries no valid message rule`);
  // #1432: admission and every depth cap share one number.
  const cap = depthCap(row);
  if (cap !== undefined && cap !== ADMISSION_DEPTH_MAX)
    refuse(source, "invalid_policy_file", `row ${row.id} caps depth at ${cap}; admission caps it at ${ADMISSION_DEPTH_MAX}`);
  if (row.handler !== undefined)
    return compileHandlerRow({ ...row, handler: row.handler }, point.data, source);
  if (message?.success && row.verdict?.type !== message.data.effect)
    refuse(source, "invalid_policy_file", `row ${row.id} verdict disagrees with message effect`);
  if (message?.success && row.verdict?.reason !== undefined && row.verdict.reason !== row.id)
    refuse(source, "invalid_policy_file", `row ${row.id} verdict reason must be the row id`);
  return {
    name: row.id,
    kind: address.kind,
    phase: address.phase,
    priority: row.order,
    match: { encodingVersion: 1, value: row.when },
    verdict: {
      encodingVersion: 1,
      value: message?.success ? { type: message.data.effect, reason: row.id } : row.verdict ?? null,
    },
  };
}

/**
 * Compiles an Owner policy value fail-closed (#1572): a bad shape refuses
 * `invalid_policy_file`, a row on an unregistered point `unknown_point`, a
 * handler no bundle implements `unknown_handler` — always the typed
 * `AppInvariantError`, before any listener exists.
 */
export function compileOwnerPolicy(value: PlainValue, source: string): OwnerPolicy {
  const parsed = PolicyFile.safeParse(value);
  if (!parsed.success) refuse(source, "invalid_policy_file", parsed.error.message);
  const ids = new Set<string>();
  const rows: SeedRow[] = [];
  const delegationRows: Bundle.BundleGateRow[] = [];
  const rowSet: { id: string; point: string }[] = [];
  for (const row of parsed.data.rows) {
    if (ids.has(row.id)) refuse(source, "invalid_policy_file", `duplicate row id ${row.id}`);
    ids.add(row.id);
    const compiled = compileRow(row, source);
    rowSet.push({ id: row.id, point: row.point });
    if ("on" in compiled) delegationRows.push(compiled);
    else rows.push(compiled);
  }
  return { approval: parsed.data.approval, rows, delegationRows, rowSet };
}

/** Reads and compiles the selected Owner policy file. */
export function readOwnerPolicy(path: string): OwnerPolicy {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    return refuse(path, "unreadable_path", `cannot read: ${String(cause)}`);
  }
  let value: PlainValue;
  try {
    value = PlainValueSchema.parse(JSON.parse(raw));
  } catch (cause) {
    return refuse(path, "invalid_policy_file", `cannot parse: ${String(cause)}`);
  }
  return compileOwnerPolicy(value, path);
}

/** The shipped default (`policy/owner-policy.json`), compiled through the same gate. */
export const SHIPPED_OWNER_POLICY: OwnerPolicy = compileOwnerPolicy(
  PlainValueSchema.parse(shippedPolicy),
  "shipped owner-policy.json",
);

/** The policy file at `path` when one is configured, else the shipped default. */
export function ownerPolicy(path: string | undefined): OwnerPolicy {
  return path === undefined ? SHIPPED_OWNER_POLICY : readOwnerPolicy(path);
}

export const APPROVAL_POLICY: Core.ApprovalPolicy = SHIPPED_OWNER_POLICY.approval;

/**
 * Seeds the kernel's mandatory generation into the catalog's policy plane and
 * converts the latest generation once into a validated fourteen-point
 * generation (#1251): historical generations keep their exact bytes, and a
 * latest row that cannot map to a registered point rejects the whole write
 * unit, failing the boot. The mandatory rows are the agent seed, the Owner
 * policy file's constant rows (#1572), and the point-generation row;
 * bundle-owned rows arrive through `bundleRows`.
 */
export function seedKernelPolicyRows(
  policies: ProtocolStorage.PolicyRowSubAdapter,
  bundleRows: readonly SeedRow[] = [],
  /** The composition's merged point table (#1251); the default is the full built-in composition this app ships. */
  table: Core.GatePointTable = composedPointTable(),
  ownerRows: readonly SeedRow[] = SHIPPED_OWNER_POLICY.rows,
): number {
  const kernelRows: readonly SeedRow[] = [...SEEDED_POLICY_ROWS, ...ownerRows, POINT_GENERATION_ROW];
  return policies.appendGeneration((current) => {
    // Convert the latest generation's semantics onto the fourteen-point
    // contract and validate every row BEFORE any early return: a completed
    // generation carrying an unmappable custom row still rejects the boot.
    const converted = current.map((row) => translateLegacyPolicyRow(row));
    assertPointGenerationRows(converted, table);
    const next = new Map([...kernelRows, ...bundleRows].map((row) => [policyId(row), row]));
    // Preserve existing policy values and site-specific ids; fill missing mandatory ids.
    for (const row of converted) next.set(policyId(row), row);
    // The rows this boot writes must themselves map onto the composition's
    // points: a composition without a capability refuses its rows at seed.
    assertPointGenerationRows([...next.values()], table);
    // Identity compares the STORED rows: a conversion that changed any row's
    // point identity must land as a new generation even when the converted
    // set already matches the target.
    const storedIds = new Set(current.map(policyId));
    if (storedIds.size === next.size && [...next.keys()].every((id) => storedIds.has(id))) {
      return undefined;
    }
    return [...next.values()];
  });
}

function policyId(row: SeedRow): string {
  return JSON.stringify([row.name, row.kind, row.phase]);
}
