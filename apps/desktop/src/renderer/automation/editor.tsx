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
  const delivery = draft.outcome.kind === "deliver" ? draft.outcome : undefined;
  const targets = new Map<string, string>(sessions.flatMap((session) => session.durableSessionId === undefined ? [] : [
    [`session:${session.durableSessionId}`, session.title] as const,
  ]));
  if (delivery?.target.startsWith("session:") && !targets.has(delivery.target)) targets.set(delivery.target, delivery.target.slice(8));
  const updateDelivery = (value: Partial<Extract<Ingress.Rule["outcome"], { kind: "deliver" }>>) => {
    if (delivery !== undefined) setDraft({ ...draft, outcome: { ...delivery, ...value } });
  };
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
      <Field label="Outcome" error={errors.get("outcome.kind")}><Select value={draft.outcome.kind} onChange={(event) => {
        const kind = event.target.value;
        setDraft({ ...draft, outcome: kind === "deliver"
          ? { kind, target: "conversation", deliveryKind: "prompt", reply: "auto" }
          : Ingress.Rule.shape.outcome.parse({ kind }) });
      }}><option value="deliver">Deliver</option><option value="record">Record only</option><option value="drop">Drop</option></Select></Field>
      {delivery !== undefined && <><fieldset className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
        <legend className="mb-2 font-medium text-title">Delivery</legend>
        <Field label="Target" error={errors.get("outcome.target")}><Select value={delivery.target} onChange={(event) => updateDelivery({ target: event.target.value })}>
          <option value="conversation">This conversation</option><option value="new">New session</option>
          {[...targets].map(([id, title]) => <option key={id} value={id}>{title}</option>)}
        </Select></Field>
        <Field label="Kind" error={errors.get("outcome.deliveryKind")}><Select value={delivery.deliveryKind} onChange={(event) => updateDelivery({ deliveryKind: Ingress.Rule.shape.outcome.options[2].shape.deliveryKind.parse(event.target.value) })}><option value="prompt">Prompt</option><option value="action">Action</option></Select></Field>
        <Field label="Reply" error={errors.get("outcome.reply")}><Select value={delivery.reply} onChange={(event) => updateDelivery({ reply: Ingress.Rule.shape.outcome.options[2].shape.reply.parse(event.target.value) })}><option value="auto">Automatic</option><option value="draft">Draft</option><option value="none">None</option></Select></Field>
        <Field label="Reply as instance" error={errors.get("outcome.as")}><Input value={delivery.as ?? ""} onInput={(event) => updateDelivery({ as: event.currentTarget.value || undefined })} /></Field>
        <Field label="Agent id" error={errors.get("outcome.agent")}><Input value={delivery.agent ?? ""} onInput={(event) => updateDelivery({ agent: event.currentTarget.value || undefined })} /></Field>
        <Field label="Maximum runs per day" error={errors.get("outcome.maxRunsPerDay")}><Input type="number" min={1} step={1} value={delivery.maxRunsPerDay ?? ""} onInput={(event) => updateDelivery({ maxRunsPerDay: event.currentTarget.value === "" ? undefined : Number(event.currentTarget.value) })} /></Field>
      </fieldset>
      <Field label="Instructions" error={errors.get("outcome.instructions")} hint="Instructions for a new session."><Textarea rows={3} value={delivery.instructions ?? ""} onInput={(event) => updateDelivery({ instructions: event.currentTarget.value || undefined })} /></Field></> }
    </fieldset>
    {errors.size > 0 && <div role="alert" className="rounded-md bg-raised p-4 text-body"><p>Review the rule before saving.</p><ul className="list-inside list-disc">{[...errors].map(([path, message]) => <li key={path}>{message}</li>)}</ul></div>}
    <div className="flex flex-wrap gap-3">
      <ActionButton variant="primary" type="submit" disabled={busy}>{busy ? "Saving..." : "Save rule"}</ActionButton>
      <ActionButton disabled={busy} onClick={onCancel}>Cancel</ActionButton>
    </div>
  </form>;
}
