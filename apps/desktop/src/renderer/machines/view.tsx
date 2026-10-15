import type { Machine } from "@openomni/protocol";
import { ActionButton, ConsoleContent, Text } from "@openomni/ui";
import { useQuery } from "@tanstack/react-query";
import type { GatewayChatTransport } from "../chat/gateway-transport";
import { machineListOptions } from "../state/queries";

export function MachinesView({ transport }: {
  readonly transport: Pick<GatewayChatTransport, "machineList"> | null;
}) {
  const machines = useQuery(machineListOptions(transport));
  return <ConsoleContent>
    <section aria-label="Machines" className="flex min-w-0 flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Text as="h1" level="display">Machines</Text>
          <p className="mt-2 text-body text-fg-muted">Attached machines and their latest resource reports.</p>
        </div>
        <ActionButton disabled={transport === null || machines.isFetching} onClick={() => void machines.refetch()}>Refresh</ActionButton>
      </header>
      {transport === null ? <p role="status">Connect the gateway to view machines.</p> : <>
        {machines.isPending && <p role="status">Loading machines...</p>}
        {machines.error && <p role="alert">{machines.error.message} Refresh to try again.</p>}
        {machines.data?.length === 0 && <p className="text-body text-fg-muted">No machines attached. Enroll a machine through provision, then attach its daemon.</p>}
        <ul className="flex min-w-0 flex-col gap-4">
          {machines.data?.map((machine) => <MachineRow key={machine.machineId} machine={machine} />)}
        </ul>
      </>}
    </section>
  </ConsoleContent>;
}

function MachineRow({ machine }: { readonly machine: Machine.Info }) {
  return <li className="flex min-w-0 flex-col gap-3 border-line border-b py-4">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <Text as="h2" level="title" className="min-w-0 break-all">{machine.name}</Text>
      <span className="text-fg-muted text-label">{machine.live === undefined ? "Awaiting report" : machine.live.stale ? "Stale report" : "Live"}</span>
    </div>
    <p className="break-all text-body text-fg-muted">{machine.machineId} · {machine.os} {machine.arch}</p>
    <dl className="grid min-w-0 gap-3 text-body sm:grid-cols-2">
      <div><dt className="text-fg-muted text-label">Tags</dt><dd className="break-all">{machine.tags.join(", ") || "No tags"}</dd></div>
      <div><dt className="text-fg-muted text-label">Capabilities</dt><dd className="break-all">{machine.capabilities.join(", ") || "None negotiated"}</dd></div>
      <div><dt className="text-fg-muted text-label">Capacity</dt><dd>{machine.resources === undefined ? "Not reported" : `${machine.resources.cpus} CPUs · ${(machine.resources.memoryBytes / 1024 ** 3).toFixed(1)} GiB memory`}</dd></div>
      <div><dt className="text-fg-muted text-label">Latest load</dt><dd>{machine.live === undefined ? "Not reported" : `${machine.live.load.loadAvg1.toFixed(2)} load · ${(machine.live.load.memoryAvailableBytes / 1024 ** 3).toFixed(1)} GiB available · ${machine.live.load.inFlight} cells running`}</dd></div>
    </dl>
  </li>;
}
