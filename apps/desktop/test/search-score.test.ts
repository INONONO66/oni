import { describe, expect, test } from "bun:test";
import { scoreFields, scoreText } from "../src/renderer/search";

/**
 * The scorer is pure and total, so it is asserted directly rather than through
 * a rendered tree. Its job is narrow: decide whether a query matches a string,
 * report WHICH glyphs matched, and rank matches so a tie inside one attention
 * class breaks the same way every time.
 *
 * What it must NOT do is reorder across classes — that is asserted in
 * search-filter.test.ts, where the sequence actually exists.
 */
describe("subsequence matching", () => {
  test("Given a contiguous run, When scored, Then it matches and reports its own glyphs", () => {
    const match = scoreText("ledger append path", "led");

    expect(match).not.toBeNull();
    expect(match?.spans).toEqual([0, 1, 2]);
  });

  test("Given scattered glyphs in order, When scored, Then the subsequence still matches", () => {
    // The operator is recalling the shape of a name, not its spelling.
    // l@0 g@3 p@8 — `g` and `p` are interior, so this is the scattered tier.
    expect(scoreText("ledger append path", "lgp")?.spans).toEqual([0, 3, 8]);
  });

  test("Given glyphs out of order, When scored, Then there is no match", () => {
    expect(scoreText("ledger append path", "pal")).toBeNull();
  });

  test("Given a glyph absent from the text, When scored, Then there is no match", () => {
    expect(scoreText("ledger append path", "ledx")).toBeNull();
  });

  test("Given mixed case on either side, When scored, Then matching ignores it", () => {
    expect(scoreText("Ledger Append Path", "LEDGER")).not.toBeNull();
    expect(scoreText("LEDGER", "ledger")).not.toBeNull();
  });

  test("Given an empty query, When scored, Then it matches with no glyphs weighted", () => {
    // "Matched with nothing to highlight" and "did not match" are different
    // facts; collapsing them would make an empty field hide every row.
    expect(scoreText("anything", "")).toEqual({ score: 0, spans: [] });
  });

  test("Given a repeated glyph, When no word-aligned run exists, Then the leftmost is reported", () => {
    // "append path": `p@7` starts `path`, but the following `a@8` is interior,
    // so there is no FULLY word-aligned run and the leftmost walk is the
    // answer — p@1 a@8. The match the reader sees first is the one they meant.
    expect(scoreText("append path", "pa")?.spans).toEqual([1, 8]);
    expect(scoreText("append", "pp")?.spans).toEqual([1, 2]);
  });

  test("Given a fully word-aligned run exists, When scored, Then it beats the leftmost one", () => {
    // `ap` could take a@0 p@1 inside `append`; the word starts a@7 p@14 are the
    // better evidence, so the aligned walk takes precedence over leftmost.
    expect(scoreText("ledger append path", "ap")?.spans).toEqual([7, 14]);
  });
});

describe("the tier ordering: prefix > word-start > subsequence", () => {
  const score = (text: string, query: string) => scoreText(text, query)?.score ?? -1;

  test("Given a prefix and a word-start match, When compared, Then the prefix wins", () => {
    expect(score("ledger append", "led")).toBeGreaterThan(score("append ledger", "led"));
  });

  test("Given a word-start and a mid-word match, When compared, Then the word start wins", () => {
    // `lap` hits three word starts in `ledger append path`; in `flagpole` every
    // hit is interior, which is much weaker evidence of what the operator
    // meant. This is also the case a purely leftmost walk gets wrong: it lands
    // the `p` inside `append` and downgrades the match to scattered.
    expect(scoreText("ledger append path", "lap")?.spans).toEqual([0, 7, 14]);
    expect(score("ledger append path", "lap")).toBeGreaterThan(score("flagpole", "lap"));
  });

  test("Given two subsequence matches, When compared, Then the tighter one wins", () => {
    // Both are interior-only, so both sit in the scattered tier and density
    // decides: `rap` contiguous inside `wrap` beats `rap` spread over `xraxpx`.
    expect(score("wrap", "rap")).toBeGreaterThan(score("xraxapx", "rap"));
  });

  test("Given the same tier, When compared, Then an earlier match wins the tie", () => {
    expect(score("rap sheet", "rap")).toBeGreaterThan(score("the rap", "rap"));
  });

  test("Given a tier gap, When compared, Then no tightness bonus can cross it", () => {
    // The tiers are ordinal, not additive: a perfectly tight subsequence must
    // still lose to any word-start match, or the ranking stops being readable.
    const tightSubsequence = score("xxrap", "rap");
    const looseWordStart = score("r-something a-something p-something", "rap");

    expect(looseWordStart).toBeGreaterThan(tightSubsequence);
  });

  test("Given identical inputs, When scored twice, Then the score is identical", () => {
    expect(score("ledger append path", "lap")).toBe(score("ledger append path", "lap"));
  });
});

describe("separators define a word start", () => {
  test("Given each separator this data uses, When a query hits after it, Then it is a word start", () => {
    // Session and project names use all of these, so a hyphen has to split
    // `atlas-migration` the way it reads.
    for (const [text, query] of [
      ["atlas-migration", "am"],
      ["snake_case", "sc"],
      ["fs.read", "fr"],
      ["src/renderer", "sr"],
      ["state:running", "sr"],
      ["ledger append", "la"],
    ] as const) {
      const wordStart = scoreText(text, query)?.score ?? -1;
      const interior = scoreText(`x${text}`, query)?.score ?? -1;

      expect(wordStart).toBeGreaterThan(interior);
    }
  });
});

describe("scoring across a row's fields", () => {
  // Session name, project name, reason — in recall-likelihood order.
  const fields = ["ledger append path", "oni-kernel", "running"] as const;

  test("Given a hit on the session name, When scored, Then field 0 is reported", () => {
    expect(scoreFields(fields, "ledger")?.field).toBe(0);
  });

  test("Given a hit only on the project, When scored, Then the row still matches", () => {
    // A project name is on screen as the row's own header, so matching it is
    // matching something the operator can see.
    expect(scoreFields(fields, "kernel")?.field).toBe(1);
  });

  test("Given a hit only on the reason, When scored, Then the row still matches", () => {
    expect(scoreFields(fields, "running")?.field).toBe(2);
  });

  test("Given a hit on no field, When scored, Then the row does not match", () => {
    expect(scoreFields(fields, "zzz")).toBeNull();
  });

  test("Given a query the session name spells better, When scored, Then the name wins", () => {
    // `ker` prefixes nothing in the name but hits `oni-kernel` at a word
    // start, so the project must win here — and the reverse case must not.
    expect(scoreFields(fields, "ker")?.field).toBe(1);
    expect(scoreFields(["kernel work", "oni-kernel", "running"], "ker")?.field).toBe(0);
  });

  test("Given an empty field list, When scored, Then nothing matches", () => {
    expect(scoreFields([], "x")).toBeNull();
  });
});
