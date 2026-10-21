import { describe, expect, it } from "bun:test";
import { Outbound } from "@oni/protocol";
import { GitHubProvider } from "../src/provider/github/provider";
import { injectedOptions } from "./helpers/injected";

/**
 * #1600 lane R2: the inbound conversation is the issue (`owner/repo#N`),
 * the one address a comment can land on, so the reply door's answer is a
 * comment there; a cold send keeps the direct `owner/repo#N` address.
 */
describe("GitHub reply door", () => {
  it("a conversation names the issue the comment lands on; a cold send keeps the direct address", async () => {
    const realFetch = globalThis.fetch;
    const posted: string[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (init?.method === "POST") {
          posted.push(url.pathname);
          return Response.json({ id: posted.length });
        }
        return Response.json([]);
      },
      { preconnect: realFetch.preconnect },
    );
    try {
      const route = GitHubProvider.create({ secret: "s", token: "t" }, {}, () => undefined, injectedOptions()).deliveryRoute;
      if (route === undefined) throw new Error("github delivers");
      expect(await route("octocat", Outbound.payload("answer"), "key-1", { channelId: "owner/repo#7" })).toEqual({
        value: "accepted",
        externalMessageId: "1",
      });
      expect(await route("owner/repo#9", Outbound.payload("cold"), "key-2")).toEqual({
        value: "accepted",
        externalMessageId: "2",
      });
      expect(posted).toEqual(["/repos/owner/repo/issues/7/comments", "/repos/owner/repo/issues/9/comments"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
