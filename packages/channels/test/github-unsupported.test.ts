import { expect, test } from "bun:test";
import { injectedOptions } from "./helpers/injected";
import { Operational } from "@oni/protocol";
import { GitHubAdapter } from "../src/provider/github/surface";
import { signedWebhook } from "./helpers/github";

function observedGitHub() {
  const observations: object[] = [];
  const adapter = new GitHubAdapter(
    "secret",
    {},
    (descriptor, payload) => {
      if (descriptor.name === Operational.Events.Warn.name) {
        const warning = Operational.Events.Warn.schema.parse(payload);
        if (warning.context) observations.push(warning.context);
      }
    },
    injectedOptions(),
  );
  return { adapter, observations };
}

for (const [event, action, reason] of [
  ["pull_request", "opened", "invalid_payload"],
  ["pull_request_review", "submitted", "unsupported_event"],
  ["issues", "closed", "unsupported_action"],
  ["issue_comment", "edited", "unsupported_action"],
  ["issues", "opened", "invalid_payload"],
  ["ping", undefined, "unsupported_event"],
] as const) {
  test(`GitHub ${event}.${action} malformed or unsupported payload is observed without ingress`, async () => {
    const { adapter, observations } = observedGitHub();
    let ingested = 0;
    adapter.onMessage(async () => {
      ingested++;
    });
    const payload = JSON.stringify({ action });
    const response = await adapter.handleWebhook(
      signedWebhook(payload, "secret", "delivery", event),
    );
    const observation = { kind: "unsupported_event", event, action: action ?? null, reason };
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(observation);
    expect(observations).toEqual([{ ...observation, deliveryId: "delivery" }]);
    expect(ingested).toBe(0);
    await adapter.handleWebhook(signedWebhook(payload, "secret", "delivery", event));
    expect(observations).toHaveLength(1);
  });
}

test("GitHub non-object JSON is also observed rather than silently dropped", async () => {
  const { adapter, observations } = observedGitHub();
  const response = await adapter.handleWebhook(signedWebhook("[]", "secret", "delivery", "issues"));
  expect(await response.json()).toEqual({
    kind: "unsupported_event",
    event: "issues",
    action: null,
    reason: "invalid_payload",
  });
  expect(observations).toHaveLength(1);
});
