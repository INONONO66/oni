import { describe, expect, it } from "bun:test";
import { Operational } from "@openomni/protocol";
import { z } from "zod";
import { injectedOptions } from "./helpers/injected";
import { GitHubAdapter } from "../src/provider/github/surface";
import { signedWebhook } from "./helpers/github";

const secret = "github-webhook-secret";
const deliveryId = "delivery-retry-1";
const body = JSON.stringify({
  action: "created",
  issue: {
    number: 7,
    title: "Run work",
    labels: [],
    user: { login: "octocat", type: "User" },
  },
  comment: {
    id: 1,
    body: "run",
    user: { login: "octocat", type: "User" },
  },
  repository: {
    full_name: "openomni/project",
    owner: { login: "openomni" },
    name: "project",
  },
});

const config = {};

describe("GitHubAdapter retryable delivery failures", () => {
  it("returns 5xx when the message handler throws", async () => {
    const adapter = new GitHubAdapter(secret, config, () => undefined, injectedOptions());
    let attempts = 0;
    adapter.onMessage(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("handler unavailable");
    });

    const response = await adapter.handleWebhook(await webhookRequest(deliveryId));

    expect(response.status).toBe(500);
    const retried = await adapter.handleWebhook(await webhookRequest(deliveryId));
    expect(retried.status).toBe(200);
    expect(attempts).toBe(2);
  });

  it("a perimeter refusal is this surface's verdict: 200 with the claim kept, so GitHub never redelivers it (#1600 lane R2)", async () => {
    const warns: string[] = [];
    const adapter = new GitHubAdapter(
      secret,
      config,
      (event, data) => {
        if (event.name === Operational.Events.Warn.name) warns.push(z.object({ msg: z.string() }).parse(data).msg);
      },
      injectedOptions(),
    );
    let attempts = 0;
    adapter.onMessage(async () => {
      attempts += 1;
      throw Object.assign(new Error("message admission refused: message.external.grant_tier"), { name: "MessageAdmissionRefused" });
    });

    const refused = await adapter.handleWebhook(await webhookRequest("delivery-refused-1"));
    expect(refused.status).toBe(200);
    expect(await refused.text()).toBe("Not ingested");
    const redelivered = await adapter.handleWebhook(await webhookRequest("delivery-refused-1"));
    expect(await redelivered.text()).toBe("Already processed");
    expect(attempts).toBe(1);
    expect(warns).toEqual(["github event not ingested"]);
  });
});

function webhookRequest(id: string): Request {
  return signedWebhook(body, secret, id);
}
