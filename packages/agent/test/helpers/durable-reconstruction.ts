import { sessionTree } from "./session-tree";
import { writeFileSync } from "node:fs";
import {
  canonicalDigest,
  LedgerAction,
  Message,
  PlainValueSchema,
  SessionTurn,
} from "@oni/protocol";
import { z } from "zod";
import { Effect } from "effect";
import { runAgent } from "./executor";
import { activeIsolation, isolatedLedger, isolatedRun } from "./isolated";
import { openCrashStores } from "./crash-stores";
import { runnerTestLayer } from "./isolated";
import { allowConfigure, isolatedRuntime, withSessionServices, type SessionFixture } from "./session-services";
import { createExecutor } from "../../src/core/loop/executor";
import { resolveSessionRuntime, type SessionRunnerInput } from "../../src/core/session/run";
import { createController } from "../../src/testing/controller";
import {
  FoldCheckpointIntegrityError,
  foldHistoryState,
  foldSessionHistory,
  hydrateSessionHistory,
} from "../../src/inspect/history";
import { reconstructionFixture, reconstructionSession } from "./reconstruction-fixture";
import { TEST_APPROVAL_POLICY } from "../helpers/approval-policy";

export const reconstructionWitness = z.object({
  revision: z.number(),
  digest: z.string(),
  oracle: z.string(),
  stateDigest: z.string(),
  stateOracle: z.string(),
  ids: z.array(z.string()),
  history: z.array(Message.WithParts),
  checkpoint: LedgerAction.Node.optional(),
  actions: z.array(LedgerAction.Node),
  capture: z
    .object({
      context: SessionTurn.Context,
      toolsGeneration: z.number(),
      toolsHash: z.string(),
      systemHash: z.string(),
      history: z.array(Message.WithParts),
      messages: z.array(
        SessionTurn.Message.extend({ id: z.string().optional(), time: z.number().optional() }),
      ),
      recoveryUnchanged: z.boolean(),
    })
    .optional(),
});
type Witness = z.infer<typeof reconstructionWitness>;

function reconstructionSnapshot(): Witness {
  const kernel = isolatedLedger().kernel;
  const actions = sessionTree(kernel, reconstructionSession);
  const hydrated = hydrateSessionHistory(kernel, reconstructionSession);
  return {
    revision: kernel.row(reconstructionSession).revision,
    digest: canonicalDigest(hydrated.history),
    oracle: canonicalDigest(foldSessionHistory(reconstructionSession, actions)),
    stateDigest: canonicalDigest({ foldVersion: 1, state: PlainValueSchema.parse(hydrated.state) }),
    stateOracle: canonicalDigest({
      foldVersion: 1,
      state: PlainValueSchema.parse(foldHistoryState(reconstructionSession, actions)),
    }),
    ids: hydrated.history.map((message) => message.info.id),
    history: hydrated.history,
    checkpoint: actions.filter((action) => action.kind === "fold.checkpoint").at(-1),
    actions,
  };
}

export async function reconstructionMain(
  stage: string,
  dbPath: string,
  boundary?: (witness: Witness) => void,
): Promise<Witness> {
  const main = async (): Promise<Witness> => {
    if (stage === "write") {
      const fixture = await reconstructionFixture();
      await fixture.compact();
      await fixture.suffix();
    }
    const witness = reconstructionSnapshot();
    if (stage !== "wake") return witness;
    const kernel = isolatedLedger().kernel;
    // W5.2: the Storage-era wake entry point is gone; waking is a fresh
    // controller activation over the durable kernel driving its reconcile
    // (recover path).
    const runtime: SessionFixture = {
      observations: { publish: () => undefined },
      clock: () => 100_000,
      authorizeConfigure: allowConfigure,
      ...isolatedRuntime(),
    };
    return runAgent(Effect.scoped(withSessionServices(Effect.gen(function* () {
      const resolved = yield* resolveSessionRuntime(runtime);
      const scope = yield* Effect.scope;
      const controller = yield* createController(
        kernel,
        reconstructionSession,
        (input: SessionRunnerInput) => Effect.gen(function* () {
          const before = sessionTree(kernel, reconstructionSession);
          const executor = yield* createExecutor({ approvalPolicy: TEST_APPROVAL_POLICY,
            ledger: input.ledger,
            identity: {
              sessionId: input.sessionId,
              role: input.role,
              turnId: input.turnId,
              parentActionId: input.turnId,
            },
          });
          yield* executor.recover();
          const pin = SessionTurn.Resume.parse(
            kernel.actionById(input.actionId)?.intent.value,
          ).context;
          witness.capture = {
            context: pin,
            toolsGeneration: input.toolsGeneration,
            toolsHash: input.toolsHash,
            systemHash: input.systemHash,
            history: z.array(Message.WithParts).parse(input.history),
            messages: input.messages.map((message) => ({ ...message })),
            recoveryUnchanged:
              canonicalDigest(before) === canonicalDigest(sessionTree(kernel, reconstructionSession)),
          };
          boundary?.(witness);
          return { kind: "result" as const, text: "" };
        }),
        resolved,
        { reactivate: () => Effect.die("no reactivation in reconstruction main"), release: () => undefined },
        scope,
      );
      yield* controller.reconcile();
      return witness;
    }), runtime).pipe(Effect.provide(runnerTestLayer))));
  };
  // Crash-main seam: a spawned child owns its stores; an in-process caller's
  // isolation is reused so isolations never nest (they would deadlock). The
  // Storage-era one-dbPath guard survives as an explicit path check.
  const active = activeIsolation();
  if (active === undefined) return isolatedRun(main, () => openCrashStores(dbPath));
  if ("dbPath" in active && active.dbPath !== dbPath)
    throw new Error(`reconstruction main dbPath mismatch: ${String(active.dbPath)} != ${dbPath}`);
  return main();
}

/** Injectable witness/exit seam: the process cut is abrupt; the same main is tested in-process. */
export async function reconstructionProcessMain(
  args: string[],
  emit: (value: Witness | ReturnType<InstanceType<typeof FoldCheckpointIntegrityError>["toObject"]>) => void,
  exit: (code: number) => void,
) {
  const [stage, dbPath] = z
    .tuple([z.enum(["write", "read", "wake"]), z.string().min(1)])
    .parse(args);
  try {
    const witness = await reconstructionMain(stage, dbPath, (value) => {
      emit(value);
      exit(0);
    });
    if (stage !== "wake" || witness.capture === undefined) {
      emit(witness);
      exit(0);
    }
  } catch (error) {
    if (!(error instanceof FoldCheckpointIntegrityError)) throw error;
    emit({ name: "FoldCheckpointIntegrityError", data: error.data });
    exit(1);
  }
}

if (import.meta.main) {
  const [witnessPath, ...rest] = process.argv.slice(2);
  await reconstructionProcessMain(
    rest,
    (value) => writeFileSync(z.string().min(1).parse(witnessPath), `${JSON.stringify(value)}\n`),
    (code) => process.exit(code),
  );
}
