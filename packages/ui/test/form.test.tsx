import { expect, test } from "bun:test";
import { ActionButton, Field, Input, Select, Textarea } from "../src/form";
import { attributes } from "./markup";

test("fields bind labels and help text to each native control", () => {
  for (const control of [<Input key="input" />, <Select key="select"><option value="one">One</option></Select>, <Textarea key="textarea" />]) {
    const tags = attributes(<Field label="Setting" hint="Help" error="Invalid value">{control}</Field>);
    const label = tags.find((tag) => tag["data-ui"] === "Field");
    const input = tags.find((tag) => tag["aria-describedby"] !== undefined);
    expect(input?.id).toBe(label?.for);
    expect(input?.["aria-invalid"]).toBe("true");
    const descriptions = input?.["aria-describedby"]?.split(" ") ?? [];
    expect(descriptions).toHaveLength(2);
    for (const id of descriptions) expect(tags.some((tag) => tag.id === id)).toBe(true);
    expect(tags.find((tag) => tag.role === "alert")?.id).toBe(descriptions[1]);
  }
});

test("action buttons default to non-submitting controls and preserve explicit disabled submit semantics", () => {
  expect(attributes(<ActionButton>Cancel</ActionButton>, "button")[0]?.type).toBe("button");
  const submit = attributes(<ActionButton type="submit" variant="primary" disabled>Save</ActionButton>, "button")[0];
  expect(submit?.type).toBe("submit");
  expect(submit?.disabled).toBe("");
  expect(attributes(<ActionButton variant="destructive">Remove</ActionButton>, "button")[0]?.type).toBe("button");
});
