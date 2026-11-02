import { Ingress } from "@oni/protocol";
import { Field, Input, Select, Textarea } from "@oni/ui";

const FLAGS = [["dm", "Direct message"], ["addressed", "Addressed"], ["isBot", "Bot author"]] as const;

export function When({ value, errors, onChange }: {
  readonly value: Ingress.Rule["when"];
  readonly errors: ReadonlyMap<string, string>;
  readonly onChange: (when: Ingress.Rule["when"]) => void;
}) {
  return <fieldset className="flex min-w-0 flex-col gap-4">
    <legend className="mb-2 font-medium text-title">When</legend>
    <p className="text-body text-fg-muted">Every specified field must match. The first matching rule runs.</p>
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field label="Instance" error={errors.get("when.instance")}><Input value={value.instance} onInput={(event) => onChange({ ...value, instance: event.currentTarget.value })} /></Field>
      <Field label="Channel" error={errors.get("when.channel")}><Input value={value.channel ?? ""} onInput={(event) => onChange({ ...value, channel: event.currentTarget.value || undefined })} /></Field>
      <Field label="From" error={errors.get("when.from")} hint="One sender id per line; leave blank for any sender."><Textarea rows={2} value={value.from?.join("\n") ?? ""} onInput={(event) => onChange({
        ...value, from: event.currentTarget.value === "" ? undefined : event.currentTarget.value.split("\n"),
      })} /></Field>
      <Field label="Event" error={errors.get("when.event")}><Select value={value.event ?? ""} onChange={(event) => onChange({
        ...value, event: event.target.value === "" ? undefined : Ingress.Rule.shape.when.shape.event.unwrap().parse(event.target.value),
      })}><option value="">Any event</option><option value="message">Message</option><option value="reaction">Reaction</option></Select></Field>
      {FLAGS.map(([name, label]) => <Field key={name} label={label} error={errors.get(`when.${name}`)}><Select value={value[name] === undefined ? "" : String(value[name])} onChange={(event) => onChange({
        ...value, [name]: event.target.value === "" ? undefined : event.target.value === "true",
      })}><option value="">Not specified</option><option value="true">Yes</option><option value="false">No</option></Select></Field>)}
    </div>
  </fieldset>;
}
