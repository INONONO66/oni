import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UI_NAMES } from "../src/names";
import type { TranscriptNode } from "../src/timeline/model";
import { Timeline } from "../src/timeline/timeline";
import { segmentTurns } from "../src/timeline/turns";

const attachment = {
  kind: "attachment", id: "file", name: "report.pdf",
  mediaType: "application/pdf", ref: "machine:/reports/report.pdf",
} as const;

test("user text and attachments stay in one prompt in arrival order", () => {
  const nodes: readonly TranscriptNode[] = [
    { kind: "prompt", id: "before", promptId: "prompt", text: "Read this." },
    { ...attachment, promptId: "prompt" },
    { kind: "prompt", id: "after", promptId: "prompt", text: "Then summarize." },
    { ...attachment, id: "answer" },
    { ...attachment, id: "next", promptId: "next" },
  ];

  const turns = segmentTurns(nodes);
  const html = renderToStaticMarkup(<Timeline nodes={nodes} sessionId="attachments" />);

  expect(turns.map((turn) => turn.parts.map((part) => part.kind))).toEqual([["user", "attachment"], ["user"]]);
  expect(html.match(/data-user-message/g)).toHaveLength(2);
  expect(html.indexOf("Read this.")).toBeLessThan(html.indexOf(`data-ui="${UI_NAMES.AttachmentRow}"`));
  expect(html.indexOf("report.pdf")).toBeLessThan(html.indexOf("Then summarize."));
  expect(html.match(new RegExp(`data-ui="${UI_NAMES.AttachmentRow}"`, "g"))).toHaveLength(3);
  expect(html).toContain('title="machine:/reports/report.pdf"');
  expect(html).toContain("application/pdf");
  expect(html).not.toMatch(/<(img|audio|video|a)\b/);
});

test("attachments split tool groups and count as an answer for turn cost", () => {
  const nodes: readonly TranscriptNode[] = [
    { kind: "tool", id: "read", tool: "read", target: "one" },
    attachment,
    { kind: "tool", id: "write", tool: "write", target: "two" },
  ];

  const turns = segmentTurns(nodes);
  const html = renderToStaticMarkup(<Timeline nodes={[attachment]} costs={{ 1: { at: "12:00", elapsed: "1s" } }} sessionId="answer" />);
  const prompt = renderToStaticMarkup(<Timeline nodes={[{ ...attachment, promptId: "user" }]} costs={{ 1: { at: "12:00", elapsed: "1s" } }} sessionId="prompt" />);

  expect(turns[0]?.parts.map((part) => part.kind)).toEqual(["tools", "attachment", "tools"]);
  expect(html).toContain("data-turn-time");
  expect(prompt).not.toContain("data-turn-time");
});
