import { expect, test } from "bun:test";
import { AlarmRuntimeError, commandSource } from "../src/composition/watch-sources";
import { residentSuite } from "./helpers/resident-suite";

const suite = residentSuite();

test("command source refuses construction without the PTY builtin", () => {
  const terminal = Bun.Terminal;
  Reflect.set(Bun, "Terminal", undefined);
  try {
    expect(() =>
      commandSource(
        "exit 0",
        () => undefined,
        () => undefined,
        () => undefined,
      ),
    ).toThrow(AlarmRuntimeError);
  } finally {
    Reflect.set(Bun, "Terminal", terminal);
  }
});

test("app boot refuses a missing PTY builtin with a typed runtime requirement", async () => {
  const config = suite.config("alarm-runtime-");
  const terminal = Bun.Terminal;
  Reflect.set(Bun, "Terminal", undefined);
  try {
    const boot = suite.boot({ config });
    await expect(boot).rejects.toBeInstanceOf(AlarmRuntimeError);
    await expect(boot).rejects.toMatchObject({ requiredVersion: ">=1.4.0" });
  } finally {
    Reflect.set(Bun, "Terminal", terminal);
  }
});
