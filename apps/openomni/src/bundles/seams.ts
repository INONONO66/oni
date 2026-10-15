import { Bundle, type Core } from "@openomni/agent";

/**
 * App-owned capability ports (#1255/#1258), declared outside `manifest.ts` so
 * bundles can require them without importing the manifest that lists the
 * bundles (no cycle). The manifest's `Capability.define` contracts carry
 * these exact tags. The action capability's port moved to the plugin with
 * #1304: bundles require `Bundle.ActionPort` from `@openomni/agent`.
 */

/** Persisted manifest hash preimages require this key to remain byte-identical. */
export const ToolCapabilityPort = Bundle.port("@openomni/openomni/ToolCapabilitySeam");

/** Persisted manifest hash preimages require this key to remain byte-identical. */
export const CompactionSummarizerPort = Bundle.port("@openomni/openomni/CompactionSummarizerSeam");

type DispatchDefinition = Parameters<typeof Core.projectTools>[0][number];

/**
 * One bundle tool over late-bound ports (#1561): the manifest is composed
 * before the runtime exists, so the face (name, schema, visibility) is built
 * from `absent` and every call resolves the CURRENT ports. A body built from
 * one ports value is reused while that value stays bound; before boot binds,
 * calls run the absent-port body and refuse typed.
 */
export function boundTool<P extends object>(
  ports: () => P | undefined,
  absent: P,
  build: (ports: P) => DispatchDefinition,
): DispatchDefinition {
  const face = build(absent);
  const built = new WeakMap<P, DispatchDefinition>();
  const current = (): DispatchDefinition => {
    const live = ports();
    if (live === undefined) return face;
    const known = built.get(live);
    if (known !== undefined) return known;
    const definition = build(live);
    built.set(live, definition);
    return definition;
  };
  const { approval } = face;
  return {
    ...face,
    execute: (args, context) => current().execute(args, context),
    ...(approval === undefined
      ? {}
      : { approval: (input, context, prepare) => (current().approval ?? approval)(input, context, prepare) }),
  };
}
