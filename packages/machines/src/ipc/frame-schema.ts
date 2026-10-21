import type { PlainValue } from "@oni/protocol";
import { z } from "zod";

/** JSON.parse preserves -0 and can overflow numbers; the persisted-fact schema rejects both. */
export const FrameSchema = z.custom<PlainValue>(isFrameValue);

type FrameEntry = boolean | object;

function frameEntry<T>(value: T): FrameEntry {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number" && !Number.isNaN(value)) return true;
  if (typeof value !== "object" || value === null) return false;
  return value;
}

function isFrameValue<T>(input: T): boolean {
  const pending: FrameEntry[] = [frameEntry(input)];
  const seen = new Set<object>();
  for (let entry = pending.pop(); entry !== undefined; entry = pending.pop()) {
    if (entry === true) continue;
    if (entry === false) return false;
    if (seen.has(entry)) return false;
    seen.add(entry);
    const children = frameChildren(entry);
    if (children === undefined) return false;
    for (const child of children) pending.push(child);
  }
  return true;
}

function frameChildren(value: object): FrameEntry[] | undefined {
  if (!isContainer(value)) return undefined;
  const children: FrameEntry[] = [];
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return undefined;
    children.push(frameEntry(descriptor.value));
  }
  return children;
}

function isContainer(value: object): boolean {
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  if (array && Object.keys(value).length !== value.length) return false;
  return true;
}
