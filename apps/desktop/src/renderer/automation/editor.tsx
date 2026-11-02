import { Ingress } from "@oni/protocol";
import { ActionButton, Field, Input, Select, Textarea } from "@oni/ui";
import { useState } from "react";
import type { LocalSession } from "../state/store";
import { When } from "./when";

export function AutomationEditor({ record, sessions, busy, serverIssues = [], onSave, onCancel }: {
  readonly record: Ingress.Rule;
  readonly sessions: readonly LocalSession[];
  readonly busy: boolean;
  readonly serverIssues?: Ingress.RuleRefused["issues"];
  readonly onSave: (record: Ingress.Rule) => void;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState(record);
  const [issues, setIssues] = useState<NonNullable<Ingress.RuleRefused["issues"]>>([]);
  const errors = new Map<string, string>();
  for (const issue of [...serverIssues, ...issues]) {
    const path = issue.path.join(".").replace(/^(?:args\.)?record(?:\.|$)/, "").replace(/^(when\.from)\.\d+$/, "$1");
    const previous = errors.get(path);
    errors.set(path, previous === undefined ? issue.message : `${previous}\n${issue.message}`);
  }
  const targets = new Map<string, string>(sessions.flatMap((session) => session.durableSessionId === undefined ? [] : [
    [`session:${session.durableSessionId}`, session.title] as const,
  ]));
  if (draft.then.target.startsWith("session:") && !targets.has(draft.then.target)) targets.set(draft.then.target, draft.then.target.slice(8));
  const then = (value: Partial<Ingress.Rule["then"]>) => setDraft({ ...draft, then: { ...draft.then, ...value } });
  return <form aria-label="Rule editor" className="flex min-w-0 flex-col gap-6" noValidate onSubmit={(event) => {
    event.preventDefault();
    const parsed = Ingress.Rule.safeParse(draft);
    setIssues(parsed.success ? [] : parsed.error.issues.map((issue) => ({ path: issue.path.map(String), message: issue.message, code: issue.code })));
    if (parsed.success) onSave(parsed.data);
  }}>
    <fieldset disabled={busy} className="flex min-w-0 flex-col gap-6">
      <Field label="Position" error={errors.get("position")} hint="Rules are evaluated in ascending order, starting at zero."><Input type="number" min={0} step={1} value={draft.position} onInput={(event) => setDraft({ ...draft, position: Number(event.currentTarget.value) })} /></Field>
      <When value={draft.when} errors={errors} onChange={(when) => setDraft({ ...draft, when })} />
      <Field label="Judge" error={errors.get("judge")} hint="Only a yes answer matches; leave blank to skip judgment."><Textarea rows={2} value={draft.judge ?? ""} onInput={(event) => setDraft({ ...draft, judge: event.currentTarget.value || undefined })} /></Field>
      <Field label="Grouping window" error={errors.get("group.windowSeconds")} hint="Messages are grouped within their thread."><Select value={draft.group?.windowSeconds ?? 0} onChange={(event) => setDraft({
        ...draft, group: { windowSeconds: Ingress.WindowSeconds.parse(Number(event.target.value)), by: "thread" },
      })}>{[0, 5, 10, 20, 30, 60].map((seconds) => <option key={seconds} value={seconds}>{seconds === 0 ? "No grouping" : `${seconds} seconds`}</option>)}</Select></Field>
      <fieldset className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
        <legend className="mb-2 font-medium text-title">Delivery</legend>
        <Field label="Target" error={errors.get("then.target")}><Select value={draft.then.target} onChange={(event) => then({ target: event.target.value })}>
          <option value="conversation">This conversation</option><option value="new">New session</option>
          {[...targets].map(([id, title]) => <option key={id} value={id}>{title}</option>)}
        </Select></Field>
        <Field label="Kind" error={errors.get("then.kind")}><Select value={draft.then.kind} onChange={(event) => then({ kind: Ingress.Rule.shape.then.shape.kind.parse(event.target.value) })}><option value="prompt">Prompt</option><option value="action">Action</option></Select></Field>
        <Field label="Reply" error={errors.get("then.reply")}><Select value={draft.then.reply} onChange={(event) => then({ reply: Ingress.Rule.shape.then.shape.reply.parse(event.target.value) })}><option value="auto">Automatic</option><option value="draft">Draft</option><option value="none">None</option></Select></Field>
        <Field label="Reply as instance" error={errors.get("then.as")}><Input value={draft.then.as ?? ""} onInput={(event) => then({ as: event.currentTarget.value || undefined })} /></Field>
        <Field label="Agent id" error={errors.get("then.agent")}><Input value={draft.then.agent ?? ""} onInput={(event) => then({ agent: event.currentTarget.value || undefined })} /></Field>
        <Field label="Maximum runs per day" error={errors.get("then.maxRunsPerDay")}><Input type="number" min={1} step={1} value={draft.then.maxRunsPerDay ?? ""} onInput={(event) => then({ maxRunsPerDay: event.currentTarget.value === "" ? undefined : Number(event.currentTarget.value) })} /></Field>
      </fieldset>
      <Field label="Instructions" error={errors.get("then.instructions")} hint="Instructions for a new session."><Textarea rows={3} value={draft.then.instructions ?? ""} onInput={(event) => then({ instructions: event.currentTarget.value || undefined })} /></Field>
    </fieldset>
    {errors.size > 0 && <div role="alert" className="rounded-md bg-raised p-4 text-body"><p>Review the rule before saving.</p><ul className="list-inside list-disc">{[...errors].map(([path, message]) => <li key={path}>{message}</li>)}</ul></div>}
    <div className="flex flex-wrap gap-3">
      <ActionButton variant="primary" type="submit" disabled={busy}>{busy ? "Saving..." : "Save rule"}</ActionButton>
      <ActionButton disabled={busy} onClick={onCancel}>Cancel</ActionButton>
    </div>
  </form>;
}
