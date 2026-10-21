import type { PendingApproval, TranscriptNode, TurnCost } from "@oni/ui";
import { getToolName, isToolUIPart } from "ai";
import { z } from "zod";
import { costOf, costsByTurn } from "./turn-cost";
import type { OniUIMessage } from "./message";

type TranscriptTool = Extract<TranscriptNode, { kind: "tool" }>;
type TranscriptMarkdown = Extract<TranscriptNode, { kind: "assistant" }>["blocks"][number];

/** `done` is the transcript's implicit default; only the loud states print. */
type LoudStatus = Exclude<TranscriptTool["status"], undefined>;

interface Transcript {
  readonly nodes: readonly TranscriptNode[];
  /** Per-turn cost, keyed the way `Timeline` reads it: 1-based turn index. */
  readonly costs: Readonly<Record<number, TurnCost>>;
  readonly pending: readonly PendingApproval[];
}

export function uiMessagesToTranscript(messages: readonly OniUIMessage[]): Transcript {
  const nodes: TranscriptNode[] = [];
  const pending: PendingApproval[] = [];
  /** Which node ids each turn's cost should attach to, once turns are known. */
  const costAnchors: { readonly nodeId: string; readonly cost: TurnCost }[] = [];

  for (const message of messages) {
    const before = nodes.length;

    if (message.role === "user") {
      const text = textOf(message);
      if (text !== "") nodes.push({ kind: "prompt", id: message.id, text });
      continue;
    }
    if (message.role !== "assistant") continue;

    appendAssistant(message, nodes, pending);

    const cost = costOf(message.metadata);
    const anchor = nodes[before];
    if (cost !== undefined && anchor !== undefined) {
      costAnchors.push({ nodeId: anchor.id, cost });
    }
  }

  return { nodes, costs: costsByTurn(nodes, costAnchors), pending };
}

function appendAssistant(
  message: OniUIMessage,
  nodes: TranscriptNode[],
  pending: PendingApproval[],
): void {
  let blocks: TranscriptMarkdown[] = [];
  let blocksAt = 0;
  let streaming = false;

  const flush = () => {
    if (blocks.length === 0) return;
    nodes.push({ kind: "assistant", id: `${message.id}.${blocksAt}`, blocks, streaming });
    blocks = [];
    streaming = false;
  };

  for (const [at, part] of message.parts.entries()) {
    if (part.type === "text") {
      // Adjacent text parts are one answer with several paragraphs, not several
      // answers: the SDK splits on stream boundaries, which are not sentences.
      if (blocks.length === 0) blocksAt = at;
      blocks.push({ kind: "p", text: part.text });
      // The tail of a streaming answer is the one place a caret may blink.
      streaming = part.state === "streaming";
      continue;
    }

    if (isToolUIPart(part)) {
      flush();
      const { node, approval } = toolNode(part);
      nodes.push(node);
      if (approval !== undefined) pending.push(approval);
    }

    // step-start, reasoning, sources, files: real parts of the message with no
    // row in this transcript. Dropped silently, on purpose.
  }

  flush();
}

/** A tool part, as one ledger row plus — if it is blocked — one decision. */
function toolNode(part: ToolPart): {
  readonly node: TranscriptTool;
  readonly approval?: PendingApproval;
} {
  const tool = getToolName(part);
  const target = targetOf(targetSchema.parse(part.input));
  const status =
    part.state === "approval-responded" && !part.approval.approved ? "denied" : STATUS[part.state];

  const id = part.state === "approval-requested" ? part.approval.id : part.toolCallId;

  const node: TranscriptTool = {
    kind: "tool",
    id,
    tool,
    target,
    ...(status === undefined ? {} : { status }),
    ...(part.state === "output-error" ? { payload: [part.errorText] } : {}),
  };

  if (part.state !== "approval-requested") return { node };

  return {
    node,
    approval: {
      toolId: part.approval.id,
      // The product's sentence, composed here because `@oni/ui` prints
      // what it is handed and never writes a sentence about a tool.
      summary: target === "" ? `${tool} wants to run` : `${tool} wants to run ${target}`,
      reason: part.approval.requestReason ?? "requires approval",
    },
  };
}

type ToolPart = Extract<OniUIMessage["parts"][number], { toolCallId: string }>;

const STATUS: Readonly<Record<ToolPart["state"], LoudStatus | undefined>> = {
  "input-streaming": "running",
  "input-available": "running",
  "approval-requested": "waiting",
  "approval-responded": "running",
  "output-error": "failed",
  "output-denied": "denied",
  "output-available": undefined,
};

const targetSchema = z.union([
  z.string(),
  z.object({
    command: z.string().optional().catch(undefined),
    path: z.string().optional().catch(undefined),
    pattern: z.string().optional().catch(undefined),
    query: z.string().optional().catch(undefined),
    target: z.string().optional().catch(undefined),
  }),
]).catch("");

function targetOf(input: z.infer<typeof targetSchema>): string {
  if (typeof input === "string") return input;
  return input.command ?? input.path ?? input.pattern ?? input.query ?? input.target ?? "";
}

/** A user message's text: its text parts, joined. Files and the rest are not prose. */
function textOf(message: OniUIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

