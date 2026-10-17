import { expect, test } from "bun:test";
import { canonicalJson } from "@openomni/protocol";
import { decodeSpool } from "../src/bundles/child-activity/spool";
import { decodeTranscript, splitLines, transcriptCursor } from "../src/bundles/child-activity/transcript";
import { conflictRow, currentState, diagnosticRow, receivedChildRows, reconcile, stateReceipts, type ChildRow } from "../src/bundles/child-activity/reconcile";
import { DialectDecodeError } from "../src/bundles/child-activity/dialects/pack";
import { fixture, fixtures, identity, pack, reference } from "./helpers/child-activity";

function observed(source: "live" | "transcript", phase: Parameters<typeof fixture>[1] = "requested") {
  const text = `${fixture(source, phase)}\n`;
  const input = { ...identity, pack, ref: reference(text), chunk: Buffer.from(text) };
  return source === "live"
    ? decodeSpool(input).observations
    : decodeTranscript({ ...input, observedAt: 200 }).observations;
}

test("source arrival order admits byte-identical facts and one receipt per source", () => {
  const hook = observed("live");
  const transcript = observed("transcript");
  const fromHook = reconcile(hook, []);
  const fromTranscript = reconcile(transcript, []);
  const first = [...fromHook, ...reconcile(transcript, fromHook)];
  const second = [...fromTranscript, ...reconcile(hook, fromTranscript)];
  const facts = (rows: readonly ChildRow[]) => rows.filter((row) => row.kind === "child_fact").map(canonicalJson);
  const receipts = (rows: readonly ChildRow[]) => rows.filter((row) => row.kind === "child_receipt").map(canonicalJson).sort();
  expect(facts(first)).toEqual(facts(second));
  expect(facts(first)).toHaveLength(1);
  expect(receipts(first)).toEqual(receipts(second));
  expect(receipts(first)).toHaveLength(2);
});

test("the read model accepts only typed child intake rows", () => {
  const rows = reconcile(observed("live"), []);
  const received = rows.map((row) => ({
    kind: "action" as const,
    intent: { encodingVersion: 1 as const, value: { kind: "child_activity" } },
    effect: { encodingVersion: 1 as const, value: { content: canonicalJson(row) } },
  }));
  expect(receivedChildRows([
    ...received,
    { kind: "action", intent: { encodingVersion: 1, value: { kind: "another_source" } }, effect: { encodingVersion: 1, value: null } },
    { kind: "action", intent: { encodingVersion: 1, value: { kind: "child_activity" } }, effect: { encodingVersion: 1, value: { content: "not-json" } } },
  ])).toEqual(rows);
});

test("redelivery and later reads add no facts or receipts", () => {
  const observations = [...observed("transcript"), ...observed("live")];
  const rows = reconcile(observations, []);
  expect(rows[1]?.kind).toBe("child_receipt");
  expect(reconcile(observations.map((entry) => ({ ...entry, observedAt: 900 })), rows)).toEqual([]);
});

test("the same receipt key with different content emits one conflict, never replacement", () => {
  const original = observed("live");
  const rows = reconcile(original, []);
  const changed = original.map((entry) => ({
    ...entry, evidence: { ...entry.evidence, diagnostics: [{ code: "changed", detail: "different retained bytes" }] },
  }));
  const conflicts = reconcile(changed, rows);
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0]).toMatchObject({ kind: "child_conflict", content: { code: "idempotency_conflict", key: rows[1]?.key } });
  expect(reconcile(changed, [...rows, ...conflicts])).toEqual([]);
  const fact = rows[0];
  if (fact === undefined) throw new Error("missing fact");
  expect(reconcile(original, [{ ...fact, content: { ...identity, phase: "result" }, kind: "child_fact" }])[0]).toEqual(conflictRow(fact));
});

test("a replaced generation drops the partial tail and restarts at byte zero", () => {
  const before = `${fixture("transcript", "requested")}\npartial`;
  const initial = decodeTranscript({ ...identity, pack, ref: reference(before), chunk: Buffer.from(before), observedAt: 200 });
  const after = `${fixture("transcript", "terminal")}\n`;
  const replaced = decodeTranscript({
    ...identity, pack, ref: reference(after), chunk: Buffer.from(after), observedAt: 201, cursor: initial.cursor,
  });
  expect(replaced.diagnostics[0]?.diagnostic.code).toBe("generation_changed");
  expect(replaced.observations[0]?.evidence).toMatchObject({ phase: "terminal", ref: { range: { offsetBytes: 0 } } });
  expect(replaced.cursor.tail.length).toBe(0);
  expect(replaced.cursor.checkpoint.offsetBytes).toBe(Buffer.byteLength(after));
  expect(transcriptCursor(replaced.cursor, replaced.cursor.checkpoint.generation).cursor).toBe(replaced.cursor);
  const diagnostic = replaced.diagnostics[0];
  if (diagnostic === undefined) throw new Error("missing diagnostic");
  expect(diagnosticRow(identity, diagnostic).kind).toBe("child_diagnostic");
});

test("spool sequence starts below zero and refuses regression across generations", () => {
  const text = `${fixtures.live.map((entry) => entry.line).join("\n")}\n`;
  const first = decodeSpool({ ...identity, pack, ref: reference(text), chunk: Buffer.from(text) });
  expect(first.observations).toHaveLength(fixtures.live.length);
  const repeated = `${fixture("live", "requested")}\n`;
  const refused = decodeSpool({
    ...identity, pack, ref: reference(repeated), chunk: Buffer.from(repeated), cursor: first.cursor,
  });
  expect(refused.observations).toEqual([]);
  expect(refused.diagnostics.map((entry) => entry.diagnostic.code)).toEqual(["generation_changed", "stale_seq"]);
  expect(refused.cursor.lastSeq).toBe(first.cursor.lastSeq);
  const zero = `${fixture("live", "observed").replace('"seq":1', '"seq":0')}\n`;
  expect(decodeSpool({ ...identity, pack, ref: reference(zero), chunk: Buffer.from(zero) }).cursor.lastSeq).toBe(0);
});

test("a refused spool replay diagnoses changed bytes without admitting another fact", () => {
  const text = `${fixture("live", "requested")}\n`;
  const input = { ...identity, pack, ref: reference(text), chunk: Buffer.from(text) };
  const original = decodeSpool(input);
  const rows = reconcile(original.observations, []);
  const repeated = decodeSpool({ ...input, cursor: original.cursor });
  expect(reconcile(repeated.observations, rows, repeated.replays)).toEqual([]);
  const changed = decodeSpool({ ...input, chunk: Buffer.from(` ${text}`), cursor: original.cursor });
  const conflicts = reconcile(changed.observations, rows, changed.replays);
  expect(changed.observations).toEqual([]);
  expect(conflicts).toMatchObject([{ kind: "child_conflict", content: { code: "idempotency_conflict", key: rows[1]?.key } }]);
  expect(reconcile(changed.observations, [...rows, ...conflicts], changed.replays)).toEqual([]);
  expect(reconcile([], [], changed.replays)).toEqual([]);
  const batch = decodeSpool({ ...input, chunk: Buffer.from(`${text} ${text}`) });
  expect(reconcile(batch.observations, [], batch.replays).map((row) => row.kind)).toEqual([
    "child_fact", "child_receipt", "child_conflict",
  ]);
});

test("a replayed sequence matches the child's earlier receipt on another turn", () => {
  const text = `${fixture("live", "requested")}\n`;
  const input = { ...identity, pack, ref: reference(text), chunk: Buffer.from(text) };
  const original = decodeSpool(input);
  const rows = reconcile(original.observations, []);
  const changed = decodeSpool({ ...input, turn: "another-turn", chunk: Buffer.from(` ${text}`), cursor: original.cursor });
  expect(changed.replays).toEqual([{ child: identity.child, seq: original.cursor.lastSeq, digest: changed.replays[0]?.digest ?? "" }]);
  expect(changed.replays[0]?.digest).not.toBe(rows[1]?.kind === "child_receipt" ? rows[1].content.diagnostics[0]?.detail : undefined);
  const conflicts = reconcile(changed.observations, rows, changed.replays);
  expect(conflicts).toMatchObject([{ kind: "child_conflict", content: { code: "idempotency_conflict", key: rows[1]?.key } }]);
  expect(stateReceipts(rows, identity.child, "another-turn")).toEqual([]);
});

test("current state chooses hook authority over a later disagreeing transcript", () => {
  const rows = reconcile([...observed("transcript", "terminal"), ...observed("live", "waiting")], []);
  const receipts = stateReceipts(rows, identity.child, identity.turn);
  expect(currentState(receipts)?.fact.phase).toBe("waiting");
  expect(currentState([...receipts].reverse())?.fact.phase).toBe("waiting");
  expect(currentState([])).toBeUndefined();
  const hook = receipts.find((entry) => entry.source === "hook");
  const transcript = receipts.find((entry) => entry.source === "transcript");
  if (hook === undefined || transcript === undefined || !("kind" in hook.receipt.ref)) throw new Error("missing receipts");
  const newer = { ...hook, receipt: { ...hook.receipt, ref: { ...hook.receipt.ref, seq: hook.receipt.ref.seq + 1 } } };
  expect(currentState([newer, hook])).toBe(newer);
  expect(currentState([hook, newer])).toBe(newer);
  const screen = { ...transcript, source: "screen" as const };
  expect(currentState([screen, transcript])).toBe(transcript);
  expect(currentState([transcript, { ...transcript, receipt: { ...transcript.receipt, observedAt: 400 } }])?.receipt.observedAt).toBe(400);
  expect(stateReceipts(rows, "different-child", identity.turn)).toEqual([]);
});

test("JSONL splits retain byte tails, including split multibyte characters", () => {
  const text = `${fixture("transcript", "terminal")}\n`;
  const bytes = Buffer.from(text);
  const first = decodeTranscript({ ...identity, pack, ref: reference(text), chunk: bytes.subarray(0, 9), observedAt: 1 });
  const second = decodeTranscript({ ...identity, pack, ref: reference(text), chunk: bytes.subarray(9), cursor: first.cursor, observedAt: 1 });
  expect(first.observations).toEqual([]);
  expect(second.observations[0]?.evidence.phase).toBe("terminal");
  const unicode = Buffer.from("\u00e9\r\n");
  const partial = splitLines({ chunk: unicode.subarray(0, 1), tail: new Uint8Array(), offsetBytes: 0 });
  const whole = splitLines({ chunk: unicode.subarray(1), tail: partial.tail, offsetBytes: partial.offsetBytes });
  expect(whole.lines).toMatchObject([{ text: "\u00e9", range: { offsetBytes: 0, lengthBytes: 4 } }]);
  const other = splitLines({ chunk: Buffer.from("\u00e9\n"), tail: new Uint8Array(), offsetBytes: 0 });
  expect(whole.lines[0]?.text).toBe(other.lines[0]?.text);
  expect(whole.lines[0]?.digest).not.toBe(other.lines[0]?.digest);
});

test("backfill current state uses byte order when one read observes several phases", () => {
  const text = `${fixture("transcript", "requested")}\n${fixture("transcript", "terminal")}\n`;
  const observations = decodeTranscript({ ...identity, pack, ref: reference(text), chunk: Buffer.from(text), observedAt: 10 }).observations;
  const receipts = stateReceipts(reconcile(observations, []), identity.child, identity.turn);
  expect(currentState(receipts)?.fact.phase).toBe("terminal");
  expect(currentState([...receipts].reverse())?.fact.phase).toBe("terminal");
  // A later observation of a replaced file wins on time, not on input order.
  const replacement = `${fixture("transcript", "result")}\n`;
  const replaced = decodeTranscript({ ...identity, pack, ref: reference(replacement), chunk: Buffer.from(replacement), observedAt: 11 }).observations;
  const rows = reconcile(observations, []);
  expect(currentState(stateReceipts([...rows, ...reconcile(replaced, rows)], identity.child, identity.turn))?.fact.phase).toBe("result");
});

test("current state across generations at one observation time is total and input-order independent", () => {
  const decode = (text: string) => stateReceipts(
    reconcile(decodeTranscript({ ...identity, pack, ref: reference(text), chunk: Buffer.from(text), observedAt: 10 }).observations, []),
    identity.child, identity.turn,
  );
  const [smaller] = decode(`${fixture("transcript", "result")}\n`);
  const [larger] = decode(`${fixture("transcript", "requested")}\n${fixture("transcript", "terminal")}\n`);
  if (smaller === undefined || larger === undefined || "kind" in smaller.receipt.ref || "kind" in larger.receipt.ref)
    throw new Error("missing receipts");
  const sizes = [smaller, larger].map((entry) =>
    "kind" in entry.receipt.ref || entry.receipt.ref.generation.kind !== "size-and-prefix-hash" ? -1 : entry.receipt.ref.generation.size);
  expect(sizes[0]).toBeGreaterThan(0);
  expect(sizes[1]).toBeGreaterThan(sizes[0] ?? Number.POSITIVE_INFINITY);
  expect(currentState([smaller, larger])).toBe(larger);
  expect(currentState([larger, smaller])).toBe(larger);
  // Equal sizes with different prefixes order on the canonical generation text.
  const ref = smaller.receipt.ref;
  const generation = ref.generation.kind === "size-and-prefix-hash" ? ref.generation : undefined;
  if (generation === undefined) throw new Error("size generation expected");
  const rehashed = { ...smaller, receipt: { ...smaller.receipt, ref: { ...ref, generation: { ...generation, prefixSha256: "0".repeat(64) } } } };
  const forward = currentState([smaller, rehashed]);
  expect(currentState([rehashed, smaller])).toBe(forward);
  expect(forward).toBe(canonicalJson(generation) > canonicalJson(rehashed.receipt.ref.generation) ? smaller : rehashed);
  // A generation without a size ranks below any sized generation.
  const inode = { ...smaller, receipt: { ...smaller.receipt, ref: { ...ref, generation: { kind: "inode" as const, device: "dev", inode: "1" } } } };
  expect(currentState([smaller, inode])).toBe(smaller);
  expect(currentState([inode, smaller])).toBe(smaller);
});

test("source decoders report malformed records and refuse missing pack capabilities", () => {
  const text = "{}\n{\n";
  const input = { ...identity, pack, ref: reference(text), chunk: Buffer.from(text) };
  expect(decodeSpool(input).diagnostics.map((entry) => entry.diagnostic.code)).toEqual(["malformed", "malformed"]);
  expect(decodeTranscript({ ...input, observedAt: 1 }).diagnostics).toHaveLength(2);
  const { live: _live, transcript: _transcript, ...empty } = pack;
  expect(() => decodeSpool({ ...input, pack: empty })).toThrow(new DialectDecodeError("live", "unsupported"));
  expect(() => decodeTranscript({ ...input, pack: empty, observedAt: 1 })).toThrow(new DialectDecodeError("transcript", "unsupported"));
  const broken = { ...pack, live: () => { throw new TypeError("decoder defect"); }, transcript: () => { throw new TypeError("decoder defect"); } };
  const valid = `${fixture("live", "requested")}\n`;
  expect(() => decodeSpool({ ...input, pack: broken, chunk: Buffer.from(valid) })).toThrow(TypeError);
  expect(() => decodeTranscript({ ...input, pack: broken, observedAt: 1 })).toThrow(TypeError);
  // A live decoder must answer with a hook reference; the spool adapter takes its time and sequence from it.
  const crossed = {
    ...pack,
    live: (line: string, context: { child: string; turn: string }) => {
      if (pack.transcript === undefined) throw new Error("transcript decoder missing");
      return pack.transcript(line, { ...context, ref: input.ref });
    },
  };
  const record = `${fixture("transcript", "requested")}\n`;
  expect(() => decodeSpool({ ...input, pack: crossed, chunk: Buffer.from(record) })).toThrow(TypeError);
  // A stale refusal without the refused sequence is a diagnostic only, never a replay to match.
  const terse = { ...pack, live: () => { throw new DialectDecodeError("live", "stale_seq"); } };
  const unmatched = decodeSpool({ ...input, pack: terse, chunk: Buffer.from(valid) });
  expect(unmatched.replays).toEqual([]);
  expect(unmatched.diagnostics.map((entry) => entry.diagnostic.code)).toEqual(["stale_seq"]);
});
