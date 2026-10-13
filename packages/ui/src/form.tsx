import { cloneElement, useId, type ComponentProps, type ReactElement } from "react";
import { UI_NAMES } from "./names";

const CONTROL = "focus-ring min-h-10 w-full min-w-0 rounded-md bg-raised px-3 py-2 text-body text-fg disabled:opacity-50";

export function Field({ label, hint, error, children }: {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
  readonly children: ReactElement<{ id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean }>;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex min-w-0 flex-col gap-2 text-body" data-ui={UI_NAMES.Field}>
      <span className="font-medium">{label}</span>
      {cloneElement(children, {
        id,
        "aria-invalid": error ? true : undefined,
        "aria-describedby": [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") || undefined,
      })}
      {hint && <span id={`${id}-hint`} className="text-fg-muted text-label">{hint}</span>}
      {error && <span id={`${id}-error`} role="alert" className="whitespace-pre-wrap break-words text-label">{error}</span>}
    </label>
  );
}

export function Input(props: ComponentProps<"input">) {
  return <input {...props} className={CONTROL} data-ui={UI_NAMES.Input} />;
}

export function Select(props: ComponentProps<"select">) {
  return <select {...props} className={CONTROL} data-ui={UI_NAMES.Select} />;
}

export function Textarea(props: ComponentProps<"textarea">) {
  return <textarea {...props} className={`${CONTROL} resize-y`} data-ui={UI_NAMES.Textarea} />;
}

export function ActionButton({ variant = "secondary", ...props }: ComponentProps<"button"> & {
  readonly variant?: "primary" | "secondary" | "destructive";
}) {
  const tone = {
    primary: "bg-accent text-accent-fg hover:opacity-90",
    secondary: "bg-raised text-fg hover:bg-hover",
    destructive: "bg-raised text-diff-remove hover:bg-hover",
  }[variant];
  return <button type="button" {...props} className={`focus-ring min-h-10 rounded-md px-3 py-2 font-medium text-body active:opacity-80 disabled:opacity-50 ${tone}`} data-ui={UI_NAMES.ActionButton} />;
}
