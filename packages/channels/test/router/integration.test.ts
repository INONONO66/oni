import { ledger } from "../helpers/ledger";
import { effectFailure } from "../helpers/effect-failure";
import { beforeEach, describe, expect, test } from "bun:test";
import { runEffect } from "../helpers/effect";
import { registerRule } from "../helpers/rule";

import {
  commits,
  kernelRouter,
  ownerFacts,
  ownerMessageTargets,
  ownerSender,
  resetRouterState,
} from "./_router-fixture";

beforeEach(() => {
  resetRouterState();
  registerRule();
});

describe("GatewayRouter conversation isolation", () => {
  test("same physical surface routes later messages to the same session", async () => {
    const [first, second] = await ownerMessageTargets();
    expect(first).toBe(second);
    expect(commits).toHaveLength(2);
  });
  test("different instances isolate identical peer conversations", async () => {
    registerRule({ id: "other", position: 1, when: { instance: "other" } });
    const [first, second] = await ownerMessageTargets({ ...ownerFacts, instance: "other", eventId: "second" });
    expect(first).not.toBe(second);
  });
  test("allowlist refuses strangers while admitting the authenticated listed sender", async () => {
    registerRule({ when: { instance: "discord", from: [ownerSender.externalId] } });
    expect(
      await runEffect(kernelRouter().ingest({ ...ownerSender, externalId: "stranger" }, ownerFacts)),
    ).toMatchObject({ status: "blocked_pre" });
    expect(
      (await runEffect(kernelRouter().ingest(ownerSender, { ...ownerFacts, eventId: "allowed" }))).status,
    ).toBe("executed");
    expect(commits).toHaveLength(1);
  });
  test("invalid facts fail schema validation before routing", async () => {
    expect(await effectFailure(kernelRouter().ingest(ownerSender, { ...ownerFacts, eventId: "" }))).toMatchObject({
      issues: [expect.objectContaining({ code: "too_small", path: ["eventId"] })],
    });
    expect(commits).toEqual([]);
  });
});
