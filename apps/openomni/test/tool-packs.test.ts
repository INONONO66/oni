import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as childProcess from "node:child_process";
import { expect, spyOn, test } from "bun:test";
import { Bundle } from "@openomni/agent";
import { z } from "zod";
import { loadToolPacks } from "../src/bundles/tool-packs/index";
import { appManifest } from "../src/manifest";
import { alarmDefinition } from "./helpers/alarm-definition";
import { loadConfig } from "../src/config";

const fixture = join(import.meta.dir, "fixtures/tool-packs");
const file = join(fixture, "echo/manifest.json");
const ids = new Set(["self"]);
const absent = () => undefined;
const FixtureManifest = z.object({
  name: z.string(),
  tools: z.array(z.object({
    name: z.string(),
    description: z.string(),
    command: z.string(),
    machine: z.string(),
    inputSchema: z.object({
      type: z.string(),
      properties: z.record(z.string(), z.object({ type: z.string() })),
      required: z.array(z.string()),
      additionalProperties: z.boolean(),
    }),
  })),
});

function temporaryPack(change: (manifest: z.infer<typeof FixtureManifest>) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "tool-pack-"));
  const pack = join(dir, "echo");
  mkdirSync(pack);
  const manifest = FixtureManifest.parse(JSON.parse(readFileSync(file, "utf8")));
  change(manifest);
  writeFileSync(join(pack, "manifest.json"), JSON.stringify(manifest));
  return dir;
}

test("a pack command reaches the attached machine with each argument shell-quoted and never spawns locally", async () => {
  const calls: { command: string; cwd: string }[] = [];
  const spawn = spyOn(Bun, "spawn");
  const nodeSpawn = spyOn(childProcess, "spawn");
  try {
    const packs = loadToolPacks(fixture, ids, () => ({
      machines: {
        defaultMachine: "self",
        get: (id) => {
          expect(id).toBe("self");
          return {
            exec: async (command, cwd) => {
              calls.push({ command, cwd });
              return {
                status: "completed" as const,
                stdout: Buffer.from("remote"),
                stderr: new Uint8Array(),
                exitCode: 0,
                signal: null,
                truncated: false,
              };
            },
          };
        },
      },
      cells: undefined,
      llm: undefined,
    }));
    const tool = packs[0]?.tools[0];
    if (tool === undefined) throw new Error("missing fixture tool");
    const input = { text: "hello'; touch /tmp/should-not-exist; echo '" };
    const output = await tool.execute(input, {
      sessionId: "s", turnId: "t", callId: "c", signal: new AbortController().signal,
    });
    expect(output).toMatchObject({ stdout: "remote", exitCode: 0 });
    expect(calls).toEqual([{
      command: "printf '%s' 'hello'\\''; touch /tmp/should-not-exist; echo '\\'''",
      cwd: "/",
    }]);
    expect(spawn).not.toHaveBeenCalled();
    expect(nodeSpawn).not.toHaveBeenCalled();
  } finally {
    spawn.mockRestore();
    nodeSpawn.mockRestore();
  }
});

test("unset pack directory loads no packs", () => {
  expect(loadToolPacks(undefined, ids, absent)).toEqual([]);
});

test.each([
  ["empty command", (pack: z.infer<typeof FixtureManifest>) => { pack.tools[0]!.command = ""; }, "invalid_tool_pack"],
  ["unsupported schema", (pack: z.infer<typeof FixtureManifest>) => { pack.tools[0]!.inputSchema.properties.text!.type = "bogus"; }, "invalid_tool_pack"],
  ["unbound placeholder", (pack: z.infer<typeof FixtureManifest>) => { pack.tools[0]!.command = "echo {{missing}}"; }, "invalid_tool_pack"],
  ["unknown machine", (pack: z.infer<typeof FixtureManifest>) => { pack.tools[0]!.machine = "unattached"; }, "unknown_machine"],
  ["duplicate tool", (pack: z.infer<typeof FixtureManifest>) => { pack.tools.push(pack.tools[0]!); }, "tool_name_collision"],
])("refuses %s at load time with a typed code", (_name, change, code) => {
  const dir = temporaryPack(change);
  try {
    expect(() => loadToolPacks(dir, ids, absent)).toThrow(expect.objectContaining({ code }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a built-in tool name collision refuses composition before boot", async () => {
  const dir = temporaryPack((pack) => { pack.tools[0].name = "bash"; });
  try {
    const toolPacks = loadToolPacks(dir, ids, absent);
    expect(() => appManifest({
      alarm: await alarmDefinition(),
      wake: { close: () => undefined },
      alarms: () => undefined,
      tools: () => undefined,
      toolPacks,
    })).toThrow(expect.objectContaining({ code: "tool_name_collision" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("disabling a pack bundle removes its tool from the composed generation", async () => {
  const toolPacks = loadToolPacks(fixture, ids, absent);
  const input = {
    alarm: await alarmDefinition(),
    wake: { close: () => undefined },
    alarms: () => undefined,
    tools: () => undefined,
    toolPacks,
  };
  const enabled = Bundle.composeSync(appManifest(input));
  const disabled = Bundle.composeSync(appManifest({ ...input, off: ["echo-pack"] }));
  expect(enabled.tools.map((tool) => tool.name)).toContain("machine_echo");
  expect(disabled.tools.map((tool) => tool.name)).not.toContain("machine_echo");
});

test("loadConfig accepts an optional tool-pack directory", () => {
  const env = {
    OPENOMNI_MODEL_PROVIDER: "openai",
    OPENOMNI_MODEL_ID: "model",
    OPENOMNI_MODEL_API_KEY: "key",
    OPENOMNI_TOOL_PACKS_DIR: fixture,
  };
  expect(loadConfig(tmpdir(), env).toolPacksDir).toBe(fixture);
});
