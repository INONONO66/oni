import { describe, expect, test } from "bun:test";
import { SIDEBAR_WIDTH } from "@oni/ui";
import {
  readShellPreferences,
  SIDEBAR_OPEN_KEY,
  SIDEBAR_WIDTH_KEY,
  writeShellPreferences,
} from "../src/renderer/state/shell-preferences";

const storage = (entries: Record<string, string> = {}) => {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    map,
  };
};

describe("shell preferences at the storage boundary", () => {
  test("Given nothing stored, When read, Then the sidebar is open at the default width", () => {
    expect(readShellPreferences(storage())).toEqual({ open: true, width: SIDEBAR_WIDTH.default });
  });

  test("Given garbage, When read, Then the width falls back and the flag stays open", () => {
    const read = readShellPreferences(
      storage({ [SIDEBAR_WIDTH_KEY]: "wide", [SIDEBAR_OPEN_KEY]: "maybe" }),
    );
    expect(read).toEqual({ open: true, width: SIDEBAR_WIDTH.default });
  });

  test("Given an out-of-range width and a closed flag, When read, Then the width is clamped and the flag honoured", () => {
    const read = readShellPreferences(
      storage({ [SIDEBAR_WIDTH_KEY]: "9999", [SIDEBAR_OPEN_KEY]: "false" }),
    );
    expect(read).toEqual({ open: false, width: SIDEBAR_WIDTH.max });
  });

  test("Given preferences, When written then read, Then they round-trip", () => {
    const store = storage();
    writeShellPreferences(store, { open: false, width: 300 });
    expect(readShellPreferences(store)).toEqual({ open: false, width: 300 });
  });
});
