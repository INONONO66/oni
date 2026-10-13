import type { Ingress } from "@openomni/protocol";
import { relativeTime } from "@openomni/ui";

type Row = Ingress.RoutingDecisionPayload;
type AutomationRow = Extract<Row, { stage: "automation" }>;
const VERDICT = { yes: "Accepted", no: "Rejected", unknown: "Indecisive" } as const;

function SessionLink({ row, rows, onOpenSession }: {
  readonly row: Row;
  readonly rows: readonly Row[];
  readonly onOpenSession: (id: string) => void;
}) {
  const winner = row.stage === "automation" && row.decision === "superseded"
    ? rows.find((candidate) => candidate.inboundId === row.inboundId && candidate.stage !== "automation" && candidate.outcome === "route" && (candidate.sessionId !== undefined || candidate.target?.startsWith("session:")))
    : undefined;
  const linked = row.stage === "automation" && row.decision === "superseded" ? winner : row;
  const sessionId = linked?.target?.startsWith("session:") ? linked.target.slice(8) : linked?.sessionId;
  if (sessionId === undefined) return null;
  return <button className="focus-ring min-h-10 break-all text-left text-body underline underline-offset-4" type="button" onClick={() => onOpenSession(sessionId)}>
    {row.stage === "automation" && row.decision === "superseded" ? "Winning prompt" : "Open session"}
    {row.stage === "automation" && row.actionSeq !== undefined ? ` · action ${row.actionSeq}` : ""} · {sessionId}
  </button>;
}

function DecisionDetails({ row, rows, visibleIds, onOpenSession }: {
  readonly row: AutomationRow;
  readonly rows: readonly Row[];
  readonly visibleIds: ReadonlySet<string>;
  readonly onOpenSession: (id: string) => void;
}) {
  const group = row.factsUsed.find((fact) => fact.startsWith("group:"));
  const firing = row.reason.match(/(?:^|\s)firing:([^\s]+)/)?.[1];
  const firingRow = firing === undefined || group === undefined ? undefined : rows.find((candidate) =>
    candidate.stage === "automation" && candidate.decision === "matched" && candidate.factsUsed.includes(group),
  );
  return <details className="min-w-0 text-body">
    <summary className="focus-ring cursor-pointer py-2 font-medium">{row.decision}</summary>
    <dl className="flex min-w-0 flex-col gap-2 py-3">
      <dt className="text-fg-muted">Decided by</dt><dd className="break-all">{row.by}</dd>
      <dt className="text-fg-muted">Reason</dt><dd className="whitespace-pre-wrap break-words">{row.reason}</dd>
      <dt className="text-fg-muted">Facts used</dt><dd><ul className="list-inside list-disc">{[...new Set(row.factsUsed)].map((fact) => <li className="break-all" key={fact}>{fact}</li>)}</ul></dd>
      <dt className="text-fg-muted">Digest</dt><dd className="break-all font-mono text-label">{row.factsDigest}</dd>
      {row.runWhen && <><dt className="text-fg-muted">Run when</dt><dd data-verdict={row.runWhen.verdict}><strong>{VERDICT[row.runWhen.verdict]}</strong><p className="break-words">{row.runWhen.reason}</p></dd></>}
      {group && <><dt className="text-fg-muted">Grouping window key</dt><dd className="break-all">{group.slice(6)}</dd></>}
      {firing && <><dt className="text-fg-muted">Delivered message</dt><dd className="break-all">{firing}</dd></>}
      {firingRow && <><dt className="text-fg-muted">Firing event</dt><dd className="break-all">
        {visibleIds.has(firingRow.inboundId) ? <a className="focus-ring underline" href={`#ingress-${encodeURIComponent(firingRow.inboundId)}`}>{firingRow.inboundId}</a> : <>
          {firingRow.inboundId}
          <SessionLink row={firingRow} rows={rows} onOpenSession={onOpenSession} />
        </>}
      </dd></>}
    </dl>
    <SessionLink row={row} rows={rows} onOpenSession={onOpenSession} />
  </details>;
}

export function LedgerRows({ rows, related, now, onOpenSession }: {
  readonly rows: readonly Row[];
  readonly related: readonly Row[];
  readonly now: number;
  readonly onOpenSession: (id: string) => void;
}) {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const group = groups.get(row.inboundId) ?? [];
    group.push(row);
    groups.set(row.inboundId, group);
  }
  for (const [id, group] of groups) {
    if (!group.some((row) => row.stage === "automation" && row.decision === "deduped")) continue;
    const originals = related.filter((row) => row.inboundId === id &&
      !(row.stage === "automation" && row.decision === "deduped"));
    groups.set(id, [
      ...originals,
      ...group.filter((row) => !originals.some((original) => JSON.stringify(original) === JSON.stringify(row))),
    ]);
  }
  const visibleIds = new Set(groups.keys());
  return <table className="w-full table-fixed text-left text-body">
    <caption className="sr-only">Ingress decisions, newest events first</caption>
    <thead><tr><th className="w-1/3 pb-3 font-medium" scope="col">Event</th><th className="pb-3 font-medium" scope="col">Decision and evidence</th></tr></thead>
    {[...groups].map(([id, group]) => <tbody id={`ingress-${encodeURIComponent(id)}`} key={id} className="border-line border-t">
      <tr><th className="py-4 pr-4 align-top font-normal" scope="rowgroup">
        <div className="break-all">{group[0]?.surface}</div>
        <div className="break-all text-fg-muted text-label">{id}</div>
        <time className="text-fg-muted text-label" dateTime={new Date(group[0]?.time ?? now).toISOString()}>{relativeTime(group[0]?.time ?? now, now)}</time>
      </th><td className="min-w-0 py-2 align-top">
        {[...group].sort((a, b) => Number(a.stage === "automation" && a.decision === "deduped") - Number(b.stage === "automation" && b.decision === "deduped")).map((row) => (
          <div key={JSON.stringify(row)} className={row.stage === "automation" && row.decision === "deduped" ? "ml-4" : ""} data-decision={row.stage === "automation" ? row.decision : row.outcome}>
            {row.stage === "automation" ? <DecisionDetails row={row} rows={related} visibleIds={visibleIds} onOpenSession={onOpenSession} /> : <><p className="py-2">{row.reason}</p><SessionLink row={row} rows={related} onOpenSession={onOpenSession} /></>}
          </div>
        ))}
      </td></tr>
    </tbody>)}
  </table>;
}
