import { describe, expect, test } from "bun:test";
import { ChildLifecycleEvidence, TranscriptRef } from "@openomni/protocol";
import { z } from "zod";
import { packs, selectPack } from "./index.js";
import { DialectDecodeError, Manifest } from "./pack.js";

const Fixtures = z.strictObject({
  live: z
    .array(z.strictObject({ line: z.string(), phase: ChildLifecycleEvidence.shape.phase }))
    .min(1),
  transcript: z
    .array(z.strictObject({ line: z.string(), phase: ChildLifecycleEvidence.shape.phase }))
    .min(1),
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

    test("rejects malformed observations with typed errors", () => {
      expect(() => pack.live("{", { ...identity, lastSeq: 0 })).toThrow(DialectDecodeError);
      expect(() => pack.live("{}", { ...identity, lastSeq: 0 })).toThrow(DialectDecodeError);
      expect(() => pack.transcript("{", { ...identity, ref })).toThrow(DialectDecodeError);
      expect(() => pack.transcript("{}", { ...identity, ref })).toThrow(DialectDecodeError);
    });

    test("covers phases and refuses repeated or descending spool sequences", async () => {
      const fixtures = Fixtures.parse(
        await Bun.file(`${import.meta.dir}/${pack.manifest.id}/test/fixtures.json`).json(),
      );
      let lastSeq = 0;
      for (const fixture of fixtures.live) {
        const result = pack.live(fixture.line, { ...identity, lastSeq });
        expect(result.phase).toBe(fixture.phase);
        ChildLifecycleEvidence.parse(result);
        if (!("kind" in result.ref)) throw new Error("expected hook reference");
        expect(result.ref.kind).toBe("hook");
        const seq = result.ref.seq;
        expect(seq).toBeGreaterThan(lastSeq);
        expect(() => pack.live(fixture.line, { ...identity, lastSeq: seq })).toThrow(
          new DialectDecodeError("live", "stale_seq"),
        );
        lastSeq = seq;
      }
      for (const fixture of fixtures.transcript) {
        const result = pack.transcript(fixture.line, { ...identity, ref });
        expect(result.phase).toBe(fixture.phase);
        ChildLifecycleEvidence.parse(result);
      }
    });

    test("joins live and transcript tool calls on canonical identity", async () => {
      const fixtures = Fixtures.parse(
        await Bun.file(`${import.meta.dir}/${pack.manifest.id}/test/fixtures.json`).json(),
      );
      const live = fixtures.live.find((fixture) => fixture.phase === "requested");
      const transcript = fixtures.transcript.find((fixture) => fixture.phase === "requested");
      if (live === undefined || transcript === undefined)
        throw new Error("missing tool-call fixture");
      const fromLive = pack.live(live.line, { ...identity, lastSeq: 0 });
      const fromTranscript = pack.transcript(transcript.line, { ...identity, ref });
      const key = (evidence: ChildLifecycleEvidence) => ({
        child: evidence.child,
        turn: evidence.turn,
        toolUseId: evidence.toolUseId,
        phase: evidence.phase,
      });
      expect(key(fromLive)).toEqual(key(fromTranscript));
      expect(fromLive.toolUseId).toBe("toolu_redacted_bash");
    });

    test("provides correlated launch and a guarded two-write submit recipe", () => {
      const launch = pack.launch("session-redacted", "/machine/hooks.json");
      expect(launch.argv).toContain("session-redacted");
      expect(launch.argv).toContain("/machine/hooks.json");
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
