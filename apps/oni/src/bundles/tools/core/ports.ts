import type { FilePorts } from "./filesystem";
import type { LlmPort } from "../completion/index";
import type { Cell } from "../eval/index";
import type { ImagePort } from "../image/index";
import type { OutputPort, SpeechPort } from "../speech/index";

/** The ports the machine-tool bundles (file, bash, eval, completion, speech, image) execute against. */
export interface MachineToolPorts {
  readonly machines: FilePorts["machines"];
  readonly cells: { readonly cell: Cell } | undefined;
  readonly llm: LlmPort | undefined;
  readonly speech: SpeechPort | undefined;
  readonly putOutput: OutputPort | undefined;
  readonly image: ImagePort | undefined;
}

export type MachineToolPortsSource = () => MachineToolPorts | undefined;

export const ABSENT_MACHINE_PORTS: MachineToolPorts = {
  machines: undefined, cells: undefined, llm: undefined, speech: undefined, putOutput: undefined, image: undefined,
};
