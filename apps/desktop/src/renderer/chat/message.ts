import type { UIMessage } from "ai";

export interface TurnMetadata {
  /** Wall clock of the turn's first token, epoch ms. */
  readonly startedAt?: number;
  /** How long the turn took, in ms. */
  readonly elapsedMs?: number;
}

type OpenOmniTools = {
  bash: {
    input: { readonly command: string };
    output: { readonly stdout: string };
  };
};

export type OpenOmniUIMessage = UIMessage<TurnMetadata, never, OpenOmniTools>;
