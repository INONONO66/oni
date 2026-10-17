import { describe, expect, test } from "bun:test";
import { ChildLifecycleEvidence, TranscriptRef } from "@openomni/protocol";
import { z } from "zod";
import { packs, selectPack } from "./index.js";
import { DialectDecodeError, Manifest, matchScreen } from "./pack.js";

const Case = z.strictObject({
  line: z.string(),
  phase: ChildLifecycleEvidence.shape.phase,
});
const Fixtures = z.strictObject({
  live: z.array(Case).optional(),
  transcript: z.array(Case).optional(),
  unsupported: z.strictObject({
    live: z.array(z.string()).optional(),
    transcript: z.array(z.string()).optional(),
  }),
  toolUseId: z.string().min(1).optional(),
});
const Screens = z.strictObject({
  permission_prompt: z.string(),
  working: z.string(),
  idle_prompt: z.string(),
});
const ref = TranscriptRef.parse({
  machine: "machine-redacted",
  export: "transcript",
  path: "/redacted/session.jsonl",
  generation: { kind: "inode", device: "1", inode: "2" },
  range: { offsetBytes: 0, lengthBytes: 80 },
  parser: { dialect: "fixture", version: "1" },
});
const identity = { child: "child-redacted", turn: "turn-redacted" };
const fixtureFor = async (id: string): Promise<z.infer<typeof Fixtures>> =>
  Fixtures.parse(await Bun.file(`${import.meta.dir}/${id}/test/fixtures.json`).json());

test("registers at least one dialect", () => {
  expect(packs.length).toBeGreaterThan(0);
});

for (const pack of packs) {
  describe(pack.manifest.id, () => {
    test("selects by command and supported version", () => {
      expect(Manifest.parse(pack.manifest)).toEqual(pack.manifest);
      expect(selectPack({ command: `/usr/bin/${pack.manifest.commands[0]}` })).toBe(pack);
      expect(selectPack({ command: "/usr/bin/unregistered-agent" })).toBeUndefined();
      expect(
        selectPack({ command: pack.manifest.commands[0] ?? "", version: "0.0" }),
      ).toBeUndefined();
    });

    test("exposes only declared capabilities and refuses malformed or unsupported input", async () => {
      const fixtures = await fixtureFor(pack.manifest.id);
      const live = pack.live;
      const transcript = pack.transcript;
      expect(live !== undefined).toBe(pack.manifest.capabilities.live !== "none");
      expect(transcript !== undefined).toBe(pack.manifest.capabilities.transcript !== "none");
      expect(pack.launch !== undefined).toBe(pack.manifest.capabilities.correlated_launch);
      if (live !== undefined) {
        expect(fixtures.live?.length).toBeGreaterThan(0);
        expect(fixtures.unsupported.live?.length).toBeGreaterThan(0);
        expect(() => live("{", { ...identity, lastSeq: 0 })).toThrow(
          new DialectDecodeError("live", "malformed"),
        );
        expect(() => live("{}", { ...identity, lastSeq: 0 })).toThrow(
          new DialectDecodeError("live", "malformed"),
        );
        for (const line of fixtures.unsupported.live ?? [])
          expect(() => live(line, { ...identity, lastSeq: 0 })).toThrow(
            new DialectDecodeError("live", "unsupported"),
          );
      } else {
        expect(fixtures.live).toBeUndefined();
        expect(fixtures.unsupported.live).toBeUndefined();
      }
      if (transcript !== undefined) {
        expect(fixtures.transcript?.length).toBeGreaterThan(0);
        expect(fixtures.unsupported.transcript?.length).toBeGreaterThan(0);
        expect(() => transcript("{", { ...identity, ref })).toThrow(
          new DialectDecodeError("transcript", "malformed"),
        );
        expect(() => transcript("{}", { ...identity, ref })).toThrow(
          new DialectDecodeError("transcript", "malformed"),
        );
        for (const line of fixtures.unsupported.transcript ?? [])
          expect(() => transcript(line, { ...identity, ref })).toThrow(
            new DialectDecodeError("transcript", "unsupported"),
          );
      } else {
        expect(fixtures.transcript).toBeUndefined();
        expect(fixtures.unsupported.transcript).toBeUndefined();
      }
    });

    test("covers required phases in each supported observation source", async () => {
      const fixtures = await fixtureFor(pack.manifest.id);
      if (pack.live !== undefined) {
        const phases = new Set<ChildLifecycleEvidence["phase"]>();
        let lastSeq = 0;
        for (const fixture of fixtures.live ?? []) {
          const result = pack.live(fixture.line, { ...identity, lastSeq });
          expect(result.phase).toBe(fixture.phase);
          ChildLifecycleEvidence.parse(result);
          if (!("kind" in result.ref)) throw new Error("expected hook reference");
          const seq = result.ref.seq;
          expect(seq).toBeGreaterThan(lastSeq);
          // The pack owns the sequence gate; its refusal names the refused sequence for the consumer.
          let refusal: DialectDecodeError | undefined;
          try {
            pack.live(fixture.line, { ...identity, lastSeq: seq });
          } catch (error) {
            if (!(error instanceof DialectDecodeError)) throw error;
            refusal = error;
          }
          expect(refusal?.code).toBe("stale_seq");
          expect(refusal?.detail).toEqual({ seq });
          lastSeq = seq;
          phases.add(result.phase);
        }
        const permissionPhases: readonly ChildLifecycleEvidence["phase"][] = ["waiting", "decided"];
        const required: readonly ChildLifecycleEvidence["phase"][] = [
          "observed",
          "requested",
          "result",
          "terminal",
          ...(pack.manifest.capabilities.permission_decision ? permissionPhases : []),
        ];
        for (const phase of required) expect(phases.has(phase)).toBe(true);
      }
      if (pack.transcript !== undefined) {
        const phases = new Set<ChildLifecycleEvidence["phase"]>();
        for (const fixture of fixtures.transcript ?? []) {
          const result = pack.transcript(fixture.line, { ...identity, ref });
          expect(result.phase).toBe(fixture.phase);
          ChildLifecycleEvidence.parse(result);
          if (result.phase === "decided") expect(result.toolUseId).toBeDefined();
          phases.add(result.phase);
        }
        for (const phase of ["observed", "requested", "result", "terminal"] as const)
          expect(phases.has(phase)).toBe(true);
        if (pack.manifest.capabilities.permission_decision)
          expect(phases.has("decided")).toBe(true);
      }
    });

    test("joins tool calls on the fixture-declared identity when both sources exist", async () => {
      if (pack.live === undefined || pack.transcript === undefined) return;
      const fixtures = await fixtureFor(pack.manifest.id);
      const live = fixtures.live?.find((fixture) => fixture.phase === "requested");
      const transcript = fixtures.transcript?.find((fixture) => fixture.phase === "requested");
      if (live === undefined || transcript === undefined || fixtures.toolUseId === undefined)
        throw new Error("missing correlated tool-call fixture");
      const fromLive = pack.live(live.line, { ...identity, lastSeq: 0 });
      const fromTranscript = pack.transcript(transcript.line, { ...identity, ref });
      const key = (evidence: ChildLifecycleEvidence) => ({
        child: evidence.child,
        turn: evidence.turn,
        toolUseId: evidence.toolUseId,
        phase: evidence.phase,
      });
      expect(key(fromLive)).toEqual(key(fromTranscript));
      expect(fromLive.toolUseId).toBeDefined();
      expect(fromLive.toolUseId).toBe(fixtures.toolUseId);
    });

    test("matches anchored bottom rows in only their captured screen state", async () => {
      const screens = Screens.parse(
        await Bun.file(`${import.meta.dir}/${pack.manifest.id}/test/screen-fixtures.json`).json(),
      );
      for (const state of ["permission_prompt", "working", "idle_prompt"] as const) {
        expect(matchScreen(pack.manifest, screens[state])).toBe(state);
        for (const pattern of pack.manifest.screen[state]) {
          const regex = new RegExp(pattern);
          const rows = screens[state]
            .split("\n")
            .map((row) => row.trim())
            .slice(-20);
          expect(rows.some((row) => regex.test(row))).toBe(true);
          for (const other of ["permission_prompt", "working", "idle_prompt"] as const) {
            if (other === state) continue;
            expect(screens[other].split("\n").some((row) => regex.test(row.trim()))).toBe(false);
          }
        }
      }
      expect(
        matchScreen(pack.manifest, `${screens.idle_prompt}\n${screens.working}\n${screens.permission_prompt}`),
      ).toBe("permission_prompt");
      expect(matchScreen(pack.manifest, `${screens.idle_prompt}\n${screens.working}`)).toBe(
        "working",
      );
      expect(matchScreen(pack.manifest, "unrecognized pane")).toBeUndefined();
    });

    test("#1512: locates the transcript from its own live line and wires the observed events into its live config", async () => {
      const fixtures = await fixtureFor(pack.manifest.id);
      const live = pack.live;
      // A pack with both sources must say where the transcript is; a live-only or transcript-only pack has nothing to join.
      expect(pack.locate !== undefined).toBe(live !== undefined && pack.transcript !== undefined);
      expect(pack.liveConfig !== undefined).toBe(pack.manifest.capabilities.live === "hooks");
      const lines = fixtures.live ?? [];
      // The spool envelope is app-owned: `event` names the vendor event the hook command received.
      const Envelope = z.object({ event: z.string().min(1) });
      const eventOf = (line: string) => Envelope.parse(JSON.parse(line)).event;
      if (pack.locate !== undefined) {
        expect(pack.locate("{")).toEqual({});
        expect(pack.locate("{}")).toEqual({});
        const located = lines.flatMap((fixture) => {
          const path = pack.locate?.(fixture.line).transcriptPath;
          return path === undefined ? [] : [{ event: eventOf(fixture.line), path }];
        });
        expect(located.length).toBeGreaterThan(0);
        for (const entry of located) expect(entry.path.length).toBeGreaterThan(0);
        if (pack.liveConfig !== undefined) {
          const content = pack.liveConfig({ hookCommand: "/machine/hook" });
          for (const entry of located) expect(content).toContain(`/machine/hook ${entry.event}`);
        }
      }
      if (pack.liveConfig !== undefined && live !== undefined) {
        const content = pack.liveConfig({ hookCommand: "/machine/hook" });
        expect(() => JSON.parse(content)).not.toThrow();
        expect(content).toContain("/machine/hook");
        // Every tool row and the turn end must reach the spool: their events are wired.
        for (const fixture of lines) {
          if (fixture.phase !== "requested" && fixture.phase !== "result" && fixture.phase !== "terminal") continue;
          expect(content).toContain(`/machine/hook ${eventOf(fixture.line)}`);
        }
      }
    });

    test("provides a guarded submit recipe and optional correlated launch", () => {
      if (pack.launch !== undefined) {
        const launch = pack.launch({
          sessionId: "session-redacted",
          liveConfigPath: "/machine/hooks.json",
        });
        expect(launch.argv).toContain("session-redacted");
        expect(pack.launch({ sessionId: "session-redacted" }).argv).toContain("session-redacted");
      }
      const recipe = pack.submit("redacted prompt");
      expect(recipe.writes).toEqual([
        { kind: "text", value: "redacted prompt" },
        { kind: "enter" },
      ]);
      expect(recipe.enterDelayMs).toBeGreaterThan(0);
      expect(recipe.stallWindowMs).toBeGreaterThan(0);
      expect(recipe.refuseWhenWaiting).toBe(true);
    });
  });
}
