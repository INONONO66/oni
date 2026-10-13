import type { Ingress } from "@openomni/protocol";
import { Field, Select, Textarea } from "@openomni/ui";

const LISTS = [
  ["channels", "Channels"], ["users", "Users"], ["threads", "Threads"],
  ["contains", "Contains"], ["excludes", "Excludes"], ["regex", "Regular expressions"],
] as const;
const FLAGS = [["includeBots", "Include bots"], ["dm", "Direct messages"], ["mentionOnly", "Mentions only"]] as const;

export function Conditions({ value, onChange }: {
  readonly value: Ingress.Conditions;
  readonly onChange: (conditions: Ingress.Conditions) => void;
}) {
  return <fieldset className="flex min-w-0 flex-col gap-4">
    <legend className="mb-2 font-medium text-title">Conditions</legend>
    <p className="text-body text-fg-muted">Every populated condition must match (AND). Within each list, any entry can match. Enter one value per line.</p>
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {LISTS.map(([name, label]) => {
        return <Field label={label} key={name}><Textarea rows={2} value={value[name]?.join("\n") ?? ""} onInput={(event) => {
          const entries = event.currentTarget.value.split("\n");
          onChange({ ...value, [name]: event.currentTarget.value === "" ? undefined : entries });
        }} /></Field>;
      })}
      {FLAGS.map(([name, label]) => {
        return <Field key={name} label={label}><Select value={value[name] === undefined ? "" : String(value[name])} onChange={(event) => onChange({
          ...value, [name]: event.target.value === "" ? undefined : event.target.value === "true",
        })}><option value="">Not specified</option><option value="true">Yes</option><option value="false">No</option></Select></Field>;
      })}
    </div>
  </fieldset>;
}
