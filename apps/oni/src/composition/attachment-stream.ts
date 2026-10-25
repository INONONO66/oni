import type { MachineHost, MachineStreamWriter, StreamWriteOptions, StreamWriteReceipt } from "@oni/machines";
import { parseLocus } from "../bundles/tools/locus/index";

/** App binding resolves the locus and runs the machines-owned Effect operation. */
export interface InboxStreamWriter {
  write(
    locus: string,
    chunks: AsyncIterable<Uint8Array>,
    options: StreamWriteOptions,
  ): Promise<StreamWriteReceipt>;
}

/** Bind one configured machine and one app Effect edge; the host owns streaming and publication. */
export function inboxStreamWriter(
  host: Pick<MachineHost, "get">,
  defaultMachine: string,
  run: (effect: ReturnType<MachineStreamWriter["writeStream"]>) => Promise<StreamWriteReceipt>,
): InboxStreamWriter {
  return {
    write(locus, chunks, options) {
      const target = parseLocus(locus, { defaultMachine });
      return run(host.get(target.machine).fs.writeStream(target.path, chunks, options));
    },
  };
}
