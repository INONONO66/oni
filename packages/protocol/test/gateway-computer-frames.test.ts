import { expect, test } from "bun:test";
import { Gateway } from "../src/index";

test("surface frame identifies the machine once parsed", () => {
  expect(Gateway.Surface.parse({ kind: "surface", machineId: "desk" }))
    .toEqual({ kind: "surface", machineId: "desk" });
  expect(Gateway.Surface.safeParse({ kind: "surface", machineId: "" }).success).toBe(false);
});

test("lease frame preserves paused state and foreground purpose", () => {
  expect(Gateway.Lease.parse({
    type: "lease", sessionId: "resident", machineId: "desk",
    apps: ["com.example.Editor"], state: "paused", pauseReason: "human_input",
    foreground: { purpose: "edit draft", expiresAt: 5000 }, expiresAt: 6000,
  })).toMatchObject({
    state: "paused", pauseReason: "human_input",
    foreground: { purpose: "edit draft", expiresAt: 5000 },
  });
});
