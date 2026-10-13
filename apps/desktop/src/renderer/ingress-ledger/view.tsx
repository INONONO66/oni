import { Ingress } from "@openomni/protocol";
import { ActionButton, ConsoleContent, Field, Input, Select, Text } from "@openomni/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { GatewayChatTransport } from "../chat/gateway-transport";
import { automationLedgerOptions } from "../state/queries";
import { LedgerRows } from "./rows";

export function IngressLedgerView({ transport, now, onOpenSession }: {
  readonly transport: GatewayChatTransport | null;
  readonly now: number;
  readonly onOpenSession: (id: string) => void;
}) {
  const [filter, setFilter] = useState<Partial<Ingress.AutomationLedgerFilter>>({});
  const [error, setError] = useState<string | null>(null);
  const ledger = useQuery(automationLedgerOptions(transport, filter));
  return <ConsoleContent>
    <section aria-label="Ingress ledger" className="flex min-w-0 flex-col gap-6">
      <header><Text as="h1" level="display">Ingress ledger</Text><p className="mt-2 text-body text-fg-muted">Why an event ran, waited, or never reached a session. Evidence digests only.</p></header>
      <form aria-label="Ledger filters" className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2" noValidate onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const since = String(data.get("since") ?? "");
        const until = String(data.get("until") ?? "");
        const parsed = Ingress.AutomationLedgerFilter.safeParse({
          surface: data.get("surface") || undefined,
          decision: data.get("decision") || undefined,
          recordId: data.get("recordId") || undefined,
          since: since ? new Date(since).getTime() : undefined,
          until: until ? new Date(until).getTime() : undefined,
        });
        if (!parsed.success) { setError("Enter a valid time range and filter values."); return; }
        if (parsed.data.since !== undefined && parsed.data.until !== undefined && parsed.data.since > parsed.data.until) {
          setError("Start time must be before end time."); return;
        }
        setError(null);
        setFilter(parsed.data);
      }}>
        <Field label="Surface"><Input name="surface" placeholder="All surfaces" /></Field>
        <Field label="Decision"><Select name="decision" defaultValue=""><option value="">All decisions</option>{Ingress.AutomationLedgerFilter.shape.decision.unwrap().options.map((decision) => <option key={decision} value={decision}>{decision}</option>)}</Select></Field>
        <Field label="Record ID"><Input name="recordId" placeholder="All records" /></Field>
        <Field label="Since"><Input name="since" type="datetime-local" /></Field>
        <Field label="Until"><Input name="until" type="datetime-local" /></Field>
        <div className="flex flex-wrap items-end gap-3"><ActionButton type="submit" variant="primary" disabled={transport === null}>Apply filters</ActionButton><ActionButton type="reset" onClick={() => { setFilter({}); setError(null); }}>Clear</ActionButton></div>
      </form>
      {error && <p role="alert">{error}</p>}
      {transport === null ? <p role="status">Connect the gateway to read the ingress ledger.</p> : (
        <>
          {ledger.isPending && <p role="status">Loading ingress decisions...</p>}
          {ledger.error && <div role="alert"><p>{ledger.error.message}</p><ActionButton onClick={() => void ledger.refetch()}>Retry</ActionButton></div>}
          {ledger.data?.rows.length === 0 && <p role="status" className="text-body text-fg-muted">No events match these filters. Try a wider time range.</p>}
          {ledger.data && ledger.data.rows.length > 0 && <LedgerRows rows={ledger.data.rows} related={ledger.data.related} now={now} onOpenSession={onOpenSession} />}
          {ledger.data?.rows.length === (filter.limit ?? 200) && <p className="text-body text-fg-muted">Showing the newest {filter.limit ?? 200} rows. Narrow the time range to inspect earlier events.</p>}
        </>
      )}
    </section>
  </ConsoleContent>;
}
