import { describe, expect, it } from "bun:test";
import { FIXED_NOW, testRun } from "./helpers/injected";
import { z } from "zod";
import { GitHubClient } from "../src/provider/github/client";
import { fetchWithRetry } from "../src/support/fetch-retry";

describe("GitHubClient", () => {
  it("reconciles encoded delivery markers across comment pages without prefix collisions", async () => {
    const realFetch = globalThis.fetch;
    const pages: number[] = [];
    const posted: string[] = [];
    const firstPage = Array.from<undefined, { body: string }>({ length: 100 }, (_, index) => ({
      body: `other-${index}`,
    }));
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "GET") {
          const page = Number(new URL(String(input)).searchParams.get("page"));
          pages.push(page);
          if (page === 1) return Response.json(firstPage);
          if (page === 2) return Response.json(posted.map((body) => ({ body })));
          throw new Error("unexpected comment page");
        }
        const data = z.object({ body: z.string() }).parse(JSON.parse(String(init?.body)));
        posted.push(data.body);
        return Response.json({ id: posted.length });
      },
      { preconnect: realFetch.preconnect },
    );
    try {
      const client = new GitHubClient(() => undefined, () => FIXED_NOW, testRun, "token");
      expect(await client.postComment("owner/repo", 1, "answer", "trace", "id:long")).toEqual({
        value: "sent",
        externalMessageId: "1",
      });
      expect(await client.postComment("owner/repo", 1, "answer", "trace", "id:long")).toEqual({
        value: "sent",
      });
      expect(await client.postComment("owner/repo", 1, "answer", "trace", "id")).toEqual({
        value: "sent",
        externalMessageId: "2",
      });
      expect(posted).toEqual([
        "answer\n\n<!-- oni-delivery:id%3Along -->",
        "answer\n\n<!-- oni-delivery:id -->",
      ]);
      expect(pages).toEqual([1, 2, 1, 2, 1, 2]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("records a warn instead of silently skipping a reply without a token (#606)", async () => {
    const schema = z.object({
      traceId: z.string(),
      context: z.object({ repo: z.string(), issueNumber: z.number() }),
    });
    const published: Array<{ name: string; data: z.infer<typeof schema> }> = [];
    const client = new GitHubClient((descriptor, data) => {
      published.push({ name: descriptor.name, data: schema.parse(data) });
    }, () => FIXED_NOW, testRun);

    await client.postComment("oni/project", 7, "the answer", "trace-github-test", "delivery");

    expect(published).toEqual([
      {
        name: "operational.warn",
        data: {
          traceId: "trace-github-test",
          context: { repo: "oni/project", issueNumber: 7 },
        },
      },
    ]);
  });

  it("wraps a failed comment listing in a typed delivery error", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit) =>
        init?.method === "GET" ? new Response("boom", { status: 500 }) : Response.json({ id: 1 }),
      { preconnect: realFetch.preconnect },
    );
    try {
      const client = new GitHubClient(() => undefined, () => FIXED_NOW, testRun, "token");
      await expect(client.postComment("owner/repo", 1, "answer", "trace", "id")).rejects.toMatchObject({
        _tag: "DeliveryNotSent",
        operation: "github.listComments",
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("wraps an invalid comment listing in a typed delivery error", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit) =>
        init?.method === "GET" ? Response.json({ nope: true }) : Response.json({ id: 1 }),
      { preconnect: realFetch.preconnect },
    );
    try {
      const client = new GitHubClient(() => undefined, () => FIXED_NOW, testRun, "token");
      await expect(client.postComment("owner/repo", 1, "answer", "trace", "id")).rejects.toMatchObject({
        _tag: "DeliveryNotSent",
        operation: "github.listComments",
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("exhausts rate-limit retries with one trace and a typed failure", async () => {
    const realFetch = globalThis.fetch;
    const warningSchema = z.object({
      traceId: z.string(),
      context: z.object({
        label: z.string(),
        retryAfter: z.number(),
        attempt: z.number(),
        max: z.number(),
      }),
    });
    const warnings: z.infer<typeof warningSchema>[] = [];
    let attempts = 0;
    globalThis.fetch = Object.assign(
      async () => {
        attempts += 1;
        return Response.json({ retryAfter: 0 }, { status: 429 });
      },
      { preconnect: realFetch.preconnect },
    );

    try {
      await expect(
        fetchWithRetry(
          "https://api.github.test/comments",
          { method: "POST" },
          {
            traceId: "trace-rate-limit",
            run: testRun,
            label: "github/postComment",
            retryAfterSchema: z
              .object({ retryAfter: z.number() })
              .transform((body) => body.retryAfter),
            publish: (_event, data) => warnings.push(warningSchema.parse(data)),
          },
        ),
      ).rejects.toThrow("github/postComment: rate limited after 3 retries");

      expect(attempts).toBe(4);
      expect(warnings.map((warning) => warning.traceId)).toEqual([
        "trace-rate-limit",
        "trace-rate-limit",
        "trace-rate-limit",
      ]);
      expect(warnings.map((warning) => warning.context)).toEqual([
        { label: "github/postComment", retryAfter: 0, attempt: 1, max: 3 },
        { label: "github/postComment", retryAfter: 0, attempt: 2, max: 3 },
        { label: "github/postComment", retryAfter: 0, attempt: 3, max: 3 },
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
