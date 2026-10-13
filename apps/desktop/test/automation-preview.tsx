import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ActionButton } from "@openomni/ui";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AutomationView } from "../src/renderer/automation/view";
import { IngressLedgerView } from "../src/renderer/ingress-ledger/view";
import { automationRecord, createAutomationFixture, ledgerRows } from "./helpers/automation-wire";
import "../src/renderer/styles.css";

const rows = [...ledgerRows];
const fixture = createAutomationFixture([
  automationRecord,
  { ...automationRecord, id: "pending", name: "Triage support mentions", enabled: false, createdBy: "session:resident" },
], rows);
const client = new QueryClient();
const sessions = [{
  id: "main-local", durableSessionId: "main", title: "Main session", titleSource: "prompt" as const,
  projectId: null, createdAt: 0, lastActivityAt: 0, unread: false, pinned: false, snoozedUntil: null,
}];
let sequence = 0;

function AutomationPreview() {
  const [ledger, setLedger] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);
  return <QueryClientProvider client={client}>
    <div className="flex h-full min-h-0 flex-col">
      <nav aria-label="Preview views" className="flex flex-wrap gap-3 border-line border-b p-4">
        <ActionButton onClick={() => setLedger(false)}>Automations</ActionButton>
        <ActionButton onClick={() => setLedger(true)}>Ingress ledger</ActionButton>
        <ActionButton onClick={() => {
          const record = [...fixture.records.values()].at(-1);
          if (record === undefined || !record.enabled) return;
          rows.unshift({
            traceId: "preview", inboundId: `fixture-${record.id}`, time: 900, surface: "fixture",
            mode: "internal", stage: "automation", outcome: "record", decision: "matched",
            by: `automation/${record.id}`, factsDigest: "sha256:fixture", factsUsed: [`kind:${record.kind}`],
            reason: `Fixture ${record.kind} delivered`, actionSeq: 4,
            target: record.target === "new" ? `session:created-${record.id}` : record.target,
          });
          void client.invalidateQueries();
          setLedger(true);
        }}>Fire latest fixture event</ActionButton>
        {opened && <p role="status" className="text-body">Opened session: {opened}</p>}
      </nav>
      {ledger ? <IngressLedgerView transport={fixture.transport} now={1000} onOpenSession={setOpened} /> : <AutomationView transport={fixture.transport} sessions={sessions} id={() => `preview-${++sequence}`} />}
    </div>
  </QueryClientProvider>;
}

const root = document.getElementById("root");
if (root === null) throw new Error("Missing preview root");
createRoot(root).render(<AutomationPreview />);
