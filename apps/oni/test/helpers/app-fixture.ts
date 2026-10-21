import { Core, Bundle } from "@oni/agent";
const Llm = Core.Llm;
import { type AppRuntimeOptions, LlmLive } from "../../src/runtime";
import { type Clock, Context, Effect, Layer } from "effect";
import { composedHolderOf, alarmPortsSlot, type ComposedHolder } from "../../src/composition/composed";
import { toolPortsSlot } from "../../src/composition/composed";
import { createWatchPlane } from "../../src/composition/watch-plane";
import { gatewayRuntime } from "../../src/gateway";
import { readHooksJson } from "../../src/bundles/hooks-json/index";
import { appManifest } from "../../src/manifest";
import { startOni } from "../../src/index";
import { sessionTree } from "../../../../packages/agent/test/store/helpers/session-tree";
import { planeOf } from "./ledger";
import { testEntropy } from "./test-entropy";
import { Bus } from "./bus";
import { appRuntime } from "./effect";

/**
 * The PRODUCT composition for injected-runtime fixtures (#1255 P3): the same
 * `appManifest -> compose` boot runs, over a throwaway watch plane — the
 * composed tables (names, tools, rows, kinds) are what matter; the LIVE wake
 * router is always the booting process's own plane.
 */
async function productComposedHolder(
  off?: readonly string[],
  hooksPath?: string,
  bundles?: readonly Bundle.BundleContract[],
): Promise<ComposedHolder> {
  const plane = createWatchPlane();
  // #1308: the boot binds the live monitor ports into this slot.
  const alarms = alarmPortsSlot();
  // #1561: the boot binds the live tool ports into this slot.
  const tools = toolPortsSlot();
  const product = appManifest({
    alarm: plane.contract,
    wake: plane.wake,
    alarms: alarms.current,
    tools: tools.current,
    ...(hooksPath === undefined ? {} : { hooks: readHooksJson(hooksPath) }),
    ...(off === undefined ? {} : { off }),
  });
  // #1308: boot options carry no tool list; a test tool joins the composition
  // the one sanctioned way — as a declared manifest bundle.
  const manifest =
    bundles === undefined || bundles.length === 0
      ? product
      : Bundle.Manifest.define({
          capabilities: [...product.capabilities],
          bundles: [...product.bundles, ...bundles],
          off: [...product.off],
        });
  const generation = Bundle.composeSync(manifest);
  return composedHolderOf({ manifest, generation }, alarms, tools);
}

export type FixtureLlm = Context.Service.Shape<typeof Llm>;
type Start = NonNullable<Parameters<typeof startOni>[0]>;
export type AppFixtureOptions = Omit<Start, "sessionRuntime"> & {
  readonly llm?: Partial<FixtureLlm>;
  /** Test manifest bundles composed after the product bundles (#1308): the one way a fixture declares extra tools. */
  readonly bundles?: readonly Bundle.BundleContract[];
  readonly sessionRuntime?: Start["sessionRuntime"] & {
    readonly clock?: () => number;
    readonly entropy?: () => string;
  };
  /** `"injected"` pins the cluster host's DeliverAt holds to the injected clock (#1255 P6). */
  readonly clusterClock?: "injected";
  /** The Effect Clock hook consult deadlines run on (#1256 r5 H-2): tests mount a TestClock. */
  readonly hookClock?: Clock.Clock;
  /** Drives the complete app and cluster host, including persisted alarm delivery. */
  readonly effectClock?: Clock.Clock;
};

/** Test composition supplies services through the actual AppLive runtime. */
export async function appFixture(options: AppFixtureOptions) {
  if (options.config === undefined) throw new Error("fixture config required");
  const { llm, sessionRuntime, clusterClock, hookClock, effectClock, bundles, ...app } = options;
  const { clock, entropy, ...session } = sessionRuntime ?? {};
  const makeRuntime = (settings: AppRuntimeOptions) => effectClock === undefined
    ? gatewayRuntime(settings)
    : appRuntime(settings, effectClock);
  const runtime =
    options.runtime ??
    makeRuntime({
      observations: Bus,
      composed: await productComposedHolder(options.config.off, options.config.hooksPath, bundles),
      ...(options.config.catalogPath === undefined
        ? {}
        : { catalogPath: options.config.catalogPath }),
      ...(options.config.sessionsDir === undefined
        ? {}
        : { sessionsDir: options.config.sessionsDir }),
      ...(options.config.entityIdleMs === undefined
        ? {}
        : { entityIdleMs: options.config.entityIdleMs }),
      now: clock,
      ...(clusterClock === undefined ? {} : { clusterClock }),
      ...(hookClock === undefined ? {} : { hookClock }),
      entropy: entropy === undefined ? undefined : testEntropy(entropy),
      llm: Layer.unwrap(
        Effect.map(Layer.build(LlmLive), (live) =>
          Layer.succeed(Llm, { ...Context.get(live, Llm), ...llm }),
        ),
      ),
    });
  return startOni({ ...app, runtime, sessionRuntime: session });
}

/**
 * The `session.configure{operation: "compose"}` action of the first adopted
 * generation (#1306): the per-session append-only row composition writes when
 * a session adopts a composed generation, carrying the typed off cascade in
 * `disabled`. One resident session must have run a turn before this reads.
 */
export async function composeRowOf(app: Awaited<ReturnType<typeof startOni>>) {
  const plane = await planeOf(app.runtime);
  const sessionId = plane.listSessions().find((row) => row.id !== "gateway-ingress")?.id;
  if (sessionId === undefined) throw new Error("no resident session has adopted a generation");
  const action = sessionTree(sessionId, plane.sessionStore(sessionId).actions).find(
    (row) =>
      row.kind === "session.configure" &&
      (row.intent.value as { operation?: string }).operation === "compose",
  );
  if (action === undefined) throw new Error(`no compose configure row in session ${sessionId}`);
  return action;
}

/** The test manifest bundle (#1308): fixture tools ride a declared bundle, never a boot option. */
export function testToolsBundle(tools: readonly Bundle.BundleTool[]) {
  return Bundle.define({ name: "test-tools", requires: [], tools });
}
