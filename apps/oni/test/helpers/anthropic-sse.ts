export function messageStart(id: string, model: string, inputTokens: number) {
  return {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  };
}

export function messageEnd(stopReason: string, outputTokens: number) {
  return [
    {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens },
    },
    { type: "message_stop" },
  ];
}

export function contentBlocks(
  blocks: readonly {
    readonly start: object;
    readonly delta: object;
  }[],
) {
  return blocks.flatMap((block, index) => [
    { type: "content_block_start", index, content_block: block.start },
    { type: "content_block_delta", index, delta: block.delta },
    { type: "content_block_stop", index },
  ]);
}

export function sseResponse(frames: readonly { readonly type: string }[]): Response {
  return new Response(
    frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
