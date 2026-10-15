import type { FilePorts } from "./filesystem";
import type { LlmPort } from "../completion/index";
import type { Cell } from "../eval/index";

/** The ports the machine-tool bundles (file, bash, eval, completion) execute against (#1561). */
export interface MachineToolPorts {
  readonly machines: FilePorts["machines"];
  readonly cells: { readonly cell: Cell } | undefined;
  readonly llm: LlmPort | undefined;
}

export type MachineToolPortsSource = () => MachineToolPorts | undefined;

export const ABSENT_MACHINE_PORTS: MachineToolPorts = { machines: undefined, cells: undefined, llm: undefined };
