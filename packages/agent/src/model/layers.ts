import { Layer } from "effect";
import { resolveAuthFilePath } from "./model/loader";
import { Provider } from "./provider";
import { run } from "./run";
import { Llm } from "./services";

/** Resolved once at Layer build: a later environment change cannot redirect a running service. */
export const LlmLive = Layer.sync(Llm, () => {
  const authFilePath = resolveAuthFilePath();
  return {
    run: (input, sink, dependencies) => run({ ...input, authFilePath }, sink, dependencies),
    resolveModel: (input) => Provider.resolveModel({ ...input, authFilePath }),
  };
});
