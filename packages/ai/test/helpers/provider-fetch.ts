import type { z } from "zod";

type FetchArgs = Parameters<typeof fetch>;

export function mockFetch(
  handler: (...args: FetchArgs) => Response | Promise<Response>,
): typeof fetch {
  return Object.assign(async (...args: FetchArgs) => handler(...args), {
    preconnect: globalThis.fetch.preconnect,
  });
}

export async function captureRequest(
  action: () => PromiseLike<object>,
  response: Parameters<typeof jsonResponse>[0],
) {
  const original = globalThis.fetch;
  let captured: { url: string; headers: Headers } | undefined;
  globalThis.fetch = mockFetch((input, init) => {
    captured = { url: String(input), headers: new Headers(init?.headers) };
    return jsonResponse(response);
  });
  try {
    await action();
    if (captured === undefined) throw new Error("SDK did not issue a request");
    return captured;
  } finally {
    globalThis.fetch = original;
  }
}

export function openAIResponse(model: string) {
  return {
    id: "resp-1",
    model,
    output: [
      {
        type: "message",
        role: "assistant",
        id: "msg-1",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

export const anthropicResponse = {
  id: "msg-1",
  type: "message",
  role: "assistant",
  model: "claude-3-haiku",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
};

export function jsonResponse(body: z.infer<ReturnType<typeof z.json>>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
