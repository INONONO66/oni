import { Ingress } from "@openomni/protocol";
import { ActionButton, Field, Input, Select } from "@openomni/ui";
import { useRef, useState } from "react";
import { z } from "zod";

const TriggerType = z.enum(Ingress.Trigger.options.map((option) => option.shape.type.value));

const DEFAULT_TRIGGER = {
  schedule: { type: "schedule", cron: "", tz: "UTC" },
  message: { type: "message", surface: "", event: "message" },
  webhook: { type: "webhook", secretRef: "" },
  github: { type: "github", event: "" },
  on_demand: { type: "on_demand" },
} as const satisfies Record<Ingress.Trigger["type"], Ingress.Trigger>;

function TriggerFields({ trigger, onChange }: {
  readonly trigger: Ingress.Trigger;
  readonly onChange: (trigger: Ingress.Trigger) => void;
}) {
  switch (trigger.type) {
    case "schedule":
      return <>
        <Field label="Cron expression"><Input value={trigger.cron} onInput={(event) => onChange({ ...trigger, cron: event.currentTarget.value })} placeholder="0 9 * * 1-5" /></Field>
        <Field label="Time zone"><Input value={trigger.tz} onInput={(event) => onChange({ ...trigger, tz: event.currentTarget.value })} /></Field>
      </>;
    case "message":
      return <>
        <Field label="Surface"><Input value={trigger.surface} onInput={(event) => onChange({ ...trigger, surface: event.currentTarget.value })} placeholder="discord" /></Field>
        <Field label="Event"><Select value={trigger.event} onChange={(event) => onChange({ ...trigger, event: Ingress.Trigger.options[1].shape.event.parse(event.target.value) })}>
          <option value="message">Message</option><option value="reaction">Reaction</option><option value="mention">Mention</option>
        </Select></Field>
      </>;
    case "webhook":
      return <Field label="Secret reference" hint="A stored reference, never the secret itself."><Input value={trigger.secretRef} onInput={(event) => onChange({ ...trigger, secretRef: event.currentTarget.value })} /></Field>;
    case "github":
      return <Field label="GitHub event"><Input value={trigger.event} onInput={(event) => onChange({ ...trigger, event: event.currentTarget.value })} placeholder="pull_request.opened" /></Field>;
    case "on_demand":
      return <p className="text-body text-fg-muted">Runs when explicitly invoked.</p>;
  }
}

export function Triggers({ value, onChange }: {
  readonly value: readonly Ingress.Trigger[];
  readonly onChange: (triggers: Ingress.Trigger[]) => void;
}) {
  const [keys, setKeys] = useState(() => value.map((_, index) => index));
  const nextKey = useRef(value.length);
  return <fieldset className="flex min-w-0 flex-col gap-4">
    <legend className="mb-2 font-medium text-title">Triggers</legend>
    <p className="text-body text-fg-muted">Any trigger can start this automation (OR).</p>
    {value.map((trigger, index) => (
      <fieldset className="flex min-w-0 flex-col gap-3 rounded-md bg-sunken p-4" key={keys[index]}>
        <legend className="text-fg-muted text-label">Trigger {index + 1}</legend>
        <Field label="Trigger type"><Select value={trigger.type} onChange={(event) => {
          const type = TriggerType.parse(event.target.value);
          onChange(value.map((row, i) => i === index ? DEFAULT_TRIGGER[type] : row));
        }}>
          <option value="message">Message</option><option value="schedule">Schedule</option><option value="webhook">Webhook</option><option value="github">GitHub</option><option value="on_demand">On demand</option>
        </Select></Field>
        <TriggerFields trigger={trigger} onChange={(next) => onChange(value.map((row, i) => i === index ? next : row))} />
        <div><ActionButton onClick={() => { setKeys(keys.filter((_, i) => i !== index)); onChange(value.filter((_, i) => i !== index)); }}>Remove trigger {index + 1}</ActionButton></div>
      </fieldset>
    ))}
    <div><ActionButton onClick={() => { setKeys([...keys, nextKey.current++]); onChange([...value, DEFAULT_TRIGGER.message]); }}>Add trigger</ActionButton></div>
  </fieldset>;
}
