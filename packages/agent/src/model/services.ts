import { Context } from "effect";
import type { run, RunInput } from "./run";
import type { Provider } from "./provider";
import type { Sink } from "./sink";

/** One attempt per invocation; retry admission belongs to the executor. No `authFilePath`: the composition root closes over it, so consumers cannot redirect credential I/O. */
export class Llm extends Context.Service<Llm, {
  readonly run: (input: RunInput, sink: Sink, dependencies?: Parameters<typeof run>[2]) => ReturnType<typeof run>;
  readonly resolveModel: (input: Omit<Parameters<typeof Provider.resolveModel>[0], "authFilePath">) => ReturnType<typeof Provider.resolveModel>;
}>()("@openomni/agent/Llm") {}
