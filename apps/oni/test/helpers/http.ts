import { expect } from "bun:test";

export async function expectAbsentWebhook(port: number): Promise<void> {
  const webhook = await fetch(`http://127.0.0.1:${port}/github/webhook`, { method: "POST" });
  expect(webhook.status).toBe(404);
  expect(await webhook.text()).toBe("Not found");
}
