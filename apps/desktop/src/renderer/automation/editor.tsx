import { Ingress } from "@openomni/protocol";
import { ActionButton, Field, Input, Select, Textarea } from "@openomni/ui";
import { useState } from "react";
import type { LocalSession } from "../state/store";
import { Conditions } from "./conditions";
import { Triggers } from "./triggers";

export function AutomationEditor({ record, sessions, busy, onSave, onCancel }: {
  readonly record: Ingress.Automation;
  readonly sessions: readonly LocalSession[];
  readonly busy: boolean;
  readonly onSave: (record: Ingress.Automation) => void;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState(record);
  const [issues, setIssues] = useState<readonly string[]>([]);
  const targets = new Map<string, string>(sessions.flatMap((session) => session.durableSessionId === undefined ? [] : [
    [`session:${session.durableSessionId}`, session.title] as const,
  ]));
  if (draft.target !== "new" && !targets.has(draft.target)) targets.set(draft.target, draft.target.slice(8));

  return <form aria-label="Automation editor" className="flex min-w-0 flex-col gap-6" noValidate onSubmit={(event) => {
    event.preventDefault();
    const parsed = Ingress.Automation.safeParse(draft);
    setIssues(parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
    if (parsed.success) onSave(parsed.data);
  }}>
    <Field label="Name"><Input disabled={busy} value={draft.name} onInput={(event) => setDraft({ ...draft, name: event.currentTarget.value })} /></Field>
    <fieldset disabled={busy} className="flex min-w-0 flex-col gap-6">
      <Triggers value={draft.triggers} onChange={(triggers) => setDraft({ ...draft, triggers })} />
      <Conditions value={draft.conditions ?? {}} onChange={(conditions) => setDraft({ ...draft, conditions })} />
      <Field label="Run when" hint="Ask a question the judge must answer before running. Leave blank to skip the judge.">
        <Textarea rows={2} value={draft.runWhen ?? ""} onInput={(event) => setDraft({ ...draft, runWhen: event.currentTarget.value || undefined })} placeholder="Does this need my attention?" />
      </Field>
      <fieldset className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
        <legend className="mb-2 font-medium text-title">Grouping</legend>
        <Field label="Window"><Select value={draft.grouping?.windowSeconds ?? 0} onChange={(event) => setDraft({
          ...draft, grouping: { windowSeconds: Ingress.WindowSeconds.parse(Number(event.target.value)), by: draft.grouping?.by ?? "thread" },
        })}>{[0, 5, 10, 20, 30, 60].map((seconds) => <option key={seconds} value={seconds}>{seconds === 0 ? "No grouping" : `${seconds} seconds`}</option>)}</Select></Field>
        <Field label="Group by"><Select value={draft.grouping?.by ?? "thread"} onChange={(event) => setDraft({
          ...draft, grouping: { windowSeconds: draft.grouping?.windowSeconds ?? 0, by: Ingress.Automation.shape.grouping.unwrap().shape.by.parse(event.target.value) },
        })}><option value="thread">Thread</option><option value="channel">Channel</option><option value="author">Author</option></Select></Field>
      </fieldset>
      <fieldset className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
        <legend className="mb-2 font-medium text-title">Delivery</legend>
        <Field label="Target" hint="Start a new session or deliver into an existing one."><Select value={draft.target} onChange={(event) => setDraft({ ...draft, target: event.target.value })}>
          <option value="new">New session</option>
          {[...targets].map(([id, title]) => <option key={id} value={id}>{title}</option>)}
        </Select></Field>
        <Field label="Kind" hint="Prompt resets the attention counter. Action carries evidence."><Select value={draft.kind} onChange={(event) => setDraft({
          ...draft, kind: Ingress.Automation.shape.kind.parse(event.target.value),
        })}><option value="prompt">Prompt</option><option value="action">Action</option></Select></Field>
      </fieldset>
      <Field label="Instructions" hint="Instructions for a new session."><Textarea rows={3} value={draft.instructions ?? ""} onInput={(event) => setDraft({ ...draft, instructions: event.currentTarget.value || undefined })} /></Field>
      <Field label="Maximum runs per day" hint="Leave blank for no record-level limit."><Input type="number" min={1} step={1} value={draft.limits?.maxRunsPerDay ?? ""} onInput={(event) => setDraft({
        ...draft, limits: event.currentTarget.value === "" ? undefined : { maxRunsPerDay: Number(event.currentTarget.value) },
      })} /></Field>
    </fieldset>
    {issues.length > 0 && <div role="alert" className="rounded-md bg-raised p-4 text-body"><p>Review the record before saving.</p><ul className="list-inside list-disc">{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul></div>}
    <div className="flex flex-wrap gap-3">
      <ActionButton variant="primary" type="submit" disabled={busy}>{busy ? "Saving..." : "Save automation"}</ActionButton>
      <ActionButton disabled={busy} onClick={onCancel}>Cancel</ActionButton>
    </div>
  </form>;
}
