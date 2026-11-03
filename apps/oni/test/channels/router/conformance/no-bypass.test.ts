import { runEffect } from "../../../../../../packages/channels/test/helpers/effect.js";
import { beforeEach, expect, test } from "bun:test";
import { registerRule } from "../../helpers/rule.js";
import {
  commits,
  kernelRouter,
  ownerFacts,
  ownerSender,
  resetRouterState,
} from "../_router-fixture.js";

beforeEach(resetRouterState);

test("unauthorized external sender cannot reach delivery commit", async () => {
  registerRule({ when: { instance: ownerFacts.surface, from: ["allowed-sender"] } });
  expect(await runEffect(kernelRouter().ingest(ownerSender, ownerFacts))).toMatchObject({
    status: "blocked_pre",
  });
  expect(commits).toEqual([]);
});
