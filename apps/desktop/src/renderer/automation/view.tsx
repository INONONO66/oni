import type { Ingress } from "@openomni/protocol";
import { ActionButton, ConsoleContent, Text } from "@openomni/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { GatewayChatTransport } from "../chat/gateway-transport";
import { GatewayUnavailableError } from "../errors";
import { automationListOptions, queryKeys } from "../state/queries";
import type { LocalSession } from "../state/store";
import { AutomationEditor } from "./editor";

type Change =
  | { readonly type: "save"; readonly record: Ingress.Automation }
  | { readonly type: "enable" | "disable" | "remove"; readonly id: string };

export function AutomationView({ transport, sessions, id }: {
  readonly transport: GatewayChatTransport | null;
  readonly sessions: readonly LocalSession[];
  readonly id: () => string;
}) {
  const client = useQueryClient();
  const records = useQuery(automationListOptions(transport));
  const [editing, setEditing] = useState<Ingress.Automation | null>(null);
  const change = useMutation({
    mutationFn: async (change: Change) => {
      if (transport === null) throw new GatewayUnavailableError("gateway not configured");
      switch (change.type) {
        case "save": return transport.automationAdd(change.record);
        case "enable": return transport.automationEnable(change.id);
        case "disable": return transport.automationDisable(change.id);
        case "remove": return transport.automationRemove(change.id);
      }
    },
    onSuccess: (_, change) => {
      if (change.type === "save") setEditing(null);
    },
    // Approval refusals can store a disabled record. Always read authoritative state.
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.automations }),
    retry: false,
  });
  const begin = (record: Ingress.Automation) => {
    change.reset();
    setEditing(record);
  };
  const pending = editing?.createdBy.startsWith("session:") && !editing.enabled;
  const busy = change.isPending;

  return <ConsoleContent>
    <section aria-label="Automations" className="flex min-w-0 flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div><Text as="h1" level="display">Automations</Text><p className="mt-2 text-body text-fg-muted">Decide what arrives, when it runs, and where it goes.</p></div>
        {editing === null && <ActionButton variant="primary" disabled={transport === null || busy} onClick={() => begin({
          id: id(), name: "", enabled: true, createdBy: "owner", triggers: [{ type: "on_demand" }], target: "new", kind: "action",
        })}>New automation</ActionButton>}
      </header>
      {transport === null ? <p role="status">Connect the gateway to manage automations.</p> : (
        <>
          {records.isPending && <p role="status">Loading automations...</p>}
          {records.error && <div role="alert"><p>{records.error.message}</p><ActionButton onClick={() => void records.refetch()}>Retry</ActionButton></div>}
          {change.error && <p role="alert" className="whitespace-pre-wrap break-words rounded-md bg-raised p-4 text-body">{change.error.message}</p>}
          {editing !== null ? <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Text as="h2" level="title">{editing.name || "New automation"}</Text>
              <span className="text-fg-muted text-label">{pending ? "Pending approval" : editing.enabled ? "Enabled" : "Disabled"}</span>
            </div>
            {pending && <aside aria-label="Approval required" className="rounded-md bg-raised p-4 text-body">
              <p>This session-created record cannot run until you approve it. Save changes first, then approve it from the list.</p>
            </aside>}
            <AutomationEditor key={editing.id} record={editing} sessions={sessions} busy={busy} onSave={(record) => change.mutate({ type: "save", record })} onCancel={() => { setEditing(null); change.reset(); }} />
          </> : (
            <ul className="flex flex-col gap-4">
              {records.data?.length === 0 && <li className="text-body text-fg-muted">No automations yet. Create one to connect an event to a session.</li>}
              {records.data?.map((record) => <RecordRow key={record.id} record={record} busy={busy} onEdit={begin} onChange={change.mutate} />)}
            </ul>
          )}
        </>
      )}
    </section>
  </ConsoleContent>;
}

function RecordRow({ record, busy, onEdit, onChange }: {
  readonly record: Ingress.Automation;
  readonly busy: boolean;
  readonly onEdit: (record: Ingress.Automation) => void;
  readonly onChange: (change: Change) => void;
}) {
  const [removing, setRemoving] = useState(false);
  const approval = record.createdBy.startsWith("session:") && !record.enabled;
  return <li className="flex min-w-0 flex-col gap-3 border-line border-b py-4" data-record-id={record.id}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <h2 className="min-w-0 break-words font-medium text-title">{record.name || record.id}</h2>
      <span className="text-fg-muted text-label">{approval ? "Pending approval" : record.enabled ? "Enabled" : "Disabled"}</span>
    </div>
    <p className="break-words text-body text-fg-muted">{record.triggers.length} triggers · {record.target === "new" ? "New session" : record.target} · {record.kind}</p>
    {approval && <p role="status" className="text-body">Proposed by {record.createdBy}. Approval is required before it can run.</p>}
    {removing ? <div className="flex flex-wrap items-center gap-3">
      <p className="text-body">Remove this automation?</p>
      <ActionButton variant="destructive" disabled={busy} onClick={() => onChange({ type: "remove", id: record.id })}>Confirm removal</ActionButton>
      <ActionButton disabled={busy} onClick={() => setRemoving(false)}>Keep automation</ActionButton>
    </div> : <div className="flex flex-wrap gap-3">
      <ActionButton disabled={busy} onClick={() => onEdit(record)}>Edit</ActionButton>
      <ActionButton disabled={busy} onClick={() => onChange({ type: record.enabled ? "disable" : "enable", id: record.id })}>
        {approval ? "Approve and enable" : record.enabled ? "Disable" : "Enable"}
      </ActionButton>
      <ActionButton variant="destructive" disabled={busy} onClick={() => setRemoving(true)}>Remove</ActionButton>
    </div>}
  </li>;
}
