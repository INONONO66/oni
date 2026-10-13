import { Effect } from "effect";
import type { Model } from "@openomni/protocol";

/** resolveModel double that records every ref it is asked to resolve (the injected `now` is contract plumbing, not identity). */
export function recordingResolveModel(resolved: Model.Ref[]) {
  return (model: Model.Ref) =>
    Effect.promise(async () => {
      resolved.push(model);
      return { id: model.id, name: model.id, providerID: model.provider };
    });
}
